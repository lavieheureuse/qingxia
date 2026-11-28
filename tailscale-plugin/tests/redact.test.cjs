'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redactText, redactArgs, redactError } = require('../core/redact.cjs');

test('redactText masks tskey, --auth-key, Bearer tokens, private keys, and query secrets', () => {
  const raw = [
    'starting with tskey-auth-kAbCdEf123456-XYZ',
    'cmd: tailscale up --auth-key=tskey-auth-999999 --hostname=pc1',
    'cmd2: tailscale up --authkey secretTokenValue --accept-dns',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'privkey:0123456789abcdef0123456789abcdef',
    'url=https://example.com/cb?token=supersecret123&ok=1',
    'auth=https://login.tailscale.com/a/1a2b3c4d5e',
    'ip=100.88.12.34',
  ].join('\n');

  const cleaned = redactText(raw);
  assert.equal(cleaned.includes('kAbCdEf123456'), false);
  assert.equal(cleaned.includes('999999'), false);
  assert.equal(cleaned.includes('secretTokenValue'), false);
  assert.equal(cleaned.includes('eyJhbGciOi'), false);
  assert.equal(cleaned.includes('0123456789abcdef'), false);
  assert.equal(cleaned.includes('supersecret123'), false);

  assert.equal(cleaned.includes('https://login.tailscale.com/a/1a2b3c4d5e'), true);
  assert.equal(cleaned.includes('100.88.12.34'), true);
});

test('redactArgs masks inline and split --auth-key arguments', () => {
  const res = redactArgs(['up', '--auth-key=tskey-auth-secret', '--auth-key', 'tskey-2', '--hostname=home']);
  assert.deepEqual(res, ['up', '--auth-key=***', '--auth-key', '***', '--hostname=home']);
});

test('redactError sanitizes Error messages', () => {
  const err = new Error('failed with tskey-auth-abc123def');
  assert.equal(redactError(err), 'failed with tskey-***');
});
