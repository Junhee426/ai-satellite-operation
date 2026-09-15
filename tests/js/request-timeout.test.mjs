// Regression coverage for review item #2: the request() helper's 30s
// AbortController timeout must stay armed until the response body has
// actually finished being read/parsed (not just until headers arrive), and
// busy UI state (disabled buttons) must always be restored afterward -
// whether the request timed out, was aborted, or simply failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './harness.mjs';
import { ensureLiveServer } from './live_server.mjs';

const BUSY_IDS = ['advance', 'inject', 'demo', 'csv', 'save', 'load'];

function assertAllEnabled(getElement, expected, label) {
  for (const id of BUSY_IDS) {
    assert.equal(getElement(id).disabled, expected, `#${id} disabled should be ${expected} (${label})`);
  }
}

test('a slow/stalled response body is aborted once the 30s budget elapses, and busy UI state is restored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let rejectBody;
  const bodyPromise = new Promise((_resolve, reject) => { rejectBody = reject; });
  let abortListenerFired = false;
  let signalSeenAborted = false;

  // Headers "arrive" immediately (fetch() resolves right away, as a real
  // fast connection would), but the body (json()) only settles once the
  // AbortSignal actually fires - simulating a stalled/slow body read that
  // is independent of how fast the initial connection was.
  const fetchImpl = async (_path, options) => {
    options.signal.addEventListener('abort', () => {
      abortListenerFired = true;
      signalSeenAborted = options.signal.aborted;
      rejectBody(new DOMException('The operation was aborted.', 'AbortError'));
    });
    return { ok: true, json: () => bodyPromise };
  };

  const { run, getElement } = createSandbox({ fetch: fetchImpl });
  const refreshPromise = run('refresh()');
  // Let the microtask queue settle so setBusy(true)/fetch() have definitely run.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(run('busy'), true, 'busy should be true immediately once refresh() starts');
  assertAllEnabled(getElement, true, 'while request is in flight');

  t.mock.timers.tick(29999);
  await Promise.resolve();
  assert.equal(abortListenerFired, false, 'must NOT abort before the 30s timeout elapses (body still "in flight")');
  assert.equal(run('busy'), true, 'still busy while within the timeout budget');

  t.mock.timers.tick(2); // crosses the 30000ms mark
  const ok = await refreshPromise;

  assert.equal(abortListenerFired, true, 'the abort must fire once the 30s budget is exceeded, even though headers had already arrived');
  assert.equal(signalSeenAborted, true);
  assert.equal(ok, false, 'refresh() should report failure when the request times out');
  assert.equal(run('busy'), false, 'busy must be restored to false after a timeout');
  assertAllEnabled(getElement, false, 'after a timeout');
  assert.match(getElement('notice').textContent, /지연/, 'notice should surface a timeout-specific message');
  assert.equal(getElement('notice').classList.contains('error'), true, 'notice should be flagged as an error');
});

test('a request that fails for a non-timeout reason still restores busy UI state', async (t) => {
  const fetchImpl = async () => { throw new TypeError('network error: connection reset'); };
  const { run, getElement } = createSandbox({ fetch: fetchImpl });

  const ok = await run('refresh()');

  assert.equal(ok, false);
  assert.equal(run('busy'), false, 'busy must be restored after a plain request failure');
  assertAllEnabled(getElement, false, 'after a request failure');
});

test('aborting mid-body-read (simulated user/programmatic cancellation) still restores busy UI state', async (t) => {
  // Exercises the same code path a future explicit "cancel" affordance would
  // rely on: whatever causes the AbortController to fire while the body is
  // still being read must be treated identically to the internal 30s timer -
  // request() has no special-case that only understands its own timer.
  let rejectBody;
  const bodyPromise = new Promise((_resolve, reject) => { rejectBody = reject; });
  let ctrl;
  const fetchImpl = async (_path, options) => {
    ctrl = options;
    return { ok: true, json: () => bodyPromise };
  };
  const { run, getElement } = createSandbox({ fetch: fetchImpl });

  const refreshPromise = run('refresh()');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(run('busy'), true);

  // Simulate an external cancellation independent of the internal timer.
  rejectBody(new DOMException('The operation was aborted.', 'AbortError'));
  const ok = await refreshPromise;

  assert.equal(ok, false);
  assert.equal(run('busy'), false, 'busy must be restored after a mid-body-read cancellation');
  assertAllEnabled(getElement, false, 'after a cancellation');
  void ctrl;
});

test('a fast, healthy response is not falsely aborted and busy UI state settles back to normal', async (t) => {
  const server = await ensureLiveServer({ port: 8932 });
  try {
    const fetchImpl = (path, options) => fetch(`${server.baseUrl}${path}`, options);
    const { run, getElement } = createSandbox({ fetch: fetchImpl });

    const ok = await run('refresh()');

    assert.equal(ok, true, 'a normal, fast /api/simulate call should succeed');
    assert.ok(run('!!data && !!data.summary'));
    assert.equal(run('busy'), false);
    assertAllEnabled(getElement, false, 'after a normal successful request');

    // Also exercise the blob path (CSV export) through the same request() helper.
    const blob = await run("request('/api/export', state, 'blob')");
    assert.equal(typeof blob.size, 'number');
    assert.ok(blob.size > 0);
  } finally {
    await server.stop();
  }
});
