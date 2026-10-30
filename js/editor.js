/* =========================================================================
 * editor.js - SVG canvas: draw states and transitions, move, pan, zoom and select.
 * Exposes the global `EDITOR` object.
 * ========================================================================= */
(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ARROW = 10;
  var GRID = 20;

  var state = {
    svg: null,
    viewport: null,
    layerEdges: null,
    layerNodes: null,
    layerTemp: null,
    getMachine: null,
    onChange: function () {},
    onSelect: function () {},
    onModeChange: function () {},
    view: { tx: 60, ty: 40, k: 1 },
    mode: 'select',                 // select | addState | addTransition
    selection: null,                // {kind:'state'|'transition', id}
    drag: null,                     // internal state of the active drag
    phys: { v: {} },                // curve-physics velocities
    hold: null,                     // valores fijados por untangle (o null)
    sig: '', untangled: false, physFrame: 0, physFrames: 0, loopAng: null
  };

  /* --------------------------------------------------------------------- */
  /* DOM and geometry helpers                                              */
  /* --------------------------------------------------------------------- */
  function el(tag, attrs, kids) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }
  function txt(str, attrs) {
    var t = el('text', attrs);
    t.textContent = str;
    return t;
  }
  function len(x, y) { return Math.sqrt(x * x + y * y); }
  function norm(x, y) { var l = len(x, y) || 1; return { x: x / l, y: y / l }; }

  function stateRadius(s) {
    if (s && s.radius != null && !isNaN(s.radius) && s.radius > 0) {
      return Math.max(16, Math.min(160, Number(s.radius)));
    }
    return Math.max(34, Math.min(74, 30 + String(s.name).length * 3.6));
  }

  function machine() { return state.getMachine(); }

  function worldPoint(evt) {
    var r = state.svg.getBoundingClientRect();
    var v = state.view;
    return {
      x: (evt.clientX - r.left - v.tx) / v.k,
      y: (evt.clientY - r.top - v.ty) / v.k
    };
  }

  var renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    var raf = global.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () { renderScheduled = false; render(); });
  }

  function applyView() {
    var v = state.view;
    state.viewport.setAttribute('transform', 'translate(' + v.tx + ',' + v.ty + ') scale(' + v.k + ')');
  }

  /* Zoom while keeping screen point (px, py) fixed.
     (el que esta bajo el cursor en la rueda, o el centro del lienzo en los
     botones +/- del widget de navegacion). */
  function zoomAt(px, py, factor) {
    var v = state.view;
    var nk = Math.max(0.2, Math.min(3, v.k * factor));
    v.tx = px - (px - v.tx) * (nk / v.k);
    v.ty = py - (py - v.ty) * (nk / v.k);
    v.k = nk;
    applyView();
  }
  function zoomBy(factor) {
    var r = state.svg.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, factor);
  }

  /* --------------------------------------------------------------------- */
  /* Initialization                                                        */
  /* --------------------------------------------------------------------- */
  function init(opts) {
    state.svg = opts.svg;
    state.getMachine = opts.getMachine;
    state.onChange = opts.onChange || state.onChange;
    state.onSelect = opts.onSelect || state.onSelect;
    state.onModeChange = opts.onModeChange || state.onModeChange;
    state.onEdit = opts.onEdit || function () {};   // double-click -> open dialog

    state.svg.innerHTML = '';
    var defs = el('defs');
    var pat = el('pattern', { id: 'grid', width: GRID, height: GRID, patternUnits: 'userSpaceOnUse' });
    pat.appendChild(el('path', { d: 'M ' + GRID + ' 0 L 0 0 0 ' + GRID, fill: 'none', stroke: 'rgba(120,130,150,.15)', 'stroke-width': 1 }));
    defs.appendChild(pat);
    state.svg.appendChild(defs);

    state.viewport = el('g', { id: 'viewport' });
    state.svg.appendChild(state.viewport);

    state.viewport.appendChild(el('rect', {
      x: -8000, y: -8000, width: 16000, height: 16000, fill: 'url(#grid)', class: 'grid-bg'
    }));
    state.layerEdges = el('g', { class: 'layer-edges' });
    state.layerNodes = el('g', { class: 'layer-nodes' });
    state.layerTemp = el('g', { class: 'layer-temp' });
    state.viewport.appendChild(state.layerEdges);
    state.viewport.appendChild(state.layerNodes);
    state.viewport.appendChild(state.layerTemp);

    applyView();
    wireEvents();
    render();
  }

  /* --------------------------------------------------------------------- */
  /* Render                                                                */
  /* --------------------------------------------------------------------- */
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* --------------------------------------------------------------------- */
  /* Animated curve physics (physics.js). */
  /* --------------------------------------------------------------------- */
  function physInput(m) {
    return {
      states: m.states.map(function (s) { return { id: s.id, x: s.x, y: s.y, r: stateRadius(s) }; }),
      trans: m.transitions.map(function (t) {
        return { id: t.id, from: t.from, to: t.to, curve: t.curve || 0, auto: t.auto !== false, loopAngle: t.loopAngle };
      }),
      initial: m.initial
    };
  }

  /* Signature of the state, connections and manual values requiring recalculation.
     Las curvas AUTOMATICAS no cuentan (las mueve la propia fisica). */
  function layoutSignature(m) {
    var parts = [];
    m.states.forEach(function (s) { parts.push(s.id + ':' + s.x + ',' + s.y + ',' + stateRadius(s)); });
    m.transitions.forEach(function (t) {
      parts.push(t.id + ':' + t.from + '>' + t.to + (t.auto === false ? '!' + (t.curve || 0) + ',' + (t.loopAngle == null ? '' : t.loopAngle) : ''));
    });
    parts.push(m.initial || '');
    return parts.join('|');
  }

  var PHYS_STEPS = 100, PHYS_MAX_FRAMES = 300;

  function wakePhysics() {
    if (state.physFrame) return;
    state.physFrames = 0;
    var raf = global.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    state.physFrame = raf(tickPhysics);
  }

  function tickPhysics() {
    state.physFrame = 0;
    var m = machine();
    if (!m || !m.transitions.length) return;
    var input = physInput(m);
    input.hold = state.hold;
    var res = PHYS.step(input, state.phys, PHYS_STEPS);
    m.transitions.forEach(function (t) {
      if (res.curves[t.id] != null) t.curve = res.curves[t.id];
    });
    state.loopAng = res.loops;
    drawEdges(m);
    state.onChange({ transient: true });

    state.physFrames += 1;
    var again = !res.settled && state.physFrames < PHYS_MAX_FRAMES;
    if (res.settled && !state.hold && !state.untangled) {
      // Once physics settles, fix values that avoid remaining crossings and let
      // curves approach them smoothly.
      state.untangled = true;
      var inp2 = physInput(m);
      var u = PHYS.untangle({ states: inp2.states, trans: inp2.trans }, res.curves);
      if (u.changed) { state.hold = u.values; again = true; }
    }
    if (again) {
      var raf = global.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
      state.physFrame = raf(tickPhysics);
    }
  }

  function render() {
    var m = machine();
    if (!m) return;
    var sig = layoutSignature(m);
    if (sig !== state.sig) {                   // algo cambio: se recalcula todo
      state.sig = sig;
      state.hold = null;
      state.untangled = false;
      state.phys = { v: {} };
      wakePhysics();
    }
    draw(m);
  }

  /* Lines only: physics moves only these, so states are not affected.
     recrean en cada fotograma (siguen siendo el mismo elemento bajo el raton). */
  function drawEdges(m) {
    clear(state.layerEdges);
    if (!state.loopAng) state.loopAng = PHYS.loopAngles(physInput(m));
    m.transitions.forEach(function (t) { drawEdge(m, t); });
  }

  function draw(m) {
    drawEdges(m);
    clear(state.layerNodes);
    m.states.forEach(function (s) { drawNode(m, s); });
  }

  function outputsLabel(map) {
    var keys = Object.keys(map || {});
    if (!keys.length) return '';
    return keys.map(function (k) { return k + '=' + map[k]; }).join(', ');
  }

  function drawNode(m, s) {
    var r = stateRadius(s);
    var g = el('g', {
      class: 'state' + (isSelected('state', s.id) ? ' selected' : '') + (m.initial === s.id ? ' initial' : ''),
      transform: 'translate(' + s.x + ',' + s.y + ')',
      'data-id': s.id
    });

    if (m.initial === s.id) {
      // Initial-state marker: a small triangle pointing at the state boundary.
      var xTip = -r - 2;
      g.appendChild(el('path', {
        class: 'init-head',
        d: 'M ' + xTip + ' 0 L ' + (xTip - 13) + ' -7 L ' + (xTip - 13) + ' 7 Z'
      }));
    }

    g.appendChild(el('circle', { class: 'body', r: r }));
    // Halo: an outer ring that captures pointer events. Dragging it creates a
    // transition; dragging inside a state moves it.
    g.appendChild(el('circle', { class: 'halo', r: r }));

    var mooreTxt = outputsLabel(s.outputs);
    g.appendChild(txt(s.name, { class: 'name', 'text-anchor': 'middle', y: mooreTxt ? -2 : 5 }));
    if (mooreTxt) g.appendChild(txt(mooreTxt, { class: 'moore', 'text-anchor': 'middle', y: 15 }));

    state.layerNodes.appendChild(g);
  }

  function edgeLabelText(m, t) {
    var cond = String(t.cond).trim();
    var base = cond;
    var outs = outputsLabel(t.outputs);
    return base && outs ? (base + ' / ' + outs) : (base || outs);
  }

  /* Transition geometry, entirely in world coordinates:
     - entre dos estados: UNA cuadratica que pasa por el punto guia;
       el punto guia se guarda como `curve` (desplazamiento perpendicular).
     - auto-transicion: bucle cubico en la direccion `loopAng`. */
  function edgeGeom(m, t) {
    var A = FSM.getState(m, t.from);
    var B = FSM.getState(m, t.to);
    if (!A || !B) return null;
    var rA = stateRadius(A), rB = stateRadius(B);

    if (t.from === t.to) {
      var deg = state.loopAng && state.loopAng[t.id] != null ? state.loopAng[t.id] : (t.loopAngle == null ? -90 : t.loopAngle);
      var ang = deg * Math.PI / 180;
      var spread = 0.5;
      var sa = ang - spread, ea = ang + spread;
      var s0 = { x: A.x + rA * Math.cos(sa), y: A.y + rA * Math.sin(sa) };
      var e0 = { x: A.x + rA * Math.cos(ea), y: A.y + rA * Math.sin(ea) };
      var cd = rA * 2.7;
      var c1 = { x: A.x + cd * Math.cos(sa), y: A.y + cd * Math.sin(sa) };
      var c2 = { x: A.x + cd * Math.cos(ea), y: A.y + cd * Math.sin(ea) };
      return {
        loop: true, A: A, B: B,
        d: 'M ' + s0.x + ' ' + s0.y + ' C ' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + e0.x + ' ' + e0.y,
        tip: e0,
        tipAngle: Math.atan2(e0.y - c2.y, e0.x - c2.x),
        labelPos: { x: A.x + (rA + cd) * 0.60 * Math.cos(ang), y: A.y + (rA + cd) * 0.60 * Math.sin(ang) },
        handle: { x: A.x + (rA + cd) * 0.5 * Math.cos(ang), y: A.y + (rA + cd) * 0.5 * Math.sin(ang) }
      };
    }

    var arc = PHYS.arc({ x: A.x, y: A.y, r: rA }, { x: B.x, y: B.y, r: rB }, t.curve || 0);
    if (!arc) return null;                                   // two states at the same point
    var cut = PHYS.arcTrimmed(arc, ARROW - 1);          // same curve, ending before the arrowhead
    var d = cut.circle
      ? 'M ' + arc.start.x + ' ' + arc.start.y + ' A ' + cut.circle.r + ' ' + cut.circle.r +
        ' 0 ' + cut.largeArc + ' ' + cut.sweep + ' ' + cut.end.x + ' ' + cut.end.y
      : 'M ' + arc.start.x + ' ' + arc.start.y + ' L ' + cut.end.x + ' ' + cut.end.y;
    // If the curve lies below (or above) both states, move the label outward.
    var shift = (A.y < arc.pos.y && B.y < arc.pos.y) ? 8 : ((A.y > arc.pos.y && B.y > arc.pos.y) ? -8 : 0);
    return {
      loop: false, A: A, B: B,
      d: d,
      tip: arc.end,
      tipAngle: Math.atan2(cut.tangent.y, cut.tangent.x),
      labelPos: { x: arc.pos.x, y: arc.pos.y + shift },
      handle: arc.pos    // guide point: the blue handle appears here when selected
    };
  }

  function drawEdge(m, t) {
    var G = edgeGeom(m, t);
    if (!G) return;
    var d = G.d, tip = G.tip, tipAngle = G.tipAngle, labelPos = G.labelPos;
    var selected = isSelected('transition', t.id);

    var g = el('g', {
      class: 'edge' + (selected ? ' selected' : ''),
      'data-id': t.id
    });
    g.appendChild(el('path', { class: 'hit', d: d, fill: 'none' }));
    g.appendChild(el('path', { class: 'line', d: d, fill: 'none' }));

    var ax = tip.x, ay = tip.y;
    var a1 = tipAngle + Math.PI - 0.4;
    var a2 = tipAngle + Math.PI + 0.4;
    g.appendChild(el('path', {
      class: 'head',
      d: 'M ' + ax + ' ' + ay +
        ' L ' + (ax + ARROW * Math.cos(a1)) + ' ' + (ay + ARROW * Math.sin(a1)) +
        ' L ' + (ax + ARROW * Math.cos(a2)) + ' ' + (ay + ARROW * Math.sin(a2)) + ' Z'
    }));

    var label = edgeLabelText(m, t);
    var tnode = txt(label, { class: 'edge-label', 'text-anchor': 'middle', x: labelPos.x, y: labelPos.y + 4 });
    var bg = el('rect', { class: 'edge-label-bg' });
    g.appendChild(bg);
    g.appendChild(tnode);
    state.layerEdges.appendChild(g);
    // Size the text background after insertion.
    try {
      var bb = tnode.getBBox();
      bg.setAttribute('x', bb.x - 4);
      bg.setAttribute('y', bb.y - 2);
      bg.setAttribute('width', bb.width + 8);
      bg.setAttribute('height', bb.height + 4);
    } catch (e) { /* getBBox may fail when the SVG is not visible */ }
  }

  /* --------------------------------------------------------------------- */
  /* Selection                                                             */
  /* --------------------------------------------------------------------- */
  function isSelected(kind, id) {
    return state.selection && state.selection.kind === kind && state.selection.id === id;
  }
  function setSelection(sel) {
    state.selection = sel;
    render();
    state.onSelect(sel);
  }
  function getSelection() { return state.selection; }

  /* --------------------------------------------------------------------- */
  /* Mode                                                                  */
  /* --------------------------------------------------------------------- */
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    state.svg.setAttribute('data-mode', mode);
    state.onModeChange(mode);
  }
  function getMode() { return state.mode; }

  /* --------------------------------------------------------------------- */
  /* Events                                                                */
  /* --------------------------------------------------------------------- */
  function ancestorWithClass(n, cls) {
    while (n && n !== state.svg) {
      if (n.classList && n.classList.contains(cls)) return n;
      n = n.parentNode;
    }
    return null;
  }
  function nodeElFromEvent(evt) {
    return ancestorWithClass(evt.target, 'state');
  }
  /* Con captura de puntero activa evt.target siempre es el <svg>; para saber
     sobre que estado esta el cursor hay que consultar por coordenadas. */
  function nodeElFromPoint(evt) {
    return ancestorWithClass(document.elementFromPoint(evt.clientX, evt.clientY), 'state');
  }
  function edgeElFromEvent(evt) {
    return ancestorWithClass(evt.target, 'edge');
  }

  function wireEvents() {
    var svg = state.svg;

    svg.addEventListener('pointerdown', function (evt) {
      if (evt.button !== 0) return;
      var m = machine();
      var nodeEl = nodeElFromEvent(evt);
      var edgeEl = edgeElFromEvent(evt);
      var wp = worldPoint(evt);

      // Deteccion manual de doble clic sobre estado/transicion: el render() que
      // dispara la seleccion sustituye los nodos del DOM, asi que el evento
      // nativo `dblclick` no llega. Con dos CLICS (sin arrastre de por medio)
      // sobre el mismo id en menos de 450 ms, abrimos el dialogo.
      var hitId = nodeEl ? nodeEl.getAttribute('data-id') : (edgeEl ? edgeEl.getAttribute('data-id') : null);
      if (hitId && state._lastClick && state._lastClick.id === hitId && (Date.now() - state._lastClick.t) < 450) {
        state._lastClick = null;
        state.onEdit({ kind: nodeEl ? 'state' : 'transition', id: hitId });
        return;
      }
      if (!nodeEl) {
        // clic en una transicion (sin ambiguedad de arrastre) o en el fondo:
        // se arma (o se cancela) aqui mismo. Para un ESTADO se decide en
        // endDrag() -- solo si termina siendo un clic limpio, no si lo mueve
        // o si arrastra una conexion nueva desde el (si no, mover un estado y
        // enseguida arrastrar otra conexion desde el se confundia con un
        // doble clic y abria el dialogo en vez de conectar).
        state._lastClick = edgeEl ? { id: hitId, t: Date.now() } : null;
      }

      if (nodeEl) {
        var sid = nodeEl.getAttribute('data-id');
        setSelection({ kind: 'state', id: sid });
        // Crear transicion: en modo "+ Transicion", con Shift, o arrastrando
        // desde el borde exterior del estado (el anillo "halo").
        var onRim = evt.target.classList && evt.target.classList.contains('halo');
        var linking = (state.mode === 'addTransition') || evt.shiftKey || onRim;
        if (linking) {
          var line = el('path', { class: 'temp-link', d: '', fill: 'none' });
          state.layerTemp.appendChild(line);
          state.drag = { type: 'link', from: sid, line: line };
        } else {
          var st = FSM.getState(m, sid);
          state.drag = { type: 'move', id: sid, dx: wp.x - st.x, dy: wp.y - st.y, moved: false };
        }
        svg.setPointerCapture(evt.pointerId);
        return;
      }

      if (edgeEl) {
        var eid = edgeEl.getAttribute('data-id');
        setSelection({ kind: 'transition', id: eid });
      // Dragging a line moves its guide point. It counts only after a small move.
        state.drag = { type: 'curve', id: eid, moved: false, sx: evt.clientX, sy: evt.clientY };
        svg.setPointerCapture(evt.pointerId);
        return;
      }

      // Canvas background
      if (state.mode === 'addState') {
        var ns = FSM.createState(m, wp.x, wp.y);
        setMode('select');
        commit();
        setSelection({ kind: 'state', id: ns.id });
        state.onEdit({ kind: 'state', id: ns.id, isNew: true });
        return;
      }
      setSelection(null);
      state.drag = {
        type: 'pan',
        sx: evt.clientX, sy: evt.clientY,
        tx: state.view.tx, ty: state.view.ty
      };
      svg.setPointerCapture(evt.pointerId);
    });

    svg.addEventListener('pointermove', function (evt) {
      var d = state.drag;
      if (!d) return;
      var wp = worldPoint(evt);
      if (d.type === 'pan') {
        state.view.tx = d.tx + (evt.clientX - d.sx);
        state.view.ty = d.ty + (evt.clientY - d.sy);
        applyView();
      } else if (d.type === 'move') {
        var st = FSM.getState(machine(), d.id);
        if (!st) return;
        var nx = wp.x - d.dx, ny = wp.y - d.dy;
        if (!evt.altKey) { nx = Math.round(nx / GRID) * GRID; ny = Math.round(ny / GRID) * GRID; }
        st.x = nx; st.y = ny;
        d.moved = true;
        scheduleRender();
        state.onChange({ transient: true });
      } else if (d.type === 'curve') {
        if (!d.moved && Math.abs(evt.clientX - d.sx) + Math.abs(evt.clientY - d.sy) < 4) return;
        var mm = machine(), tc = FSM.getTransition(mm, d.id);
        if (!tc) return;
        var A = FSM.getState(mm, tc.from), B = FSM.getState(mm, tc.to);
        if (!A || !B) return;
        if (tc.from === tc.to) {
          tc.loopAngle = Math.round(Math.atan2(wp.y - A.y, wp.x - A.x) * 180 / Math.PI);
        } else {
          tc.curve = Math.round(PHYS.curveFromPoint({ x: A.x, y: A.y, r: stateRadius(A) }, { x: B.x, y: B.y, r: stateRadius(B) }, wp));
        }
        tc.auto = false;                    // fijada a mano: la fisica ya no la mueve
        d.moved = true;
        scheduleRender();
        state.onChange({ transient: true });
      } else if (d.type === 'link') {
        var from = FSM.getState(machine(), d.from);
        d.line.setAttribute('d', 'M ' + from.x + ' ' + from.y + ' L ' + wp.x + ' ' + wp.y);
        highlightHover(nodeElFromPoint(evt));
      }
    });

    function endDrag(evt) {
      var d = state.drag;
      state.drag = null;
      try { state.svg.releasePointerCapture(evt.pointerId); } catch (e) {}
      if (!d) return;
      if ((d.type === 'move' || d.type === 'curve') && d.moved) commit();
      if (d.type === 'move') {
        // clic limpio (sin arrastre real) sobre un estado: arma el posible
        // doble clic para la proxima vez que se pulse sobre el mismo estado
        state._lastClick = d.moved ? null : { id: d.id, t: Date.now() };
      }
      if (d.type === 'link') {
        clear(state.layerTemp);
        highlightHover(null);
        // sin boton "Seleccionar": el modo "+ Transicion" es temporal, vuelve
        // solo al soltar (haya o no conectado con otro estado)
        if (state.mode === 'addTransition') setMode('select');
        var hov = nodeElFromPoint(evt);
        if (hov) {
          var toId = hov.getAttribute('data-id');
          var tr = FSM.createTransition(machine(), d.from, toId, '');
          commit();
          setSelection({ kind: 'transition', id: tr.id });
          // abre el dialogo para poner la condicion recien creada
          state.onEdit({ kind: 'transition', id: tr.id, isNew: true });
        }
      }
    }
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    svg.addEventListener('dblclick', function (evt) {
      var m = machine();
      // estado / transicion se gestionan en pointerdown (deteccion manual);
      // aqui solo queda el doble clic en el fondo -> nuevo estado.
      if (nodeElFromEvent(evt) || edgeElFromEvent(evt)) return;
      var wp = worldPoint(evt);
      var ns = FSM.createState(m, wp.x, wp.y);
      commit();
      setSelection({ kind: 'state', id: ns.id });
      state.onEdit({ kind: 'state', id: ns.id, isNew: true });
    });

    svg.addEventListener('wheel', function (evt) {
      evt.preventDefault();
      var r = state.svg.getBoundingClientRect();
      zoomAt(evt.clientX - r.left, evt.clientY - r.top, evt.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    window.addEventListener('keydown', function (evt) {
      var tag = (evt.target && evt.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      // los atajos con Ctrl/Cmd/Alt son del documento (deshacer, guardar...),
      // no del lienzo: aqui solo se manejan teclas sueltas.
      if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
      if (evt.key === 'Enter') {
        if (state.selection) { state.onEdit(state.selection); evt.preventDefault(); }
      } else if (evt.key === 'Delete' || evt.key === 'Backspace') {
        deleteSelection();
        evt.preventDefault();
      } else if (evt.key === 'Escape') {
        setMode('select');
        clear(state.layerTemp);
        state.drag = null;
        setSelection(null);
      } else if (evt.key === 's' || evt.key === 'S') {
        setMode('addState');
      } else if (evt.key === 't' || evt.key === 'T') {
        setMode('addTransition');
      } else if (evt.key === 'v' || evt.key === 'V') {
        setMode('select');
      }
    });
  }

  function highlightHover(nodeEl) {
    Array.prototype.forEach.call(state.layerNodes.querySelectorAll('.state.hover'), function (n) {
      n.classList.remove('hover');
    });
    if (nodeEl) nodeEl.classList.add('hover');
  }

  function deleteSelection() {
    var sel = state.selection;
    if (!sel) return;
    var m = machine();
    if (sel.kind === 'state') FSM.deleteState(m, sel.id);
    else FSM.deleteTransition(m, sel.id);
    setSelection(null);
    commit();
  }

  function commit() {
    render();
    state.onChange({ transient: false });
  }

  /* --------------------------------------------------------------------- */
  /* Fit to view                                                           */
  /* --------------------------------------------------------------------- */
  function fit() {
    var m = machine();
    if (!m || !m.states.length) { state.view = { tx: 60, ty: 40, k: 1 }; applyView(); return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    m.states.forEach(function (s) {
      var r = stateRadius(s) + 30;
      // el triangulito de estado inicial sobresale ~16px por la izquierda
      var left = s.id === m.initial ? r + 22 : r;
      minX = Math.min(minX, s.x - left); minY = Math.min(minY, s.y - r);
      maxX = Math.max(maxX, s.x + r); maxY = Math.max(maxY, s.y + r);
    });
    var rect = state.svg.getBoundingClientRect();
    var kx = rect.width / (maxX - minX);
    var ky = rect.height / (maxY - minY);
    var k = Math.max(0.2, Math.min(1.6, Math.min(kx, ky)));
    state.view.k = k;
    state.view.tx = (rect.width - (maxX + minX) * k) / 2;
    state.view.ty = (rect.height - (maxY + minY) * k) / 2;
    applyView();
  }

  global.EDITOR = {
    init: init,
    render: render,
    setSelection: setSelection,
    getSelection: getSelection,
    setMode: setMode,
    getMode: getMode,
    deleteSelection: deleteSelection,
    fit: fit,
    zoomBy: zoomBy
  };
}(window));
