import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PLUGIN_JS = fs.readFileSync(path.join(ROOT, 'js', 'plugin.js'), 'utf8');

/* --- Minimal DOM stub used by saveFile() -------------------------------- */
function fakeDocument() {
  const created = [];
  const body = { children: [], appendChild(n) { this.children.push(n); n.parentNode = body; },
                 removeChild(n) { this.children = this.children.filter((c) => c !== n); } };
  return {
    body,
    created,
    createElement() {
      const node = {
        style: {}, attrs: {}, handlers: {}, clicked: 0, parentNode: null,
        setAttribute(k, v) { this.attrs[k] = v; },
        addEventListener(ev, fn) { this.handlers[ev] = fn; },
        click() { this.clicked++; }
      };
      created.push(node);
      return node;
    }
  };
}

function load({ opener = undefined, require: req = undefined, document: doc = fakeDocument() } = {}) {
  const sandbox = { console, document: doc, opener, require: req };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(PLUGIN_JS, sandbox, { filename: 'plugin.js' });
  return sandbox;
}

/* --- Plugin manifest ---------------------------------------------------- */

test('manifest.json contains required Icestudio fields', () => {
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  for (const k of ['manifest_ver', 'id', 'name', 'version', 'icon', 'width', 'height']) {
    assert.ok(mf[k] !== undefined, 'falta el campo ' + k);
  }
  assert.ok(fs.existsSync(path.join(ROOT, mf.icon)), 'no existe el icono ' + mf.icon);
  assert.ok(fs.existsSync(path.join(ROOT, 'index.html')), 'el plugin de ventana abre index.html');
  /* WaflePluginExtWindow abre <uri>/<manifest.id>/index.html, asi que la
     carpeta instalada tiene que llamarse igual que el id. */
  assert.match(mf.id, /^[a-z0-9-]+$/, 'el id es tambien el nombre de carpeta');
});

test('index.html scripts exist and share one cache version', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"?]+)\?v=(\d+)"/g)];
  assert.ok(refs.length >= 9, 'se esperaban los 8 modulos y la hoja de estilos');
  const versions = new Set(refs.map((m) => m[2]));
  assert.equal(versions.size, 1, 'todas las etiquetas deben llevar el mismo ?v=');
  for (const [, file] of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), 'no existe ' + file);
  }
  assert.ok(html.includes('js/plugin.js?v='), 'plugin.js debe cargarse desde index.html');
});

/* --- Outside Icestudio the module remains inert ------------------------ */

test('outside Icestudio: PLUGIN is inactive and saveFile falls back', () => {
  const s = load();
  assert.equal(s.PLUGIN.active(), false);
  assert.equal(s.PLUGIN.saveFile('x.ice', '{}'), false);
  assert.equal(s.PLUGIN.bus(), null);
  assert.equal(s.document.created.length, 0, 'no debe tocar el DOM');
});

test('outside Icestudio: ready() does not run', () => {
  const s = load();
  let llamado = false;
  s.PLUGIN.ready(() => { llamado = true; });
  assert.equal(llamado, false);
});

test('an unrelated browser opener does not count as Icestudio', () => {
  const s = load({ opener: { location: 'https://example.com' } });
  assert.equal(s.PLUGIN.active(), false);
});

/* --- Inside Icestudio --------------------------------------------------- */

test('inside Icestudio: active() and host bus()', () => {
  const hostBus = { events: {} };
  const s = load({ opener: { iceStudio: { bus: hostBus } } });
  assert.equal(s.PLUGIN.active(), true);
  assert.equal(s.PLUGIN.bus(), hostBus);
});

test('onIcestudioPluginLoaded flushes the ready() queue', () => {
  const s = load({ opener: { iceStudio: { bus: {} } } });
  const orden = [];
  s.PLUGIN.ready(() => orden.push('a'));
  s.PLUGIN.ready(() => orden.push('b'));
  assert.deepEqual(orden, []);
  s.onIcestudioPluginLoaded();
  assert.deepEqual(orden, ['a', 'b']);
  s.PLUGIN.ready(() => orden.push('c'));
  assert.deepEqual(orden, ['a', 'b', 'c'], 'despues de listo se ejecuta al vuelo');
});

test('saveFile opens the native dialog and writes the chosen destination', () => {
  const escrito = [];
  const fakeFs = { writeFileSync: (p, c) => escrito.push([p, c]) };
  const doc = fakeDocument();
  const s = load({ opener: { iceStudio: { bus: {} } }, require: (m) => (m === 'fs' ? fakeFs : null), document: doc });

  assert.equal(s.PLUGIN.saveFile('detector101.ice', '{"a":1}'), true);
  const input = doc.created[0];
  assert.equal(input.attrs.nwsaveas, 'detector101.ice', 'nombre sugerido en el dialogo');
  assert.equal(input.clicked, 1);
  assert.equal(doc.body.children.length, 1);

  input.value = 'C:/tmp/detector101.ice';
  input.handlers.change();
  assert.deepEqual(escrito, [['C:/tmp/detector101.ice', '{"a":1}']]);
  assert.equal(doc.body.children.length, 0, 'el input se retira del DOM');
});

test('saveFile: user cancellation writes nothing', () => {
  const escrito = [];
  const doc = fakeDocument();
  const s = load({
    opener: { iceStudio: { bus: {} } },
    require: () => ({ writeFileSync: (p, c) => escrito.push([p, c]) }),
    document: doc
  });
  s.PLUGIN.saveFile('x.ice', '{}');
  const input = doc.created[0];
  input.value = '';
  input.handlers.change();
  assert.deepEqual(escrito, []);
});

test('saveFile: write failure is reported instead of propagated', () => {
  const doc = fakeDocument();
  const s = load({
    opener: { iceStudio: { bus: {} } },
    require: () => ({ writeFileSync: () => { throw new Error('disco lleno'); } }),
    document: doc
  });
  const avisos = [];
  s.PLUGIN.notify = (msg, err) => avisos.push([msg, !!err]);
  s.PLUGIN.saveFile('x.ice', '{}');
  const input = doc.created[0];
  input.value = 'C:/tmp/x.ice';
  assert.doesNotThrow(() => input.handlers.change());
  assert.deepEqual(avisos, [['disco lleno', true]]);
});

test('without Node (browser with a false opener), saveFile falls back', () => {
  const s = load({ opener: { iceStudio: { bus: {} } }, require: undefined });
  assert.equal(s.PLUGIN.saveFile('x.ice', '{}'), false);
});
