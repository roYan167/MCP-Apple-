import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createAuthenticator } from '../dist/auth.js';

test('OAuth verifies signature, algorithm, issuer, resource audience, owner, expiry and scope', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const config = { mode: 'oauth', resource: 'https://apple.example/mcp', issuer: 'https://id.example', jwksUrl: 'https://id.example/jwks', subject: 'owner-id', scope: 'apple:mcp' };
  const auth = createAuthenticator(config, createLocalJWKSet({ keys: [await exportJWK(publicKey)] }));
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: config.issuer, aud: config.resource, sub: config.subject, scope: 'openid apple:mcp', iat: now, exp: now + 60 };
  const sign = (values, key = privateKey) => new SignJWT(values).setProtectedHeader({ alg: 'RS256' }).sign(key);
  assert.equal(await auth('Bearer ' + await sign(claims)), true);
  for (const change of [{ iss: 'https://attacker.example' }, { aud: 'another-api' }, { sub: 'other-user' }, { scope: 'apple:mcpx' }, { exp: now - 1 }, { nbf: now + 1000 }, { exp: undefined }, { iat: undefined }]) {
    assert.equal(await auth('Bearer ' + await sign({ ...claims, ...change })), false, JSON.stringify(change));
  }
  assert.equal(await auth('Bearer ' + await sign(claims, other.privateKey)), false);
  assert.equal(await auth('Bearer broken'), false);
  assert.equal(await auth(undefined), false);
});

test('bearer tokens are required and compared in constant time via fixed-length digests', async () => {
  const token = 'a'.repeat(43);
  const auth = createAuthenticator({ mode: 'bearer', token });
  assert.equal(await auth(`Bearer ${token}`), true);
  for (const value of [undefined, token, 'Bearer ', `Bearer ${token}x`, 'Basic abc']) assert.equal(await auth(value), false);
});
