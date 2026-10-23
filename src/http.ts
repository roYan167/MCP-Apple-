import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuthConfig, createAuthenticator, httpsUrl } from "./auth.js";
import { parseWriteTools } from "./policy.js";
import { createAppleServer } from "./server.js";

export interface HttpConfig {
  port: number;
  publicUrl?: string;
  auth: AuthConfig;
  writes: Set<string>;
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  if (!env[name]?.trim()) throw new Error(`Missing ${name}`);
  return env[name]!;
}
export function readHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const port = Number(env.MCP_HTTP_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP_HTTP_PORT");
  const publicUrl = env.MCP_PUBLIC_URL;
  if (publicUrl) {
    const url = httpsUrl(publicUrl, "MCP_PUBLIC_URL");
    if (url.pathname !== "/mcp") throw new Error("MCP_PUBLIC_URL must end with /mcp");
  }
  let auth: AuthConfig;
  if (env.MCP_HTTP_AUTH === "oauth") {
    auth = {
      mode: "oauth", resource: required(env, "MCP_PUBLIC_URL"),
      issuer: required(env, "MCP_OAUTH_ISSUER"), jwksUrl: required(env, "MCP_OAUTH_JWKS_URL"),
      subject: required(env, "MCP_OAUTH_SUBJECT"), scope: "apple:mcp"
    };
  } else if (env.MCP_HTTP_AUTH === "bearer") {
    if (publicUrl) throw new Error("Public HTTP endpoints require OAuth, not a static bearer token");
    auth = { mode: "bearer", token: required(env, "MCP_HTTP_TOKEN") };
  } else {
    throw new Error("Set MCP_HTTP_AUTH to bearer (local) or oauth (remote)");
  }
  return { port, publicUrl, auth, writes: parseWriteTools(env.MCP_HTTP_WRITE_TOOLS) };
}

export function createHttpServer(config: HttpConfig, factory: () => McpServer = () => createAppleServer({ writes: config.writes })) {
  const authenticate = createAuthenticator(config.auth);
  const publicOrigin = config.publicUrl ? new URL(config.publicUrl).origin : undefined;
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  if (publicOrigin) hosts.add(new URL(publicOrigin).host);
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  if (publicOrigin) origins.add(publicOrigin);
  const active = new Set<McpServer>();
  let busy = false;
  const reply = (res: ServerResponse, code: number, message: string) => {
    res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Do not trust X-Forwarded-*; tunnels must preserve one configured Host.
    const address = http.address();
    const localHosts = typeof address === "object" && address
      ? [`127.0.0.1:${address.port}`, `localhost:${address.port}`] : [];
    if (!req.headers.host || (!hosts.has(req.headers.host) && !localHosts.includes(req.headers.host))) return reply(res, 403, "Invalid Host");
    if (req.headers.origin !== undefined && !origins.has(req.headers.origin)) return reply(res, 403, "Invalid Origin");
    if (req.url === "/.well-known/oauth-protected-resource" && config.auth.mode === "oauth" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ resource: config.auth.resource, authorization_servers: [config.auth.issuer], scopes_supported: [config.auth.scope] }));
      return;
    }
    if (req.url !== "/mcp") return reply(res, 404, "Not found");
    if (!await authenticate(req.headers.authorization)) {
      res.setHeader("WWW-Authenticate", config.auth.mode === "oauth"
        ? `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource", scope="${config.auth.scope}"`
        : 'Bearer realm="apple-mcp"');
      return reply(res, 401, "Unauthorized");
    }
    // Stateless request/response MCP: no server-initiated SSE or resumable sessions.
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return reply(res, 405, "Method not allowed");
    }
    if (!req.headers["content-type"]?.split(";")[0]?.trim().match(/^application\/json$/i)) return reply(res, 415, "Expected application/json");
    // Only one request may automate apps or show a confirmation at a time.
    if (busy) { res.setHeader("Retry-After", "1"); return reply(res, 429, "Server busy"); }
    busy = true;
    let server: McpServer | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) return reply(res, 413, "Request too large");
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return reply(res, 400, "Invalid JSON"); }
      // Batches could create simultaneous prompts or hide multiple actions.
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(res, 400, "Expected one JSON-RPC object");
      server = factory();
      active.add(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      // Never log request bodies, tokens, or JXA/app errors containing private data.
      if (!res.headersSent) reply(res, 500, "Request failed");
      else if (!res.writableEnded) res.end();
    } finally {
      if (server) { await server.close(); active.delete(server); }
      busy = false;
    }
  };
  const http = createServer((req, res) => { void handler(req, res).catch(() => { if (!res.writableEnded) res.end(); }); });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  http.keepAliveTimeout = 5000;
  http.maxConnections = 32;
  return { http, async close() {
    for (const server of active) await server.close();
    await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeAllConnections(); });
  } };
}
