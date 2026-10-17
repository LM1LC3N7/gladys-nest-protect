// -----------------------------------------------------------------------------
// The real transport against a loopback server: answers, bounds, timeout,
// cancellation (the long poll cut by a stop or the test button).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { errorReason, httpRequest, parseRetryAfter, transientError, tryJson } from '../src/http.js';

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test('an answer of any status, with its headers and body', async (t) => {
  const base = await serve(t, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] });
      res.end(`${req.method} ${req.headers['x-nl-user-id']} ${body}`);
    });
  });
  const answer = await httpRequest(`${base}/v6/subscribe`, {
    method: 'POST',
    headers: { 'X-nl-user-id': '42' },
    body: '{"objects":[]}',
  });
  assert.equal(answer.status, 401);
  assert.equal(answer.headers['content-type'], 'text/plain');
  assert.deepEqual(answer.headers['set-cookie'], ['a=1', 'b=2']);
  assert.equal(answer.body, 'POST 42 {"objects":[]}');
});

test('a body larger than the bound is refused', async (t) => {
  const base = await serve(t, (req, res) => res.end('x'.repeat(5000)));
  await assert.rejects(httpRequest(base, { maxBytes: 1000 }), { kind: 'size' });
});

test('no answer within the timeout', async (t) => {
  const base = await serve(t, () => {});
  await assert.rejects(httpRequest(base, { timeout: 100 }), { kind: 'timeout' });
});

test('a long poll held open is cut by its signal', async (t) => {
  const base = await serve(t, () => {});
  const controller = new AbortController();
  const pending = httpRequest(base, { timeout: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { kind: 'aborted' });
  const cut = new AbortController();
  cut.abort();
  await assert.rejects(httpRequest(base, { signal: cut.signal }), { kind: 'aborted' });
});

test('a refused connection is a network error without the URL', async () => {
  const err = await httpRequest('http://127.0.0.1:1/o/oauth2/iframerpc?login_hint=secret').catch(
    (e) => e,
  );
  assert.equal(err.kind, 'network');
  assert.ok(!errorReason(err).includes('secret'));
});

test('helpers: Retry-After, JSON, transient statuses', () => {
  assert.equal(parseRetryAfter('120'), 120_000);
  assert.equal(
    parseRetryAfter('Thu, 01 Jan 2026 00:01:00 GMT', Date.parse('2026-01-01T00:00:00Z')),
    60_000,
  );
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(tryJson(''), undefined);
  assert.equal(tryJson('<html>'), undefined);
  assert.deepEqual(tryJson('{"a":1}'), { a: 1 });
  assert.equal(transientError({ status: 429, headers: { 'retry-after': '5' } }).retryAfter, 5000);
  assert.equal(transientError({ status: 503 }).kind, 'unavailable');
  assert.equal(transientError({ status: 200 }), undefined);
});
