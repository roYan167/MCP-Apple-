import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { remoteRegistrar, WRITE_TOOLS, confirmOnMac } from '../dist/policy.js';

test('every remote write, including send and delete, must pass local confirmation', async t => {
  const server = new McpServer({ name: 'all-write-policies', version: '1' });
  let calls = 0;
  const confirmations = [];
  const registrar = remoteRegistrar(server, WRITE_TOOLS, async (name, params) => { confirmations.push({ name, params }); return false; });
  for (const name of WRITE_TOOLS) registrar.registerTool(name, { inputSchema: { value: z.string() } }, async () => { calls++; return { content: [] }; });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'policy-test', version: '1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  for (const name of WRITE_TOOLS) assert.equal((await client.callTool({ name, arguments: { value: 'specific action' } })).isError, true);
  assert.equal(calls, 0);
  assert.deepEqual(new Set(confirmations.map(c => c.name)), WRITE_TOOLS);
  assert.ok(confirmations.every(c => c.params.value === 'specific action'));
});

test('remote stdio does not stack approvals, and recovers after denial', async t => {
  const server = new McpServer({ name: 'serial-policy', version: '1' });
  let release, entered, confirmations = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const registrar = remoteRegistrar(server, new Set(['mail_send_message']), async () => { confirmations++; entered(); await waiting; return false; });
  registrar.registerTool('mail_send_message', { inputSchema: {} }, async () => { throw new Error('Must never send'); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'serial-test', version: '1' });
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const first = client.callTool({ name: 'mail_send_message', arguments: {} });
  await started;
  try {
    const second = await client.callTool({ name: 'mail_send_message', arguments: {} });
    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /busy/);
    assert.equal(confirmations, 1);
  } finally { release(); }
  assert.equal((await first).isError, true);
  assert.equal((await client.callTool({ name: 'mail_send_message', arguments: {} })).isError, true);
  assert.equal(confirmations, 2);
});

test('oversized action details fail closed without opening a macOS dialog', async () => {
  assert.equal(await confirmOnMac('notes_update_note', { body: 'x'.repeat(4001) }), false);
});
