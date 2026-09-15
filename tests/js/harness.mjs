// Minimal DOM/browser shim used to execute static/app.js (a plain classic
// script, not a module) inside Node's vm module for regression testing.
//
// app.js is not bundled/exported, so we don't import functions from it —
// instead we run its source in a vm.Context and then run small follow-up
// snippets of JS *in that same context* to read its top-level `let`/`const`
// bindings (catalog, world, data, busy, state, ...) and call its top-level
// functions (init, request, refresh, setBusy, ...). Node's vm module keeps
// the global lexical environment of a Context alive across separate
// runInContext() calls, exactly like sibling <script> tags in a browser
// sharing one `window`, so this works without app.js needing any changes.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_JS_PATH = path.join(__dirname, '..', '..', 'static', 'app.js');
export const APP_JS_SOURCE = readFileSync(APP_JS_PATH, 'utf8');

// app.js ends with a bare `init();` call. We want the test to drive init()
// itself (so it can await the result and control when it happens), so we
// strip that auto-invocation before running the script.
const APP_JS_WITHOUT_AUTO_INIT = APP_JS_SOURCE.replace(/\ninit\(\);\s*$/, '\n');
if (APP_JS_WITHOUT_AUTO_INIT === APP_JS_SOURCE) {
  throw new Error('harness.mjs: could not find trailing `init();` in app.js to strip - app.js structure changed, update the harness.');
}

/** An object where any unset property read returns a callable no-op that
 * itself returns another auto-stub (so arbitrary chains like
 * ctx.strokeStyle=... ; ctx.beginPath(); ctx.arc(...).foo() never throw),
 * while explicit property assignment behaves like a normal object. Covers
 * Canvas2D contexts, style objects, and anything else app.js pokes at that
 * this test doesn't care about the internals of. */
function makeAutoStub() {
  const target = {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return () => makeAutoStub();
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  });
}

function makeClassList() {
  const set = new Set();
  return {
    toggle(cls, force) {
      const on = force === undefined ? !set.has(cls) : !!force;
      if (on) set.add(cls); else set.delete(cls);
      return on;
    },
    add(...classes) { classes.forEach((c) => set.add(c)); },
    remove(...classes) { classes.forEach((c) => set.delete(c)); },
    contains(cls) { return set.has(cls); },
  };
}

function makeElement(id) {
  const el = makeAutoStub();
  Object.assign(el, {
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    classList: makeClassList(),
    style: makeAutoStub(),
    dataset: {},
    options: [],
    elements: { namedItem: () => makeElement('_field') },
    getBoundingClientRect: () => ({ width: 400, height: 300, left: 0, top: 0, right: 400, bottom: 300 }),
    getContext: () => makeAutoStub(),
    querySelector: () => makeElement('_sub'),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    append: () => {},
    replaceChildren: () => {},
    showModal: () => {},
    close: () => {},
    click: () => {},
    submit: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    removeAttribute: () => {},
    focus: () => {},
  });
  return el;
}

function makeFragment() {
  const frag = { childNodes: [] };
  frag.append = (...els) => { frag.childNodes.push(...els); };
  frag.replaceChildren = () => { frag.childNodes = []; };
  return frag;
}

class ImageStub {
  set src(_v) { /* never fires onload in this harness - intentional */ }
}

class ResizeObserverStub {
  constructor(cb) { this.cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * Build a fresh vm Context with app.js loaded (but not yet auto-run past its
 * `init();` line) and return handles for driving/inspecting it.
 *
 * @param {object} opts
 * @param {Function} opts.fetch - (path, options) => Promise<ResponseLike>
 * @returns {{ context: vm.Context, run: (src:string)=>any, getElement:(id:string)=>object }}
 */
export function createSandbox({ fetch }) {
  const elCache = new Map();
  const getElement = (id) => {
    if (!elCache.has(id)) elCache.set(id, makeElement(id));
    return elCache.get(id);
  };

  const documentStub = {
    getElementById: getElement,
    createElement: (tag) => makeElement(`_created:${tag}`),
    createDocumentFragment: makeFragment,
    querySelectorAll: () => [],
    querySelector: () => makeElement('_docSub'),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  // A handful of elements start hidden in the real index.html (via the
  // `hidden` attribute). makeElement() has no markup to read that from, so
  // mirror it explicitly for the ones these tests actually observe.
  for (const id of ['notice', 'mapError', 'fleetEmpty']) getElement(id).hidden = true;

  const sandbox = {
    console,
    document: documentStub,
    window: { addEventListener() {}, removeEventListener() {} },
    Image: ImageStub,
    ResizeObserver: ResizeObserverStub,
    fetch,
    AbortController: globalThis.AbortController,
    DOMException: globalThis.DOMException,
    URL: globalThis.URL,
    Blob: globalThis.Blob,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    devicePixelRatio: 1,
  };
  const context = vm.createContext(sandbox);
  const run = (src, filename = 'test-snippet.js') => vm.runInContext(src, context, { filename });

  run(APP_JS_WITHOUT_AUTO_INIT, 'app.js');

  return { context, run, getElement };
}
