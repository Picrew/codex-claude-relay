import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.ts';

test('redacts OpenAI-style sk- keys', () => {
  const inp = 'export OPENAI_API_KEY="sk-proj-abcdef0123456789ABCDEFGHIJ"';
  const out = redact(inp);
  assert.ok(!out.includes('sk-proj-abcdef0123456789ABCDEFGHIJ'));
  assert.ok(out.includes('[REDACTED]') || out.includes('sk-[REDACTED]'));
});

test('redacts Anthropic sk-ant- keys', () => {
  const inp = 'auth: sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';
  const out = redact(inp);
  assert.ok(!out.includes('AAAABBBBCCCC'));
});

test('redacts Authorization headers', () => {
  const inp = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload-thing.signature-thing';
  const out = redact(inp);
  assert.ok(!out.includes('payload-thing'));
  assert.ok(out.includes('[REDACTED'));
});

test('redacts JWT-shaped tokens', () => {
  const inp = 'token=eyJabc123.eyJpYXQiOjE2MA.signature456789';
  const out = redact(inp);
  assert.ok(!out.includes('signature456789'));
});

test('redacts PEM private keys', () => {
  const inp = [
    'before',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEpAIBAAKCAQEAxxx',
    'MORE_KEY_MATERIAL',
    '-----END RSA PRIVATE KEY-----',
    'after',
  ].join('\n');
  const out = redact(inp);
  assert.ok(out.includes('[REDACTED-PRIVATE-KEY]'));
  assert.ok(!out.includes('MORE_KEY_MATERIAL'));
});

test('redacts KEY=VALUE secret env vars', () => {
  const inp = 'SOME_API_KEY=abcdefghijklmnopqrstuvwxyz123';
  const out = redact(inp);
  assert.ok(!out.includes('abcdefghijklmnopqrstuvwxyz123'));
});

test('leaves non-secret text intact', () => {
  const inp = 'Hello world, sk-foo (short) and normal sentence.';
  const out = redact(inp);
  assert.equal(out, inp);
});
