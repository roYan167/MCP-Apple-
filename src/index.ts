#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseWriteTools } from "./policy.js";
import { createAppleServer } from "./server.js";
import { createHttpServer, readHttpConfig } from "./http.js";

async function main(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Apple MCP requires macOS and AppleScript/JXA (osascript).");
  const args = process.argv.slice(2);
  const remotePolicy = args.includes("--remote-policy");
  const transports = args.filter(arg => arg.startsWith("--transport="));
  if (transports.length > 1 || args.some(arg => !["--transport=stdio", "--transport=http", "--remote-policy"].includes(arg)) || args.filter(arg => arg === "--remote-policy").length > 1) {
    throw new Error("Usage: apple-productivity-mcp-server [--transport=stdio|--transport=http] [--remote-policy]");
  }
  if (transports[0] === "--transport=http") {
    const config = readHttpConfig();
    const service = createHttpServer(config);
    service.http.listen(config.port, "127.0.0.1", () => console.error(`Apple MCP HTTP listening on 127.0.0.1:${config.port}/mcp`));
    service.http.on("error", () => { console.error("HTTP listener failed"); process.exitCode = 1; });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void service.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    const server = createAppleServer(remotePolicy ? { writes: parseWriteTools(process.env.MCP_HTTP_WRITE_TOOLS) } : undefined);
    await server.connect(new StdioServerTransport());
    console.error("apple-productivity-mcp-server running on stdio");
  }
}
main().catch(error => { console.error("Server error:", error.message); process.exit(1); });
