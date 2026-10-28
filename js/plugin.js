/* =========================================================================
 * plugin.js - Icestudio integration when the editor runs as an external plugin.
 *
 * Icestudio opens index.html in an NW.js window and injects its API after load:
 *   - window.opener        -> Icestudio main window
 *   - window.iceStudio.bus -> host event bus
 *   - onIcestudioPluginLoaded() -> readiness hook
 *
 * Outside Icestudio this module remains inert and the editor behaves normally.
 *
 * Exposes the global `PLUGIN` object.
 * ========================================================================= */
(function (global) {
  'use strict';

  var ready = false;
  var waiting = [];

  /* Host window, or null outside Icestudio. */
  function host() {
    try {
      var o = global.opener;
      return (o && o.iceStudio) ? o : null;
    } catch (e) {
      /* An opener from another origin is not Icestudio. */
      return null;
    }
  }

  function active() { return host() !== null; }

  /* Host event bus. Prefer the object injected into THIS window.
     porque es el que reenvia al opener; si todavia no llego, usamos el del
     host directamente. */
  function bus() {
    var h = host();
    if (!h) return null;
    if (global.iceStudio && global.iceStudio.bus) return global.iceStudio.bus;
    return h.iceStudio.bus || null;
  }

  /* Runs cb once the host API is ready. Outside Icestudio it never runs.
     llama nunca, que es justo lo que queremos. */
  function onReady(cb) {
    if (ready) { cb(); return; }
    waiting.push(cb);
  }

  /* Hook called by IcestudioPlugin.start() after injecting the API. */
  global.onIcestudioPluginLoaded = function () {
    ready = true;
    var pending = waiting;
    waiting = [];
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](); } catch (e) { PLUGIN.notify(String(e), true); }
    }
  };

  function requireNode(mod) {
    try {
      if (typeof global.require === 'function') return global.require(mod);
    } catch (e) { /* sin Node: navegador normal */ }
    return null;
  }

  /* Save a file. Icestudio exposes Node, so use its native save dialog.
     dialogo nativo "Guardar como" de NW.js en vez de disparar la descarga
     del navegador. Devuelve false si no puede encargarse, para que quien
     llama caiga en la descarga de siempre. */
  function saveFile(filename, content) {
    var fs = active() ? requireNode('fs') : null;
    if (!fs) return false;

    var input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('nwsaveas', filename);
    input.style.display = 'none';
    input.addEventListener('change', function () {
      var dest = input.value;
      if (input.parentNode) input.parentNode.removeChild(input);
      if (!dest) return;
      try {
        fs.writeFileSync(dest, content);
        PLUGIN.notify(dest);
      } catch (e) {
        PLUGIN.notify(String(e.message || e), true);
      }
    });
    document.body.appendChild(input);
    input.click();
    return true;
  }

  var PLUGIN = {
    active: active,
    ready: onReady,
    bus: bus,
    saveFile: saveFile,
    /* Replaceable by the app to show messages in the appropriate UI. */
    notify: function (msg, isError) {
      if (isError) console.error('[fsm-editor]', msg);
      else console.log('[fsm-editor]', msg);
    }
  };

  global.PLUGIN = PLUGIN;
}(window));
