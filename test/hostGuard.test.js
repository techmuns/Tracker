import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrustedOrigin,
  isValidSessionPayload,
  resolveAllowedOrigins,
  DEFAULT_ALLOWED_HOST_ORIGINS,
} from '../src/hostGuard.js';

const ALLOWED = DEFAULT_ALLOWED_HOST_ORIGINS;

test('the shipped allow-list is never empty', () => {
  assert.ok(DEFAULT_ALLOWED_HOST_ORIGINS.length > 0);
  assert.ok(resolveAllowedOrigins(undefined).length > 0);
  assert.ok(resolveAllowedOrigins('').length > 0);
  assert.ok(resolveAllowedOrigins('   ,  ,').length > 0, 'whitespace-only must not yield an empty list');
});

test('resolveAllowedOrigins parses the env override', () => {
  assert.deepEqual(resolveAllowedOrigins('https://a.example'), ['https://a.example']);
  assert.deepEqual(
    resolveAllowedOrigins(' https://a.example , https://b.example '),
    ['https://a.example', 'https://b.example'],
  );
  assert.deepEqual(resolveAllowedOrigins(undefined), DEFAULT_ALLOWED_HOST_ORIGINS);
});

test('isTrustedOrigin matches exactly and fails closed', () => {
  assert.equal(isTrustedOrigin('https://chat.muns.io', ALLOWED), true);

  // Look-alike host — the classic suffix attack.
  assert.equal(isTrustedOrigin('https://chat.muns.io.evil.example', ALLOWED), false);
  // Scheme matters.
  assert.equal(isTrustedOrigin('http://chat.muns.io', ALLOWED), false);
  // No subdomain matching.
  assert.equal(isTrustedOrigin('https://sub.chat.muns.io', ALLOWED), false);
  // No trailing slash / path forms.
  assert.equal(isTrustedOrigin('https://chat.muns.io/', ALLOWED), false);
  assert.equal(isTrustedOrigin('chat.muns.io', ALLOWED), false);
  // An empty allow-list must trust nothing.
  assert.equal(isTrustedOrigin('https://chat.muns.io', []), false);
  // Missing / sandboxed-iframe origins.
  assert.equal(isTrustedOrigin('', ALLOWED), false);
  assert.equal(isTrustedOrigin('null', ALLOWED), false);
  assert.equal(isTrustedOrigin(undefined, ALLOWED), false);
});

test('isValidSessionPayload accepts real sessions', () => {
  assert.equal(isValidSessionPayload({ token: 'jwt', email: 'a@b.com' }), true);
  assert.equal(isValidSessionPayload({ token: null, email: null }), true);
  assert.equal(isValidSessionPayload({}), true, 'all-absent is a valid pre-init session');
  assert.equal(
    isValidSessionPayload({ token: 'j', userName: 'Rahul Sharma', email: 'r@acme.com', orgId: '1', orgName: 'Acme' }),
    true,
  );
});

test('isValidSessionPayload rejects malformed payloads', () => {
  assert.equal(isValidSessionPayload('nope'), false);
  assert.equal(isValidSessionPayload(null), false);
  assert.equal(isValidSessionPayload(['a@b.com']), false);
  assert.equal(isValidSessionPayload({ email: 'not-an-email' }), false);
  assert.equal(isValidSessionPayload({ email: 12345 }), false);
  assert.equal(isValidSessionPayload({ email: '' }), false);
  assert.equal(isValidSessionPayload({ email: 'a'.repeat(400) + '@x.com' }), false);
  // A non-string smuggled into a field the app puts in a header.
  assert.equal(isValidSessionPayload({ email: 'a@b.com', token: 12345 }), false);
  assert.equal(isValidSessionPayload({ token: { toString: () => 'x' } }), false);
});

test('guards are self-contained so they survive being injected into the page', () => {
  // index.js ships these to the browser via Function.prototype.toString(); a
  // reference to module scope would become a ReferenceError in the page.
  for (const fn of [isTrustedOrigin, isValidSessionPayload]) {
    const src = fn.toString();
    assert.ok(!/\bDEFAULT_ALLOWED_HOST_ORIGINS\b/.test(src), `${fn.name} must not close over module scope`);
    assert.ok(!/\brequire\(|\bimport\b/.test(src), `${fn.name} must not import`);
    // Re-create from source in a bare scope and confirm it still behaves.
    const rebuilt = new Function('return (' + src + ')')();
    assert.equal(typeof rebuilt, 'function');
  }
  const rebuiltOrigin = new Function('return (' + isTrustedOrigin.toString() + ')')();
  assert.equal(rebuiltOrigin('https://chat.muns.io', ALLOWED), true);
  assert.equal(rebuiltOrigin('https://evil.example', ALLOWED), false);
});
