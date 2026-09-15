// Regression coverage for review item #1: a failed or malformed
// /static/world.json must degrade only the map visualization, never abort
// catalog loading, telemetry refresh, or data export.
//
// Runs static/app.js against a real `uvicorn main:app` backend (via
// live_server.mjs) so /api/catalog and /api/simulate responses are
// guaranteed to match the real API shape. Only the world.json fetch is
// intercepted, to simulate a network failure or a malformed response body.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './harness.mjs';
import { ensureLiveServer } from './live_server.mjs';

let server;
let baseUrl;

test.before(async () => {
  server = await ensureLiveServer({ port: 8931 });
  baseUrl = server.baseUrl;
});

test.after(async () => {
  await server.stop();
});

/** Forwards every request to the real backend, except /static/world.json
 * which is routed according to `worldMode`. */
function makeFetch(worldMode) {
  return async (requestPath, options) => {
    if (requestPath === '/static/world.json') {
      if (worldMode === 'network-error') {
        throw new TypeError('simulated network failure (e.g. DNS/connection reset)');
      }
      if (worldMode === 'malformed-json') {
        // A real, reachable, 200 OK response whose body is not JSON -
        // an authentic "invalid/malformed JSON in world.json" case.
        return fetch(`${baseUrl}/static/style.css`, options);
      }
      if (worldMode === 'http-404') {
        return fetch(`${baseUrl}/static/does-not-exist.json`, options);
      }
      // 'healthy-passthrough' (or anything else): forward normally, as a
      // sanity check that the harness/fetch plumbing itself is correct.
    }
    return fetch(`${baseUrl}${requestPath}`, options);
  };
}

async function assertCoreStillWorks(run, getElement) {
  // catalog loaded despite the map failure.
  assert.equal(run('typeof catalog'), 'object');
  assert.ok(run('catalog !== null'));
  assert.ok(run('!!catalog.faults && !!catalog.actions'), 'catalog.faults/actions should be populated');

  // map degraded gracefully: empty outline set, no crash, inline error shown.
  // (world is read out of a separate vm realm, so compare its length/shape
  // rather than deepEqual-ing it against an outer-realm [] literal, which
  // node:assert/strict's deepStrictEqual would reject as "not reference-equal"
  // purely due to the differing Array.prototype identity.)
  assert.equal(run('Array.isArray(world)'), true, 'world should stay an array rather than throwing');
  assert.equal(run('world.length'), 0, 'world should fall back to [] rather than throwing');
  const mapError = getElement('mapError');
  assert.equal(mapError.hidden, false, '#mapError should be shown to the user');
  assert.match(mapError.textContent, /지도/, '#mapError should mention the map data');

  // core telemetry/simulation loaded (refresh() -> /api/simulate succeeded).
  assert.ok(run('!!data'), 'data should be populated by the initial refresh()');
  assert.ok(run('!!data.summary'), 'data.summary should be present');
  assert.ok(run('!!data.selected'), 'data.selected should be present');
  assert.ok(run('Array.isArray(data.satellites) && data.satellites.length > 0'));

  // busy correctly settled back to false, buttons usable.
  assert.equal(run('busy'), false);
  for (const id of ['advance', 'inject', 'demo', 'csv', 'save', 'load']) {
    assert.equal(getElement(id).disabled, false, `#${id} should not be stuck disabled`);
  }

  // running an experiment (advancing simulated time) still works post-failure.
  const advanced = await run('refresh({...state, elapsed: 300})');
  assert.equal(advanced, true, 'refresh() should still succeed after the map failed to load');
  assert.equal(run('state.elapsed'), 300);

  // data export still works post-failure.
  const blob = await run("request('/api/export', state, 'blob')");
  assert.ok(blob, 'CSV export should still succeed after the map failed to load');
  assert.equal(typeof blob.size, 'number', 'export should resolve to a real Blob');
  assert.ok(blob.size > 0, 'exported CSV blob should not be empty');
}

test('world.json network failure: catalog, telemetry and export keep working', async () => {
  const { run, getElement } = createSandbox({ fetch: makeFetch('network-error') });
  await run('init()');
  await assertCoreStillWorks(run, getElement);
});

test('world.json malformed JSON: catalog, telemetry and export keep working', async () => {
  const { run, getElement } = createSandbox({ fetch: makeFetch('malformed-json') });
  await run('init()');
  await assertCoreStillWorks(run, getElement);
});

test('world.json HTTP error (e.g. 404): catalog, telemetry and export keep working', async () => {
  const { run, getElement } = createSandbox({ fetch: makeFetch('http-404') });
  await run('init()');
  await assertCoreStillWorks(run, getElement);
});

test('a healthy world.json still populates outlines (sanity check for the harness itself)', async () => {
  const { run, getElement } = createSandbox({ fetch: makeFetch('healthy-passthrough') });
  await run('init()');
  assert.ok(run('Array.isArray(world) && world.length > 0'), 'a healthy world.json should populate outlines');
  assert.equal(getElement('mapError').hidden, true, '#mapError should stay hidden when the map loads fine');
});
