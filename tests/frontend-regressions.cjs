// Run against a local server; all browser contexts and request stubs are isolated.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.ORBIT_LAB_URL || 'http://127.0.0.1:8000';

// Simulate response headers arriving while the body never finishes. Shorten only
// the intercepted request's deadline; real startup requests keep their 30 seconds.
function stallResponseBody({path, bodyType = 'json', ok = true}) {
  const originalFetch = window.fetch;
  const originalTimeout = window.setTimeout;
  const originalClear = window.clearTimeout;
  const deadlines = new Map();
  let latestDeadline;
  const observed = window.__stalledRequest = {bodyRead: false, aborted: false};
  window.setTimeout = (callback, delay, ...args) => {
    const id = originalTimeout(callback, delay, ...args);
    if (delay === 30000) {
      latestDeadline = id;
      deadlines.set(id, {callback, args});
    }
    return id;
  };
  window.clearTimeout = id => {
    originalClear(id);
    const deadline = deadlines.get(id);
    if (deadline?.replacement !== undefined) originalClear(deadline.replacement);
    deadlines.delete(id);
  };
  window.fetch = (target, options = {}) => {
    if (target !== path) return originalFetch(target, options);
    const deadline = deadlines.get(latestDeadline);
    if (deadline) {
      originalClear(latestDeadline);
      deadline.replacement = originalTimeout(deadline.callback, 40, ...deadline.args);
    }
    const read = () => {
      observed.bodyRead = true;
      return new Promise((resolve, reject) => {
        const abort = () => {
          observed.aborted = true;
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, {once: true});
      });
    };
    return Promise.resolve({ok, status: ok ? 200 : 503, [bodyType]: read});
  };
  window.__restoreRequest = () => {
    window.fetch = originalFetch;
    window.setTimeout = originalTimeout;
    window.clearTimeout = originalClear;
  };
}

(async () => {
  const browser = await chromium.launch({headless: true});
  const errors = [];
  function observe(page) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
  }
  const ready = page => page.waitForFunction(() => data && !busy);
  const stateOf = page => page.evaluate(() => JSON.parse(JSON.stringify(state)));
  async function action(page, selector) {
    await page.locator(selector).click();
    await page.waitForFunction(() => !busy);
  }
  async function checkDeadline(page, options, selector) {
    const before = await stateOf(page);
    await page.evaluate(() => notice(''));
    await page.evaluate(stallResponseBody, options);
    await page.locator(selector).click();
    await page.waitForFunction(() =>
      !busy && document.querySelector('#notice').textContent.includes('응답이 지연'));
    assert.deepEqual(await page.evaluate(() => window.__stalledRequest),
      {bodyRead: true, aborted: true}, `${options.path} must abort its pending body`);
    assert.deepEqual(await stateOf(page), before, 'a timed-out request must preserve the experiment');
    assert.equal(await page.locator('#advance').isEnabled(), true);
    await page.evaluate(() => window.__restoreRequest());
  }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    observe(page);
    await page.goto(url);
    await ready(page);

    await checkDeadline(page, {path: '/api/simulate'}, '#advance');
    await action(page, '#advance');
    assert.equal((await stateOf(page)).elapsed, 300, 'simulation must work after retry');
    await checkDeadline(page, {path: '/api/export', bodyType: 'blob'}, '#csv');
    const download = page.waitForEvent('download');
    await page.locator('#csv').click();
    assert.equal((await download).suggestedFilename(), 'satellite-telemetry.csv');
    await page.waitForFunction(() => !busy);
    await checkDeadline(page, {path: '/api/simulate', ok: false}, '#advance');

    // Selection, reordered results, and playback must keep the same focused button.
    await page.locator('#fleet button[data-satellite="1"]').focus();
    await page.evaluate(() => window.__focusedFleetButton = document.activeElement);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => state.selected === 1 && !busy);
    assert.equal(await page.evaluate(() =>
      document.activeElement === window.__focusedFleetButton), true);
    await page.evaluate(() => {
      $('fleetSort').value = 'risk';
      renderFleet();
    });
    assert.equal(await page.evaluate(() =>
      document.activeElement === window.__focusedFleetButton), true);
    const beforePlayback = (await stateOf(page)).elapsed;
    await page.locator('#play').click();
    await page.locator('#fleet button[data-satellite="1"]').focus();
    await page.waitForFunction(elapsed => state.elapsed > elapsed && !busy, beforePlayback);
    assert.equal(await page.evaluate(() =>
      document.activeElement === window.__focusedFleetButton), true);
    await page.evaluate(() => pause());

    // Reservations can precede the fault and remain visible when its alert appears.
    const scheduled = {
      format: 'orbit-lab-v1',
      simulation: {
        elapsed: 0,
        faults: [{id: 'scheduled-thermal', satellite: 0, kind: 'thermal', at: 180, severity: 1}],
        actions: [{fault_id: 'scheduled-thermal', kind: 'payload_throttle', at: 1200}],
      },
    };
    await page.locator('#file').setInputFiles({
      name: 'scheduled.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(scheduled)),
    });
    await page.waitForFunction(() => state.elapsed === 0 && state.actions.length === 1 && !busy);
    assert.match(await page.locator('#recommendations').textContent(), /대응 예정.*00:20:00/);
    await action(page, '#advance');
    await action(page, '#advance');
    assert.equal((await stateOf(page)).elapsed, 600);
    assert.equal(await page.locator('[data-action="payload_throttle"]').count(), 0);
    assert.match(await page.locator('#recommendations').textContent(), /대응 예정.*00:20:00/);
    await action(page, '#advance');
    await action(page, '#advance');
    assert.equal((await stateOf(page)).elapsed, 1200);
    assert.equal((await stateOf(page)).actions.length, 1);
    assert.doesNotMatch(await page.locator('#recommendations').textContent(), /대응 예정/);
    assert.match(await page.locator('#recommendations').textContent(), /실행/);
    await context.close();

    // Initial GETs share the same deadline; the optional map can fail independently.
    for (const path of ['/api/catalog', '/static/world.json']) {
      const startupContext = await browser.newContext();
      await startupContext.addInitScript(stallResponseBody, {path});
      const startupPage = await startupContext.newPage();
      observe(startupPage);
      await startupPage.goto(url);
      if (path === '/api/catalog') {
        await startupPage.waitForFunction(() => $('connection').textContent === '연결 실패');
      } else {
        await ready(startupPage);
        assert.equal(await startupPage.evaluate(() => world.length), 0);
        assert.equal(await startupPage.locator('#total').textContent(), '128');
      }
      assert.deepEqual(await startupPage.evaluate(() => window.__stalledRequest),
        {bodyRead: true, aborted: true}, `${path} must time out`);
      await startupContext.close();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: JSON/CSV/error-body deadlines, retry, initial GET deadlines, optional map recovery, fleet focus and scheduled actions');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
