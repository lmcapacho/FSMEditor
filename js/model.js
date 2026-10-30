/* =========================================================================
 * model.js - Finite-state-machine data model.
 * Classic script without modules so index.html works through file://.
 * Exposes the global `FSM` object.
 * ========================================================================= */
(function (global) {
  'use strict';

  var DEFAULT_CURVE = 20;   // initial transition bend (perpendicular px); physics settles it

  /* Bits required to encode `count` states with the requested encoding. */
  function stateBits(count, encoding) {
    if (encoding === 'onehot') return Math.max(1, count);
    var b = 1;
    while ((1 << b) < count) b += 1;
    return Math.max(1, b);
  }

  var uidCounter = 0;
  function uid(prefix) {
    uidCounter += 1;
    return prefix + '_' + uidCounter.toString(36) + Date.now().toString(36).slice(-4);
  }

  /* --- Verilog-2001 reserved words -------------------------------------- */
  var KEYWORDS = ('always and assign automatic begin buf bufif0 bufif1 case casex casez cell cmos ' +
    'config deassign default defparam design disable edge else end endcase endconfig endfunction ' +
    'endgenerate endmodule endprimitive endspecify endtable endtask event for force forever fork ' +
    'function generate genvar highz0 highz1 if ifnone incdir include initial inout input instance ' +
    'integer join large liblist library localparam macromodule medium module nand negedge nmos nor ' +
    'noshowcancelled not notif0 notif1 or output parameter pmos posedge primitive pull0 pull1 ' +
    'pulldown pullup rcmos real realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1 ' +
    'scalared showcancelled signed small specify specparam strong0 strong1 supply0 supply1 table ' +
    'task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg unsigned use vectored wait ' +
    'wand weak0 weak1 while wire wor xnor xor localparam').split(' ');

  var KEYWORD_SET = {};
  KEYWORDS.forEach(function (k) { KEYWORD_SET[k] = true; });

  var IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  function isIdentifier(name) {
    return IDENT_RE.test(String(name || '')) && !KEYWORD_SET[name];
  }

  function sanitizeIdentifier(name, fallback) {
    var s = String(name == null ? '' : name)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')   // remove accents
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/^_+(?=[0-9])/, 'n_');
    if (!/^[A-Za-z_]/.test(s)) s = 'n_' + s;
    if (KEYWORD_SET[s]) s = s + '_s';
    return s || fallback || 'x';
  }

  /* ----------------------------------------------------------------------- */
  /* Constructors                                                            */
  /* ----------------------------------------------------------------------- */

  function createMachine() {
    return {
      version: 1,
      name: 'fsm',
      clock: 'clk',
      reset: 'rst',
      resetActiveLow: false,
      resetSync: false,
      encoding: 'binary',        // binary | gray | onehot
      inputs: [],                // {id, name, width}
      outputs: [],               // {id, name, width, def}
      states: [],                // {id, name, x, y, outputs:{}, comment}
      transitions: [],           // {id, from, to, cond, outputs:{}, curve, loopAngle, comment}
      initial: null              // initial/reset state ID
    };
  }

  function uniqueStateName(machine) {
    var i = 0, name;
    do {
      name = (machine.states.length === 0 && i === 0) ? 'IDLE' : 'S' + i;
      i += 1;
    } while (machine.states.some(function (s) { return s.name === name; }));
    return name;
  }

  function createState(machine, x, y, name) {
    var st = {
      id: uid('st'),
      name: name || uniqueStateName(machine),
      x: Math.round(x),
      y: Math.round(y),
      outputs: {},
      code: null,            // forced state code (int), or null = automatic
      radius: null,          // circle radius (px), or null = automatic
      dcUndefined: false,    // unassigned outputs in this state -> 'x' (don't care)
      comment: ''
    };
    machine.states.push(st);
    if (!machine.initial) machine.initial = st.id;
    return st;
  }

  function createTransition(machine, fromId, toId, cond) {
    var t = {
      id: uid('tr'),
      from: fromId,
      to: toId,
      cond: cond == null ? '' : cond,
      outputs: {},
      curve: 0,             // perpendicular offset of the curve guide point (px)
      auto: true,           // true = physics positions the curve (or loop); false = set by the user
      loopAngle: -90,
      dcUndefined: false,   // unassigned Mealy outputs on this transition -> 'x'
      comment: ''
    };
    if (fromId !== toId) {
      // Initial curve; physics.js settles it afterward. The curve normal depends
      // on direction (A->B is opposite to B->A), so equal-sign reciprocal
      // transitions start on opposite sides. Parallel transitions alternate sides.
      var same = machine.transitions.filter(function (o) { return o.from === fromId && o.to === toId; }).length;
      var mag = DEFAULT_CURVE + Math.floor(same / 2) * 25;
      t.curve = (same % 2 === 0) ? mag : -mag;
    } else {
      var loops = machine.transitions.filter(function (o) { return o.from === fromId && o.to === fromId; });
      t.loopAngle = -90 + loops.length * 50;
    }
    machine.transitions.push(t);
    return t;
  }

  function createPort(machine, kind, name) {
    var list = kind === 'input' ? machine.inputs : machine.outputs;
    var base = name || (kind === 'input' ? 'in' : 'out');
    var n = base, i = 1;
    while (list.some(function (p) { return p.name === n; })) { n = base + i; i += 1; }
    var port = { id: uid(kind === 'input' ? 'in' : 'out'), name: n, width: 1 };
    if (kind === 'output') port.def = '0';
    list.push(port);
    return port;
  }

  /* ----------------------------------------------------------------------- */
  /* Queries and mutations                                                   */
  /* ----------------------------------------------------------------------- */

  function getState(machine, id) {
    for (var i = 0; i < machine.states.length; i += 1) {
      if (machine.states[i].id === id) return machine.states[i];
    }
    return null;
  }

  function getTransition(machine, id) {
    for (var i = 0; i < machine.transitions.length; i += 1) {
      if (machine.transitions[i].id === id) return machine.transitions[i];
    }
    return null;
  }

  /* Transitions leaving a state, in priority order (array index). */
  function outgoing(machine, stateId) {
    return machine.transitions.filter(function (t) { return t.from === stateId; });
  }

  function deleteState(machine, id) {
    machine.states = machine.states.filter(function (s) { return s.id !== id; });
    machine.transitions = machine.transitions.filter(function (t) {
      return t.from !== id && t.to !== id;
    });
    if (machine.initial === id) {
      machine.initial = machine.states.length ? machine.states[0].id : null;
    }
  }

  function deleteTransition(machine, id) {
    machine.transitions = machine.transitions.filter(function (t) { return t.id !== id; });
  }

  function deletePort(machine, kind, id) {
    var key = kind === 'input' ? 'inputs' : 'outputs';
    var port = machine[key].filter(function (p) { return p.id === id; })[0];
    machine[key] = machine[key].filter(function (p) { return p.id !== id; });
    if (port && kind === 'output') {
      machine.states.forEach(function (s) { delete s.outputs[port.name]; });
      machine.transitions.forEach(function (t) { delete t.outputs[port.name]; });
    }
  }

  /* Renaming an output preserves existing assignments. */
  function renameOutput(machine, port, newName) {
    var old = port.name;
    if (old === newName) return;
    port.name = newName;
    function move(map) {
      if (Object.prototype.hasOwnProperty.call(map, old)) {
        map[newName] = map[old];
        delete map[old];
      }
    }
    machine.states.forEach(function (s) { move(s.outputs); });
    machine.transitions.forEach(function (t) { move(t.outputs); });
  }

  /* Changes a transition's priority within its source state. */
  function moveTransitionPriority(machine, id, delta) {
    var t = getTransition(machine, id);
    if (!t) return;
    var siblings = outgoing(machine, t.from);
    var pos = siblings.indexOf(t);
    var target = pos + delta;
    if (target < 0 || target >= siblings.length) return;
    var other = siblings[target];
    var ia = machine.transitions.indexOf(t);
    var ib = machine.transitions.indexOf(other);
    machine.transitions[ia] = other;
    machine.transitions[ib] = t;
  }

  /* ----------------------------------------------------------------------- */
  /* Expression analysis                                                     */
  /* ----------------------------------------------------------------------- */

  function identifiersIn(expr) {
    var out = [];
    var cleaned = String(expr || '').replace(/\b\d+\s*'\s*[bodhBODH][0-9a-fA-FxXzZ_]+/g, ' ');
    var re = /[A-Za-z_][A-Za-z0-9_]*/g;
    var m;
    while ((m = re.exec(cleaned)) !== null) {
      if (!KEYWORD_SET[m[0]] && out.indexOf(m[0]) === -1) out.push(m[0]);
    }
    return out;
  }

  function balancedParens(expr) {
    var depth = 0, s = String(expr || '');
    for (var i = 0; i < s.length; i += 1) {
      if (s[i] === '(') depth += 1;
      else if (s[i] === ')') { depth -= 1; if (depth < 0) return false; }
    }
    return depth === 0;
  }

  /* Free-form output assignments -> {name: value} map.
     Accepts "y=1, z=0" | "y1=2 done" | "run"(=1). Separators: comma or space. */
  function parseOutputs(text) {
    var map = {};
    String(text == null ? '' : text).split(/[,\s]+/).forEach(function (tok) {
      tok = tok.trim();
      if (!tok) return;
      var eq = tok.indexOf('=');
      var name = eq === -1 ? tok : tok.slice(0, eq).trim();
      var val = eq === -1 ? '1' : tok.slice(eq + 1).trim();
      if (!IDENT_RE.test(name)) return;
      map[name] = val === '' ? '1' : val;
    });
    return map;
  }

  /* {name: value} map -> "name=value, name=value" (canonical, editable). */
  function formatOutputs(map) {
    return Object.keys(map || {}).map(function (k) { return k + '=' + map[k]; }).join(', ');
  }

  /* Declares ports referenced by the machine so generated HDL stays complete. */
  function syncPortsFromUsage(machine) {
    var known = {};
    var changed = false;
    var usedInputs = {};
    var usedOutputs = {};
    known[machine.clock] = true;
    known[machine.reset] = true;
    machine.inputs.concat(machine.outputs).forEach(function (port) { known[port.name] = true; });

    machine.states.concat(machine.transitions).forEach(function (item) {
      Object.keys(item.outputs || {}).forEach(function (name) {
        if (isIdentifier(name)) usedOutputs[name] = true;
        if (!known[name] && isIdentifier(name)) {
          var output = createPort(machine, 'output', name);
          output.autoInferred = true;
          known[name] = true;
          changed = true;
        }
      });
    });
    machine.transitions.forEach(function (transition) {
      identifiersIn(transition.cond).forEach(function (name) {
        usedInputs[name] = true;
        if (!known[name]) {
          var input = createPort(machine, 'input', name);
          input.autoInferred = true;
          known[name] = true;
          changed = true;
        }
      });
    });
    machine.inputs = machine.inputs.filter(function (port) {
      if (!port.autoInferred || usedInputs[port.name]) return true;
      changed = true;
      return false;
    });
    machine.outputs = machine.outputs.filter(function (port) {
      if (!port.autoInferred || usedOutputs[port.name]) return true;
      changed = true;
      return false;
    });
    return changed;
  }

  /* ----------------------------------------------------------------------- */
  /* Validation                                                              */
  /* ----------------------------------------------------------------------- */

  function validate(machine) {
    var problems = [];
    function err(msg, ref) { problems.push({ level: 'error', msg: msg, ref: ref || null }); }
    function warn(msg, ref) { problems.push({ level: 'warn', msg: msg, ref: ref || null }); }

    if (!isIdentifier(machine.name)) err('Module name "' + machine.name + '" is not a valid Verilog identifier.');
    if (!isIdentifier(machine.clock)) err('Clock name "' + machine.clock + '" is not valid.');
    if (!isIdentifier(machine.reset)) err('Reset name "' + machine.reset + '" is not valid.');

    if (machine.states.length === 0) {
      warn('The machine has no states.');
      return problems;
    }
    if (!machine.initial || !getState(machine, machine.initial)) {
      err('No initial state is defined (mark one as the initial state).');
    }

    var seen = {};
    var seenCode = {};
    var maxCode = machine.encoding === 'onehot'
      ? machine.states.length - 1
      : Math.pow(2, stateBits(machine.states.length, machine.encoding)) - 1;
    machine.states.forEach(function (s) {
      if (!isIdentifier(s.name)) err('State "' + s.name + '" is not a valid identifier.', { kind: 'state', id: s.id });
      if (seen[s.name]) err('Duplicate state name: "' + s.name + '".', { kind: 'state', id: s.id });
      seen[s.name] = true;
      if (s.code != null) {
        if (s.code < 0 || (machine.encoding !== 'onehot' && s.code > maxCode)) {
          err('State code ' + s.code + ' for "' + s.name + '" does not fit the current encoding.', { kind: 'state', id: s.id });
        }
        if (seenCode[s.code] != null) {
          err('Duplicate state code (' + s.code + ') in "' + seenCode[s.code] + '" and "' + s.name + '".', { kind: 'state', id: s.id });
        }
        seenCode[s.code] = s.name;
      }
    });

    var ports = {};
    ports[machine.clock] = 'clock';
    ports[machine.reset] = 'reset';
    machine.inputs.concat(machine.outputs).forEach(function (p) {
      if (!isIdentifier(p.name)) err('Port "' + p.name + '" is not a valid identifier.');
      else if (ports[p.name]) err('Duplicate port name: "' + p.name + '".');
      ports[p.name] = 'port';
      if (!(p.width >= 1)) err('Width of "' + p.name + '" must be >= 1.');
    });
    if (ports.state) warn('A port named "state" collides with the state register and will be renamed.');
    if (ports.next_state) warn('A port named "next_state" collides with the internal register and will be renamed.');

    if (machine.initial) {
      var reached = {};
      var stack = [machine.initial];
      while (stack.length) {
        var cur = stack.pop();
        if (reached[cur]) continue;
        reached[cur] = true;
        outgoing(machine, cur).forEach(function (t) { stack.push(t.to); });
      }
      machine.states.forEach(function (s) {
        if (!reached[s.id]) warn('State "' + s.name + '" is unreachable from the initial state.', { kind: 'state', id: s.id });
      });
    }

    var declared = {};
    machine.inputs.forEach(function (p) { declared[p.name] = true; });
    machine.outputs.forEach(function (p) { declared[p.name] = true; });
    declared[machine.clock] = true;
    declared[machine.reset] = true;

    machine.states.forEach(function (s) {
      var outs = outgoing(machine, s.id);
      if (outs.length === 0) {
        warn('State "' + s.name + '" has no outgoing transitions and becomes stuck.', { kind: 'state', id: s.id });
      }
      var defaults = outs.filter(function (t) { return String(t.cond).trim() === ''; });
      if (defaults.length > 1) {
        err('State "' + s.name + '" has ' + defaults.length + ' unconditional transitions; only one is allowed.', { kind: 'state', id: s.id });
      }
      if (defaults.length === 1 && outs.indexOf(defaults[0]) !== outs.length - 1) {
        warn('In "' + s.name + '" the unconditional transition should have the lowest priority (last).', { kind: 'transition', id: defaults[0].id });
      }
    });

    machine.transitions.forEach(function (t) {
      var from = getState(machine, t.from);
      var to = getState(machine, t.to);
      var label = (from ? from.name : '?') + ' -> ' + (to ? to.name : '?');
      if (!from || !to) { err('Dangling transition ' + label + '.', { kind: 'transition', id: t.id }); return; }
      var cond = String(t.cond).trim();
      if (cond !== '') {
        if (!balancedParens(cond)) err('Unbalanced parentheses in the condition for ' + label + '.', { kind: 'transition', id: t.id });
        identifiersIn(cond).forEach(function (name) {
          if (!declared[name]) {
            warn('The condition for ' + label + ' uses "' + name + '", which is not declared as an input.', { kind: 'transition', id: t.id });
          }
        });
      }
    });

    return problems;
  }

  /* ----------------------------------------------------------------------- */
  /* Serialization                                                           */
  /* ----------------------------------------------------------------------- */

  function serialize(machine) {
    return JSON.stringify(machine, null, 2);
  }

  function deserialize(text) {
    var raw = JSON.parse(text);
    var m = createMachine();
    ['name', 'clock', 'reset', 'encoding'].forEach(function (k) {
      if (typeof raw[k] === 'string' && raw[k]) m[k] = raw[k];
    });
    m.resetActiveLow = !!raw.resetActiveLow;
    m.resetSync = !!raw.resetSync;
    if (['binary', 'gray', 'onehot'].indexOf(m.encoding) === -1) m.encoding = 'binary';

    (raw.inputs || []).forEach(function (p) {
      m.inputs.push({
        id: p.id || uid('in'),
        name: String(p.name || 'in'),
        width: Math.max(1, parseInt(p.width, 10) || 1),
        autoInferred: !!p.autoInferred
      });
    });
    (raw.outputs || []).forEach(function (p) {
      m.outputs.push({
        id: p.id || uid('out'),
        name: String(p.name || 'out'),
        width: Math.max(1, parseInt(p.width, 10) || 1),
        def: p.def == null ? '0' : String(p.def),
        autoInferred: !!p.autoInferred
      });
    });
    (raw.states || []).forEach(function (s) {
      m.states.push({
        id: s.id || uid('st'),
        name: String(s.name || 'S'),
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        outputs: (s.outputs && typeof s.outputs === 'object') ? s.outputs : {},
        code: (s.code == null || s.code === '') ? null : (parseInt(s.code, 10) | 0),
        radius: (s.radius == null || s.radius === '') ? null : Math.max(16, Number(s.radius) || 0),
        dcUndefined: !!s.dcUndefined,
        comment: String(s.comment || '')
      });
    });
    (raw.transitions || []).forEach(function (t) {
      if (!getState(m, t.from) || !getState(m, t.to)) return;
      m.transitions.push({
        id: t.id || uid('tr'),
        from: t.from,
        to: t.to,
        cond: t.cond == null ? '' : String(t.cond),
        outputs: (t.outputs && typeof t.outputs === 'object') ? t.outputs : {},
        curve: Number(t.curve) || 0,
        auto: t.auto !== false,
        loopAngle: t.loopAngle == null ? -90 : Number(t.loopAngle),
        dcUndefined: !!t.dcUndefined,
        comment: String(t.comment || '')
      });
    });
    // Compatibility: old straight transitions (curve 0) become curves.
    m.transitions.forEach(function (t) {
      if (t.from !== t.to && !t.curve) t.curve = DEFAULT_CURVE;
    });
    m.initial = getState(m, raw.initial) ? raw.initial : (m.states[0] ? m.states[0].id : null);
    return m;
  }

  /* ----------------------------------------------------------------------- */
  /* Read-only example registry. Example data lives in examples/*.js so it   */
  /* remains available from file:// without a fetch request.                 */
  /* ----------------------------------------------------------------------- */

  var EXAMPLES = [];

  function freezeDeep(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.keys(value).forEach(function (key) { freezeDeep(value[key]); });
      Object.freeze(value);
    }
    return value;
  }

  function registerExample(example) {
    if (!example || !isIdentifier(example.id) || !example.machine) {
      throw new Error('Invalid example definition.');
    }
    if (EXAMPLES.some(function (item) { return item.id === example.id; })) {
      throw new Error('Duplicate example ID: ' + example.id);
    }
    EXAMPLES.push(freezeDeep({
      id: example.id,
      label: String(example.label || example.id),
      machine: JSON.parse(JSON.stringify(example.machine))
    }));
  }

  function exampleMachine(id) {
    var example = EXAMPLES.find(function (item) { return item.id === id; });
    if (!example) throw new Error('Unknown example: ' + id);
    return deserialize(JSON.stringify(example.machine));
  }

  function defaultMachine() { return exampleMachine('detector101'); }
  function trafficLightMachine() { return exampleMachine('trafficLight'); }
  function mealySequenceMachine() { return exampleMachine('detector101Mealy'); }

  global.FSM = {
    uid: uid,
    KEYWORD_SET: KEYWORD_SET,
    isIdentifier: isIdentifier,
    sanitizeIdentifier: sanitizeIdentifier,
    createMachine: createMachine,
    createState: createState,
    createTransition: createTransition,
    createPort: createPort,
    getState: getState,
    getTransition: getTransition,
    outgoing: outgoing,
    deleteState: deleteState,
    deleteTransition: deleteTransition,
    deletePort: deletePort,
    renameOutput: renameOutput,
    moveTransitionPriority: moveTransitionPriority,
    identifiersIn: identifiersIn,
    parseOutputs: parseOutputs,
    formatOutputs: formatOutputs,
    syncPortsFromUsage: syncPortsFromUsage,
    stateBits: stateBits,
    validate: validate,
    serialize: serialize,
    deserialize: deserialize,
    registerExample: registerExample,
    exampleMachine: exampleMachine,
    demoMachine: defaultMachine,
    defaultMachine: defaultMachine,
    trafficLightMachine: trafficLightMachine,
    mealySequenceMachine: mealySequenceMachine,
    EXAMPLES: EXAMPLES
  };
}(window));
