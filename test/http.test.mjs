import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createHttpServer, readHttpConfig } from '../dist/http.js';
import { parseWriteTools, remoteRegistrar, READ_TOOLS, WRITE_TOOLS } from '../dist/policy.js';

const token = 'a'.repeat(43);
const config = { port: 8787, auth: { mode: 'bearer', token }, writes: new Set() };
async function start(t, overrides = {}, factory) {
  const service = createHttpServer({ ...config, ...overrides }, factory);
  service.http.listen(0, '127.0.0.1');
  await once(service.http, 'listening');
  t.after(() => service.close());
  const port = service.http.address().port;
  return { service, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}
// Override Host only because the OS chooses the test socket's port.
const headers = { Authorization: `Bearer ${token}` };
function rawFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
async function post(url, body, extra = {}) {
  return rawFetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('HTTP configuration fails closed', () => {
  for (const env of [{}, { MCP_HTTP_AUTH: 'none' }, { MCP_HTTP_AUTH: 'bearer', MCP_HTTP_TOKEN: '' }, { MCP_HTTP_AUTH: 'bearer', MCP_HTTP_TOKEN: token, MCP_HTTP_PORT: '0' }, { MCP_HTTP_AUTH: 'oauth' }]) {
    assert.throws(() => readHttpConfig(env));
  }
  assert.throws(() => createHttpServer({ ...config, auth: { mode: 'bearer', token: 'weak' } }));
  assert.throws(() => readHttpConfig({ MCP_HTTP_AUTH: 'bearer', MCP_HTTP_TOKEN: token, MCP_PUBLIC_URL: 'https://apple.example/mcp' }));
  assert.throws(() => parseWriteTools('mail_send_message,*'));
  assert.deepEqual([...parseWriteTools('notes_create_note, notes_create_note')], ['notes_create_note']);
});

test('HTTP enforces authentication, Host, Origin, method, path and bounded JSON', async t => {
  const { url } = await start(t);
  assert.equal((await post(url, {}, { Authorization: '' })).status, 401);
  assert.equal((await post(url, {}, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(url, {}, { Host: 'evil.example' })).status, 403);
  assert.equal((await post(url, {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(url, {}, { Origin: 'null' })).status, 403);
  assert.equal((await post(url, {}, { 'X-Forwarded-Host': '127.0.0.1:8787', Host: 'evil.example' })).status, 403);
  for (const method of ['GET', 'DELETE', 'OPTIONS']) {
    assert.equal((await rawFetch(url, { method, headers })).status, 405);
  }
  assert.equal((await post(new URL('/wrong', url), {})).status, 404);
  assert.equal((await post(url, '{')).status, 400);
  assert.equal((await post(url, [])).status, 400);
  assert.equal((await post(url, {}, { 'Content-Type': 'text/plain' })).status, 415);
  const oversized = await post(url, JSON.stringify({ data: 'x'.repeat(1024 * 1024) }));
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get('cache-control'), 'no-store');
});

test('SDK HTTP initialize/list/call; remote tools default read-only and hidden writes cannot be called', async t => {
  const { url } = await start(t);
  const client = new Client({ name: 'http-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(new Set(tools.map(t => t.name)), READ_TOOLS);
  for (const name of WRITE_TOOLS) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, true, name);
  }
});

test('HTTP opt-in writes require local approval and use the exact validated arguments', async t => {
  let approve = false, calls = 0;
  const seen = [];
  const factory = () => {
    const server = new McpServer({ name: 'policy-test', version: '1' });
    const registrar = remoteRegistrar(server, new Set(['notes_create_note']), async (name, params) => { seen.push({ name, params }); return approve; });
    registrar.registerTool('notes_create_note', { inputSchema: { body: z.string() }, annotations: { readOnlyHint: false } }, async params => {
      calls++;
      return { content: [{ type: 'text', text: params.body }] };
    });
    return server;
  };
  const { url } = await start(t, {}, factory);
  const client = new Client({ name: 'write-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  t.after(() => client.close());
  assert.equal((await client.callTool({ name: 'notes_create_note', arguments: { body: 'exact text' } })).isError, true);
  assert.equal(calls, 0);
  approve = true;
  assert.equal((await client.callTool({ name: 'notes_create_note', arguments: { body: 'exact text' } })).content[0].text, 'exact text');
  assert.equal(calls, 1);
  assert.deepEqual(seen[1], { name: 'notes_create_note', params: { body: 'exact text' } });
  assert.equal((await client.callTool({ name: 'notes_create_note', arguments: { body: 3 } })).isError, true);
  assert.equal(calls, 1);
});

test('OAuth discovery and challenge expose only configured metadata, never tokens', async t => {
  const auth = { mode: 'oauth', resource: 'https://apple.example/mcp', issuer: 'https://identity.example', jwksUrl: 'https://identity.example/jwks', subject: 'owner', scope: 'apple:mcp' };
  const { url } = await start(t, { auth, publicUrl: auth.resource });
  const response = await post(url, {}, { Authorization: '' });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /https:\/\/apple.example\/\.well-known\/oauth-protected-resource/);
  const metadata = await rawFetch(new URL('/.well-known/oauth-protected-resource', url), { headers: { Host: 'apple.example' } });
  assert.deepEqual(await metadata.json(), { resource: auth.resource, authorization_servers: [auth.issuer], scopes_supported: ['apple:mcp'] });
});

test('concurrent calls are rejected rather than stacking local approval prompts', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const factory = () => {
    const server = new McpServer({ name: 'busy-test', version: '1' });
    server.registerTool('wait', { inputSchema: {} }, async () => { entered(); await waiting; return { content: [] }; });
    return server;
  };
  const { url } = await start(t, {}, factory);
  const first = post(url, rpc(1, 'tools/call', { name: 'wait', arguments: {} }));
  await started;
  try { assert.equal((await post(url, rpc(2, 'tools/list', {}))).status, 429); }
  finally { release(); }
  assert.equal((await first).status, 200);
});

for (const protectedMode of [false, true]) test(`stdio ${protectedMode ? 'remote policy' : 'default'} has the expected tools without HTTP configuration`, async t => {
  if (process.platform !== 'darwin') return t.skip('CLI correctly requires macOS');
  const child = spawn(process.execPath, ['dist/index.js', ...(protectedMode ? ['--remote-policy'] : [])], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const waitFor = async id => {
    for (let i = 0; i < 100; i++) {
      const match = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(value => value.id === id);
      if (match) return match;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('stdio response timed out');
  };
  child.stdin.write(JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } })) + '\n');
  assert.ok((await waitFor(1)).result.serverInfo);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(JSON.stringify(rpc(2, 'tools/list', {})) + '\n');
  const names = new Set((await waitFor(2)).result.tools.map(tool => tool.name));
  assert.deepEqual(names, protectedMode ? READ_TOOLS : new Set([...READ_TOOLS, ...WRITE_TOOLS]));
});
