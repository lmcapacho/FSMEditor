/* =========================================================================
 * app.js - UI orchestration: toolbar, inspector, validation, preview and export.
 * ========================================================================= */
(function () {
  'use strict';

  var AUTOSAVE_KEY = 'fsm-editor:autosave';
  var store = { m: null };
  var syncModeButtons = function () {};
  function M() { return store.m; }

  /* --------------------------------------------------------------------- */
  /* Undo / redo. Complete snapshots match .fsm files; machines are small, */
  /* serialization is cheap, and this remains simple and robust.            */
  /* --------------------------------------------------------------------- */
  var MAX_HISTORY = 100;
  var undoStack = [], redoStack = [];
  var lastSnapshot = null;
  var restoring = false;

  function updateHistoryButtons() {
    var u = $('btn-undo'), r = $('btn-redo');
    if (u) u.disabled = undoStack.length === 0;
    if (r) r.disabled = redoStack.length === 0;
  }
  function checkpoint() {
    if (restoring || !store.m) return;
    var cur = FSM.serialize(M());
    if (lastSnapshot === null) { lastSnapshot = cur; return; }
    if (cur === lastSnapshot) return;
    undoStack.push(lastSnapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    lastSnapshot = cur;
    updateHistoryButtons();
  }
  function restoreSnapshot(str) {
    restoring = true;
    try {
      store.m = FSM.deserialize(str);
      lastSnapshot = str;
      EDITOR.render();
      EDITOR.setSelection(null);
      refreshAll();
      autosave();
    } finally { restoring = false; }
    updateHistoryButtons();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(FSM.serialize(M()));
    restoreSnapshot(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(FSM.serialize(M()));
    restoreSnapshot(redoStack.pop());
  }

  /* --------------------------------------------------------------------- */
  /* Helpers DOM                                                           */
  /* --------------------------------------------------------------------- */
  function h(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function clearEl(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function $(id) { return document.getElementById(id); }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* --------------------------------------------------------------------- */
  /* Downloads                                                             */
  /* --------------------------------------------------------------------- */
  async function download(filename, content, mime) {
    /* Icestudio uses its native dialog. Outside it, PLUGIN.saveFile returns
       false and the standard browser download remains available. */
    if (window.PLUGIN && window.PLUGIN.saveFile(filename, content)) return;

    if (window.DESKTOP && window.DESKTOP.saveTextFile) {
      try {
        await window.DESKTOP.saveTextFile(filename, content);
        return;
      } catch (e) {
        alert('Could not save the file: ' + (e && e.message ? e.message : e));
        return;
      }
    }

    var blob = content instanceof Uint8Array
      ? new Blob([content], { type: mime || 'application/octet-stream' })
      : new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  function copyText(str) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(str).then(flashCopied, fallbackCopy.bind(null, str));
    } else {
      fallbackCopy(str);
    }
  }
  function fallbackCopy(str) {
    var ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = str;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); flashCopied(); } catch (e) {}
    ta.remove();
  }
  function flashCopied() {
    var b = $('btn-copy');
    if (!b) return;
    var old = b.textContent;
    b.textContent = I18N.t('code.copied');
    setTimeout(function () { b.textContent = old; }, 1200);
  }

  /* --------------------------------------------------------------------- */
  /* Persistence                                                           */
  /* --------------------------------------------------------------------- */
  var autosave = debounce(function () {
    try { localStorage.setItem(AUTOSAVE_KEY, FSM.serialize(M())); } catch (e) {}
  }, 400);

  function loadMachine(machine, doFit) {
    store.m = machine;
    undoStack.length = 0;
    redoStack.length = 0;
    lastSnapshot = FSM.serialize(machine);
    updateHistoryButtons();
    EDITOR.render();
    if (doFit) EDITOR.fit();
    EDITOR.setSelection(null);
    refreshAll();
    autosave();
  }

  /* --------------------------------------------------------------------- */
  /* Refreshing                                                            */
  /* --------------------------------------------------------------------- */
  var refreshDerived = debounce(function () {
    refreshVerilog();
    refreshProblems();
    autosave();
    checkpoint();
  }, 250);

  function refreshAll() {
    $('canvas-wrap').classList.toggle('empty', M().states.length === 0);
    refreshModulePanel();
    refreshPortsPanel();
    refreshTransitionTable();
    refreshProblems();
    refreshVerilog();
  }

  /* ---- module panel ---- */
  function refreshModulePanel() {
    var m = M();
    $('mod-name').value = m.name;
    $('mod-clk').value = m.clock;
    $('mod-rst').value = m.reset;
    $('mod-rst-low').checked = m.resetActiveLow;
    $('mod-rst-sync').checked = m.resetSync;
    $('mod-enc').value = m.encoding;
  }

  function bindModulePanel() {
    function upd(prop, el, sanitize) {
      el.addEventListener('change', function () {
        var v = el.value.trim();
        M()[prop] = sanitize ? FSM.sanitizeIdentifier(v, M()[prop]) : v;
        el.value = M()[prop];
        refreshDerived();
      });
    }
    upd('name', $('mod-name'), true);
    upd('clock', $('mod-clk'), true);
    upd('reset', $('mod-rst'), true);
    $('mod-rst-low').addEventListener('change', function () { M().resetActiveLow = this.checked; refreshDerived(); });
    $('mod-rst-sync').addEventListener('change', function () { M().resetSync = this.checked; refreshDerived(); });
    $('mod-enc').addEventListener('change', function () { M().encoding = this.value; refreshDerived(); });
  }

  /* ---- ports panel ---- */
  function portRow(kind, p) {
    var m = M();
    var nameInp = h('input', {
      class: 'port-name', value: p.name, spellcheck: 'false',
      onchange: function () {
        var want = FSM.sanitizeIdentifier(this.value.trim(), p.name);
        var list = kind === 'input' ? m.inputs : m.outputs;
        var n = want, i = 1;
        while (list.some(function (o) { return o !== p && o.name === n; })) { n = want + i; i += 1; }
        if (kind === 'output') FSM.renameOutput(m, p, n);
        else p.name = n;
        refreshAll();
        refreshDerivedNow();
      }
    });
    var widthInp = h('input', {
      class: 'port-width', type: 'number', min: '1', value: p.width,
      onchange: function () { p.width = Math.max(1, parseInt(this.value, 10) || 1); this.value = p.width; refreshDerived(); }
    });
    var kids = [nameInp, h('span', { class: 'dim', text: '[' }), widthInp, h('span', { class: 'dim', text: ']' })];
    if (kind === 'output') {
      kids.push(h('input', {
        class: 'port-def', value: p.def, title: 'valor por defecto', spellcheck: 'false',
        onchange: function () { p.def = this.value.trim() || '0'; this.value = p.def; refreshDerived(); }
      }));
    }
    kids.push(h('button', {
      class: 'x', text: '×', title: 'eliminar',
      onclick: function () { FSM.deletePort(m, kind, p.id); refreshAll(); EDITOR.render(); refreshDerivedNow(); }
    }));
    return h('div', { class: 'port-row' }, kids);
  }

  function refreshPortsPanel() {
    var m = M();
    var inWrap = $('inputs-list'); clearEl(inWrap);
    m.inputs.forEach(function (p) { inWrap.appendChild(portRow('input', p)); });
    var outWrap = $('outputs-list'); clearEl(outWrap);
    m.outputs.forEach(function (p) { outWrap.appendChild(portRow('output', p)); });
  }

  /* ---- state transition table (live summary) ---- */
    /* The State column contains only the name. Moore outputs belong to the
     state, but are shown in the Outputs column (the same cell for every row
     of that state). Mealy outputs belong to the transition and are displayed
     next to the destination state. */
  function stateCell(s, rowspan) {
    var td = h('td', { class: 'state-cell', rowspan: rowspan || 1 });
    var isInit = M().initial === s.id;
    td.appendChild(h('div', { text: s.name + (isInit ? ' ▶' : '') }));
    return td;
  }
  function mooreCell(moore, rowspan) {
    var td = h('td', { class: 'out-cell', rowspan: rowspan || 1 });
    if (moore) td.appendChild(h('div', { class: 'state-moore', text: moore }));
    else { td.className = 'out-cell muted'; td.textContent = '—'; }
    return td;
  }
  function nextCell(to, mealy) {
    var td = h('td');
    td.appendChild(h('span', { text: to ? to.name : '?' }));
    if (mealy) td.appendChild(h('span', { class: 'next-mealy', text: ', ' + mealy }));
    return td;
  }
  function refreshTransitionTable() {
    var m = M();
    var wrap = $('transition-table');
    clearEl(wrap);
    if (!m.states.length) {
      wrap.appendChild(h('p', { class: 'muted', text: I18N.t('table.empty') }));
      return;
    }
    var table = h('table', { class: 'trans-table' });
    table.appendChild(h('thead', {}, [h('tr', {}, [
      h('th', { text: I18N.t('table.state') }),
      h('th', { text: I18N.t('table.cond') }),
      h('th', { text: I18N.t('table.next') }),
      h('th', { text: I18N.t('table.outputs') })
    ])]));
    var tbody = h('tbody');
    m.states.forEach(function (s) {
      var outs = FSM.outgoing(m, s.id);
      var moore = FSM.formatOutputs(s.outputs);
      if (!outs.length) {
        tbody.appendChild(h('tr', {}, [
          stateCell(s),
          h('td', { class: 'muted', text: '—' }),
          h('td', { class: 'muted', text: '—' }),
          mooreCell(moore)
        ]));
        return;
      }
      outs.forEach(function (t, i) {
        var to = FSM.getState(m, t.to);
        var cond = String(t.cond).trim();
        var row = h('tr', {}, [
          i === 0 ? stateCell(s, outs.length) : null,
          h('td', { class: cond === '' ? 'muted' : '', text: cond || '—' }),
          nextCell(to, FSM.formatOutputs(t.outputs)),
          i === 0 ? mooreCell(moore, outs.length) : null
        ].filter(function (c) { return c; }));
        tbody.appendChild(row);
      });
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  /* --------------------------------------------------------------------- */
  /* Modal dialogs (create / edit canvas states and transitions)           */
  /* --------------------------------------------------------------------- */
  function modal(title, rows, onAccept, opts) {
    opts = opts || {};
    var overlay = h('div', { class: 'modal-overlay' });
    var card = h('div', { class: 'modal-card' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-label': title });
    card.appendChild(h('div', { class: 'modal-title', text: title }));
    var body = h('div', { class: 'modal-body' });
    rows.forEach(function (r) { body.appendChild(r.el); });
    card.appendChild(body);

    function close() {
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function accept() {
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].validate && !rows[i].validate()) return;
      }
      onAccept();
      close();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Enter' && (e.target.tagName || '').toLowerCase() !== 'textarea') { e.preventDefault(); accept(); }
    }

    var footer = h('div', { class: 'modal-actions' });
    if (opts.onDelete) {
      footer.appendChild(h('button', {
        class: 'danger', text: opts.deleteLabel || 'Eliminar',
        onclick: function () { opts.onDelete(); close(); }
      }));
    }
    footer.appendChild(h('span', { class: 'spacer' }));
    footer.appendChild(h('button', { text: I18N.t('dlg.cancel'), onclick: close }));
    footer.appendChild(h('button', { class: 'primary', text: I18N.t('dlg.accept'), onclick: accept }));
    card.appendChild(footer);

    overlay.appendChild(card);
    overlay.addEventListener('pointerdown', function (e) { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    window.addEventListener('keydown', onKey, true);

    var first = body.querySelector('input, select, textarea');
    if (first) { first.focus(); if (first.select) try { first.select(); } catch (e) {} }
    return { close: close, overlay: overlay };
  }

  function fieldRow(label, inputEl, hint) {
    return {
      el: h('label', { class: 'modal-row' }, [
        h('span', { class: 'modal-label', text: label }),
        inputEl,
        hint ? h('small', { text: hint }) : null
      ]),
      input: inputEl
    };
  }
  function checkRow(label, checked) {
    var cb = h('input', { type: 'checkbox' });
    cb.checked = !!checked;
    return { el: h('label', { class: 'modal-row check' }, [cb, h('span', { text: label })]), input: cb };
  }

  function openStateDialog(s, isNew) {
    var m = M();
    var nameI = h('input', { class: 'dlg-name', value: s.name, spellcheck: 'false' });
    var codeI = h('input', { class: 'dlg-code', type: 'number', min: '0', value: s.code == null ? '' : s.code, placeholder: 'auto' });
    var initC = checkRow(I18N.t('dlg.state.initial'), m.initial === s.id);
    var outI = h('input', { class: 'dlg-outputs', value: FSM.formatOutputs(s.outputs), spellcheck: 'false', placeholder: 'y=1, z=0' });
    var radI = h('input', { class: 'dlg-radius', type: 'number', min: '16', value: s.radius == null ? '' : s.radius, placeholder: 'auto' });
    var dcC = checkRow(I18N.t('dlg.state.dc'), s.dcUndefined);

    modal(isNew ? I18N.t('dlg.state.new') : I18N.t('dlg.state.title'), [
      fieldRow(I18N.t('dlg.state.label'), nameI),
      fieldRow(I18N.t('dlg.state.code'), codeI, I18N.t('dlg.state.code.hint')),
      initC,
      fieldRow(I18N.t('dlg.state.outputs'), outI, I18N.t('dlg.state.outputs.hint')),
      fieldRow(I18N.t('dlg.state.radius'), radI, I18N.t('dlg.state.radius.hint')),
      dcC
    ], function () {
      s.name = FSM.sanitizeIdentifier(nameI.value.trim(), s.name);
      var c = codeI.value.trim();
      s.code = c === '' ? null : Math.max(0, parseInt(c, 10) || 0);
      var rr = radI.value.trim();
      s.radius = rr === '' ? null : Math.max(16, parseInt(rr, 10) || 0);
      s.outputs = FSM.parseOutputs(outI.value);
      s.dcUndefined = dcC.input.checked;
      if (initC.input.checked) m.initial = s.id;
      EDITOR.render();
      refreshAll();
      refreshDerivedNow();
      EDITOR.setSelection({ kind: 'state', id: s.id });
    }, {
      deleteLabel: I18N.t('dlg.state.delete'),
      onDelete: function () {
        FSM.deleteState(m, s.id); EDITOR.setSelection(null); EDITOR.render(); refreshAll(); refreshDerivedNow();
      }
    });
  }

  function openTransitionDialog(t, isNew) {
    var m = M();
    var from = FSM.getState(m, t.from), to = FSM.getState(m, t.to);
    var isLoop = t.from === t.to;
    var condI = h('input', { class: 'dlg-cond', value: t.cond, spellcheck: 'false', placeholder: 'empty = default transition' });
    var outI = h('input', { class: 'dlg-outputs', value: FSM.formatOutputs(t.outputs), spellcheck: 'false', placeholder: 'q=1' });
    var siblings = FSM.outgoing(m, t.from);
    var prioI = h('input', { class: 'dlg-prio', type: 'number', min: '1', max: String(siblings.length), value: siblings.indexOf(t) + 1 });
    var curveI = h('input', {
      class: 'dlg-curve', type: 'number', placeholder: 'auto',
      value: t.auto === false ? Math.round(isLoop ? t.loopAngle : t.curve) : ''
    });
    var dcC = checkRow(I18N.t('dlg.state.dc'), t.dcUndefined);

    modal(isNew ? I18N.t('dlg.trans.new') : I18N.t('dlg.trans.title'), [
      { el: h('p', { class: 'modal-row muted', text: (from ? from.name : '?') + '  →  ' + (to ? to.name : '?') }) },
      fieldRow(I18N.t('dlg.trans.cond'), condI, I18N.t('dlg.trans.cond.hint')),
      fieldRow(I18N.t('dlg.trans.outputs'), outI, I18N.t('dlg.trans.outputs.hint')),
      fieldRow(I18N.t('dlg.trans.prio'), prioI, I18N.t('dlg.trans.prio.hint')),
      fieldRow(isLoop ? I18N.t('dlg.trans.loopAngle') : I18N.t('dlg.trans.curve'), curveI,
        isLoop ? I18N.t('dlg.trans.loopAngle.hint') : I18N.t('dlg.trans.curve.hint')),
      dcC
    ], function () {
      t.cond = condI.value.trim();
      t.outputs = FSM.parseOutputs(outI.value);
      t.dcUndefined = dcC.input.checked;
      if (String(curveI.value).trim() === '') t.auto = true;
      else {
        t.auto = false;
        if (isLoop) t.loopAngle = parseInt(curveI.value, 10) || 0;
        else t.curve = parseInt(curveI.value, 10) || 0;
      }
      var cur = FSM.outgoing(m, t.from).indexOf(t) + 1;
      var want = Math.max(1, Math.min(siblings.length, parseInt(prioI.value, 10) || 1));
      var step = want > cur ? 1 : -1;
      for (var i = 0; i < Math.abs(want - cur); i += 1) FSM.moveTransitionPriority(m, t.id, step);
      EDITOR.render();
      refreshAll();
      refreshDerivedNow();
      EDITOR.setSelection({ kind: 'transition', id: t.id });
    }, {
      deleteLabel: I18N.t('dlg.trans.delete'),
      onDelete: function () {
        FSM.deleteTransition(m, t.id); EDITOR.setSelection(null); EDITOR.render(); refreshAll(); refreshDerivedNow();
      }
    });
  }

  function openEditor(sel) {
    if (!sel) return;
    if (sel.kind === 'state') {
      var s = FSM.getState(M(), sel.id);
      if (s) openStateDialog(s, sel.isNew);
    } else {
      var t = FSM.getTransition(M(), sel.id);
      if (t) openTransitionDialog(t, sel.isNew);
    }
  }

  /* ---- validation ---- */
  var hadProblems = false;
  function refreshProblems() {
    var probs = FSM.validate(M());
    var ul = $('console-list');
    clearEl(ul);
    var errs = probs.filter(function (p) { return p.level === 'error'; }).length;
    $('console-badge').textContent = probs.length
      ? (errs ? I18N.t('console.errors', { n: errs }) : I18N.t('console.warnings', { n: probs.length }))
      : I18N.t('console.ok');
    $('console-badge').className = 'badge ' + (errs ? 'bad' : (probs.length ? 'warn' : 'ok'));
    // Open only when a new problem appears. If the user collapses it, keep it
    // collapsed until another problem is introduced.
    if (probs.length && !hadProblems) $('console-bar').classList.remove('collapsed');
    hadProblems = probs.length > 0;
    if (!probs.length) {
      ul.appendChild(h('li', { class: 'ok', text: I18N.t('console.okRow') }));
      return;
    }
    probs.forEach(function (p) {
      ul.appendChild(h('li', {
        class: p.level,
        text: p.msg,
        onclick: p.ref ? function () { EDITOR.setSelection({ kind: p.ref.kind, id: p.ref.id }); } : null
      }));
    });
  }

  function bindConsole() {
    $('console-head').addEventListener('click', function () {
      $('console-bar').classList.toggle('collapsed');
    });
  }

  /* ---- verilog / ice ---- */
  function refreshVerilog() {
    var view = $('code-view').value;
    var code;
    try {
      if (view === 'module') code = VERILOG.generateModule(M());
      else if (view === 'body') code = VERILOG.generateBody(M());
      else code = ICE.iceText(M());
    } catch (e) {
      code = '// Error generating output:\n// ' + (e && e.message ? e.message : e);
    }
    $('code-out').textContent = code;
  }

  function refreshDerivedNow() {
    refreshVerilog();
    refreshProblems();
    autosave();
    checkpoint();
  }

  /* --------------------------------------------------------------------- */
  /* Dropdown menus (File / Export)                                        */
  /* --------------------------------------------------------------------- */
  function bindMenus() {
    var menus = Array.prototype.slice.call(document.querySelectorAll('.menu'));
    // "except" keeps this menu and its ancestors open, so opening a nested
    // submenu does not close its containing menu.
    function closeAll(except) {
      menus.forEach(function (m) {
        if (except && (m === except || m.contains(except))) return;
        m.querySelector('.menu-panel').hidden = true;
        m.querySelector('.menu-trigger').setAttribute('aria-expanded', 'false');
      });
    }
    menus.forEach(function (m) {
      var trigger = m.querySelector('.menu-trigger');
      var panel = m.querySelector('.menu-panel');
      trigger.addEventListener('click', function (evt) {
        evt.stopPropagation();
        var wasOpen = !panel.hidden;
        closeAll(m);
        if (!wasOpen) { panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); }
      });
      m.addEventListener('pointerenter', function () {
        var parent = m.parentElement && m.parentElement.closest('.menu');
        if (parent && !parent.querySelector('.menu-panel').hidden) {
          closeAll(m);
          panel.hidden = false;
          trigger.setAttribute('aria-expanded', 'true');
        }
      });
      // Clicking an action closes its menu after its own listener runs.
      panel.addEventListener('click', function (evt) {
        if (evt.target.tagName === 'BUTTON') closeAll();
      });
    });
    document.addEventListener('click', function () { closeAll(); });
    document.addEventListener('keydown', function (evt) { if (evt.key === 'Escape') closeAll(); });
    window.addEventListener('blur', function () { closeAll(); });
  }

  /* --------------------------------------------------------------------- */
  /* Toolbar                                                               */
  /* --------------------------------------------------------------------- */
  function newMachine() {
    if (!confirm(I18N.t('confirm.newMachine'))) return;
    var m = FSM.createMachine();
    FSM.createState(m, 240, 220, 'IDLE');
    loadMachine(m, true);
  }

  function bindToolbar() {
    $('btn-new').addEventListener('click', newMachine);
    $('btn-zoom-in').addEventListener('click', function () { EDITOR.zoomBy(1.25); });
    $('btn-zoom-out').addEventListener('click', function () { EDITOR.zoomBy(1 / 1.25); });
    $('btn-zoom-fit').addEventListener('click', function () { EDITOR.fit(); });

    var modeButtons = {
      addState: $('mode-state'),
      addTransition: $('mode-transition')
    };
    Object.keys(modeButtons).forEach(function (mode) {
      modeButtons[mode].addEventListener('click', function () { EDITOR.setMode(mode); syncModeButtons(); });
    });
    syncModeButtons = function () {
      var cur = EDITOR.getMode();
      Object.keys(modeButtons).forEach(function (mode) {
        modeButtons[mode].classList.toggle('active', mode === cur);
      });
    };
    syncModeButtons();

    $('btn-add-input').addEventListener('click', function () {
      FSM.createPort(M(), 'input'); refreshPortsPanel(); refreshDerivedNow();
    });
    $('btn-add-output').addEventListener('click', function () {
      FSM.createPort(M(), 'output'); refreshPortsPanel(); refreshDerivedNow();
    });

    $('btn-save').addEventListener('click', function () {
      download(safe(M().name) + '.fsm', FSM.serialize(M()), 'application/json');
    });
    $('btn-load').addEventListener('click', function () { $('file-input').click(); });
    $('file-input').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          loadMachine(FSM.deserialize(String(rd.result)), true);
        } catch (e) {
          alert(I18N.t('error.readFile', { msg: e && e.message ? e.message : e }));
        }
      };
      rd.readAsText(f);
      this.value = '';
    });

    $('btn-import-v').addEventListener('click', function () { $('file-input-v').click(); });
    $('file-input-v').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var m = VIMPORT.parseModule(String(rd.result));
          loadMachine(m, true);
        } catch (e) {
          alert(I18N.t('error.importV', { msg: e && e.message ? e.message : e }));
        }
      };
      rd.readAsText(f);
      this.value = '';
    });

    $('btn-undo').addEventListener('click', undo);
    $('btn-redo').addEventListener('click', redo);
    $('btn-help').addEventListener('click', openHelpDialog);
    var inspector = $('inspector');
    $('btn-toggle-inspector').addEventListener('click', function () {
      document.body.classList.toggle('inspector-hidden');
      localStorage.setItem('fsm-editor:inspector-hidden', document.body.classList.contains('inspector-hidden') ? '1' : '0');
    });
    $('inspector-resizer').addEventListener('pointerdown', function (evt) {
      var startX = evt.clientX, startWidth = inspector.getBoundingClientRect().width;
      document.body.classList.add('resizing-inspector');
      function move(e) { inspector.style.width = Math.max(260, Math.min(720, startWidth + startX - e.clientX)) + 'px'; }
      function up() {
        document.body.classList.remove('resizing-inspector');
        localStorage.setItem('fsm-editor:inspector-width', inspector.style.width);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    $('btn-export-v').addEventListener('click', function () {
      download(safe(M().name) + '.v', VERILOG.generateModule(M()), 'text/plain');
    });
    $('btn-export-body').addEventListener('click', function () {
      download(safe(M().name) + '_body.v', VERILOG.generateBody(M()), 'text/plain');
    });
    $('btn-export-ice').addEventListener('click', function () {
      download(safe(M().name) + '.ice', ICE.iceText(M()), 'application/json');
    });

    $('code-view').addEventListener('change', refreshVerilog);
    $('btn-copy').addEventListener('click', function () { copyText($('code-out').textContent); });

    // Inspector tabs
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (o) { o.classList.remove('active'); });
        document.querySelectorAll('.tab-panel').forEach(function (o) { o.classList.remove('active'); });
        tab.classList.add('active');
        $(tab.getAttribute('data-panel')).classList.add('active');
      });
    });
  }

  function safe(name) { return String(name || 'fsm').replace(/[^A-Za-z0-9_.-]/g, '_'); }

  /* --------------------------------------------------------------------- */
  /* Duplicate selected item (Ctrl+D)                                      */
  /* --------------------------------------------------------------------- */
  function duplicateSelection() {
    var sel = EDITOR.getSelection();
    if (!sel) return;
    var m = M();
    if (sel.kind === 'state') {
      var s = FSM.getState(m, sel.id);
      if (!s) return;
      var ns = FSM.createState(m, s.x + 36, s.y + 36);
      ns.outputs = JSON.parse(JSON.stringify(s.outputs || {}));
      ns.radius = s.radius;
      ns.dcUndefined = s.dcUndefined;
      EDITOR.render(); refreshAll(); refreshDerivedNow();
      EDITOR.setSelection({ kind: 'state', id: ns.id });
    } else {
      var t = FSM.getTransition(m, sel.id);
      if (!t) return;
      var nt = FSM.createTransition(m, t.from, t.to, t.cond);
      nt.outputs = JSON.parse(JSON.stringify(t.outputs || {}));
      nt.dcUndefined = t.dcUndefined;
      EDITOR.render(); refreshAll(); refreshDerivedNow();
      EDITOR.setSelection({ kind: 'transition', id: nt.id });
    }
  }

  /* --------------------------------------------------------------------- */
  /* Global keyboard shortcuts                                             */
  /* --------------------------------------------------------------------- */
  function openShortcutsDialog() {
    var groups = [
      [I18N.t('shortcuts.general'), [
        ['Ctrl+Z', I18N.t('sc.undo')],
        ['Ctrl+Y  ·  Ctrl+Shift+Z', I18N.t('sc.redo')],
        ['Ctrl+S', I18N.t('menu.save')],
        ['Ctrl+O', I18N.t('menu.load')],
        ['Ctrl+N', I18N.t('sc.new')]
      ]],
      [I18N.t('shortcuts.selection'), [
        ['Enter', I18N.t('sc.edit')],
        ['Supr  ·  Retroceso', I18N.t('sc.delete')],
        ['Ctrl+D', I18N.t('sc.duplicate')],
        ['Escape', I18N.t('sc.escape')]
      ]],
      [I18N.t('shortcuts.canvas'), [
        [I18N.t('sc.dragState'), I18N.t('sc.move')],
        [I18N.t('sc.dragEdge'), I18N.t('sc.connect')],
        [I18N.t('sc.dragLine'), I18N.t('sc.curve')],
        [I18N.t('sc.wheel'), I18N.t('sc.zoom')],
        ['S  ·  T  ·  V', I18N.t('sc.mode')]
      ]]
    ];
    var rows = [];
    groups.forEach(function (g) {
      rows.push({ el: h('h4', { text: g[0] }) });
      var ul = h('ul', { style: 'margin:0 0 4px;padding-left:18px' });
      g[1].forEach(function (item) {
        ul.appendChild(h('li', {}, [h('b', { text: item[0] }), h('span', { text: '  —  ' + item[1] })]));
      });
      rows.push({ el: ul });
    });
    modal(I18N.t('shortcuts.title'), rows, function () {}, {});
  }

  /* --------------------------------------------------------------------- */
  /* Help: editor usage and Moore vs. Mealy                                */
  /* --------------------------------------------------------------------- */
  function openHelpDialog() {
    var rows = [];
    rows.push({ el: h('h4', { text: I18N.t('help.tabUse') }) });
    var ul = h('ul', { style: 'margin:0 0 4px;padding-left:18px' });
    for (var i = 1; i <= 7; i += 1) ul.appendChild(h('li', { text: I18N.t('help.use.' + i) }));
    rows.push({ el: ul });
    rows.push({ el: h('h4', { text: I18N.t('help.tabMoore') }) });
    [1, 2, 3].forEach(function (i) {
      rows.push({ el: h('p', { style: 'margin:0 0 8px;line-height:1.5', text: I18N.t('help.moore.' + i) }) });
    });
    modal(I18N.t('help.title'), rows, function () {}, { wide: true });
  }

  /* --------------------------------------------------------------------- */
  /* Load-example submenu                                                  */
  /* --------------------------------------------------------------------- */
  function populateExamplesMenu() {
    var panel = $('menu-examples-panel');
    clearEl(panel);
    FSM.EXAMPLES.forEach(function (ex) {
      panel.appendChild(h('button', {
        role: 'menuitem',
        text: I18N.t('example.' + ex.id) || ex.label,
        onclick: function () { loadMachine(FSM.exampleMachine(ex.id), true); }
      }));
    });
  }

  /* --------------------------------------------------------------------- */
  /* Language                                                              */
  /* --------------------------------------------------------------------- */
  function applyI18n() {
    document.documentElement.lang = I18N.getLang();
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = I18N.t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.setAttribute('title', I18N.t(el.getAttribute('data-i18n-title')));
    });
    populateExamplesMenu();
    if (store.m) refreshAll();
  }

  function bindLangSelector() {
    var sel = $('lang-select');
    sel.value = I18N.getLang();
    sel.addEventListener('change', function () {
      I18N.setLang(sel.value);
      applyI18n();
    });
  }

  function bindShortcuts() {
    window.addEventListener('keydown', function (evt) {
      var tag = (evt.target && evt.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (document.querySelector('.modal-overlay')) return;
      var ctrl = evt.ctrlKey || evt.metaKey;
      if (ctrl && !evt.shiftKey && (evt.key === 'z' || evt.key === 'Z')) { evt.preventDefault(); undo(); return; }
      if (ctrl && ((evt.key === 'y' || evt.key === 'Y') || (evt.shiftKey && (evt.key === 'z' || evt.key === 'Z')))) {
        evt.preventDefault(); redo(); return;
      }
      if (ctrl && (evt.key === 's' || evt.key === 'S')) {
        evt.preventDefault();
        download(safe(M().name) + '.fsm', FSM.serialize(M()), 'application/json');
        return;
      }
      if (ctrl && (evt.key === 'o' || evt.key === 'O')) { evt.preventDefault(); $('file-input').click(); return; }
      if (ctrl && (evt.key === 'n' || evt.key === 'N')) { evt.preventDefault(); newMachine(); return; }
      if (ctrl && (evt.key === 'd' || evt.key === 'D')) { evt.preventDefault(); duplicateSelection(); return; }
      if (!ctrl && !evt.altKey && evt.key === '?') { openShortcutsDialog(); }
    });
  }

  /* --------------------------------------------------------------------- */
  /* Startup                                                               */
  /* --------------------------------------------------------------------- */
  function boot() {
    EDITOR.init({
      svg: $('canvas'),
      getMachine: function () { return store.m; },
      onChange: function (info) {
        if (info && info.transient) { autosave(); return; }
        refreshPortsPanel();
        refreshTransitionTable();
        refreshDerivedNow();
      },
      onModeChange: function () { syncModeButtons(); },
      onEdit: openEditor
    });

    bindModulePanel();
    bindToolbar();
    bindMenus();
    bindShortcuts();
    bindConsole();
    bindLangSelector();
    applyI18n();

    var restored = null;
    try {
      var saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) restored = FSM.deserialize(saved);
    } catch (e) { restored = null; }

    try {
      var width = localStorage.getItem('fsm-editor:inspector-width');
      if (width) $('inspector').style.width = width;
      document.body.classList.toggle('inspector-hidden', localStorage.getItem('fsm-editor:inspector-hidden') === '1');
    } catch (e) {}
    loadMachine(restored && restored.states.length ? restored : FSM.createMachine(), true);
    EDITOR.setMode('select');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
