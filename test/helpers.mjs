/* Carga los modulos de navegador (scripts clasicos con IIFE sobre `window`)
   dentro de un contexto vm y devuelve ese objeto global.

   Los scripts hacen `(function (global) { ... }(window))` y dentro usan
   referencias desnudas (`FSM`, `VERILOG`). En un navegador `window` ES el
   objeto global, asi que aqui hacemos que `window` apunte al propio sandbox. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const JS_DIR = path.join(here, '..', 'js');
const EXAMPLES_DIR = path.join(here, '..', 'examples');

export function loadBrowserModules(files = ['model.js', 'verilog.js', 'icestudio.js']) {
  const sandbox = { console, TextEncoder, TextDecoder };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of files) {
    const code = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  if (files.includes('model.js')) {
    for (const f of ['detector-101-moore.js', 'traffic-light-moore.js', 'detector-101-mealy.js']) {
      const code = fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf8');
      vm.runInContext(code, sandbox, { filename: f });
    }
  }
  return sandbox;
}

/* Copia profunda a traves de la frontera del vm: iguala prototipos para que
   assert.deepStrictEqual funcione. */
export function plain(x) {
  return JSON.parse(JSON.stringify(x));
}
