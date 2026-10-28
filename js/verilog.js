/* =========================================================================
 * verilog.js - Verilog-2001 generator from the FSM model.
 * Classic three-block style: state register, next state and outputs.
 * Synthesizable with yosys and compatible with the Icestudio/iCE40 flow.
 * Exposes the global `VERILOG` object.
 * ========================================================================= */
(function (global) {
  'use strict';

  function ceilLog2(n) {
    var b = 1;
    while ((1 << b) < n) b += 1;
    return Math.max(1, b);
  }

  /* Integer state code for the requested encoding. */
  function stateCode(index, count, encoding) {
    if (encoding === 'onehot') return 1 << index;
    if (encoding === 'gray') return index ^ (index >> 1);
    return index; // binary
  }

  function stateWidth(count, encoding) {
    return encoding === 'onehot' ? Math.max(1, count) : ceilLog2(count);
  }

  function toBin(value, width) {
    var s = (value >>> 0).toString(2);
    while (s.length < width) s = '0' + s;
    return width + "'b" + s;
  }

  /* Format a user output value ("0", "1", "2'b10", "8'hFF"). */
  function formatValue(raw, width) {
    var v = String(raw == null ? '0' : raw).trim();
    if (v === '') v = '0';
    if (v.indexOf("'") !== -1) return v;              // ya tiene base explicita
    if (/^[0-9]+$/.test(v)) {
      var num = parseInt(v, 10);
      if (width <= 1) return "1'b" + (num ? '1' : '0');
      return width + "'d" + num;
    }
    return v; // expresion (p.ej. otra senal): se deja tal cual
  }

  function indent(level) {
    var s = '';
    for (var i = 0; i < level; i += 1) s += '  ';
    return s;
  }

  /* --------------------------------------------------------------------- */
  /* Core: build the three sections as text.                                */
  /* opts.bodyOnly  -> sin `module`/`endmodule` ni declaracion de puertos   */
  /*                   (para pegar en un bloque basic.code de Icestudio).   */
  /* --------------------------------------------------------------------- */
  function build(machine, opts) {
    opts = opts || {};
    var bodyOnly = !!opts.bodyOnly;
    var L = [];
    function line(txt) { L.push(txt == null ? '' : txt); }

    var states = machine.states.slice();
    var enc = machine.encoding;
    var W = stateWidth(states.length, enc);

    if (states.length === 0) {
      return '// La maquina no tiene estados todavia.\n' +
        '// Anade al menos un estado (doble clic en el lienzo) para generar Verilog.\n';
    }

    /* Nombres internos que no choquen con puertos del usuario. */
    var taken = {};
    machine.inputs.concat(machine.outputs).forEach(function (p) { taken[p.name] = true; });
    taken[machine.clock] = true;
    taken[machine.reset] = true;
    function freshName(base) {
      var n = base, i = 1;
      while (taken[n]) { n = base + '_' + i; i += 1; }
      taken[n] = true;
      return n;
    }
    var REG = freshName('state');
    var NXT = freshName('next_state');

    var idToName = {};
    var idToIndex = {};
    states.forEach(function (s, i) { idToName[s.id] = s.name; idToIndex[s.id] = i; });
    /* codigo de cada estado: el forzado por el usuario (s.code) o el automatico */
    function codeOf(s, i) {
      return (s.code != null && !isNaN(s.code)) ? (s.code >>> 0) : stateCode(i, states.length, enc);
    }
    var initName = (machine.initial && idToName[machine.initial]) || (states[0] && states[0].name) || REG;

    /* Codigos de estado realmente usados. Si cubren las 2^W combinaciones, la
       rama `default` del case es inalcanzable y solo ensucia el codigo. */
    var usedCodes = {};
    states.forEach(function (s, i) { usedCodes[codeOf(s, i)] = true; });
    var coversAllCodes = Object.keys(usedCodes).length >= Math.pow(2, W);

    /* --- salidas: en bodyOnly no se puede `output reg`, se usa reg + assign --- */
    var outRegName = {};
    machine.outputs.forEach(function (p) {
      outRegName[p.name] = bodyOnly ? freshName(p.name + '_r') : p.name;
    });

    /* ---------- cabecera del modulo (solo modo completo) ---------- */
    if (!bodyOnly) {
      var portDecls = [];
      portDecls.push('input  wire ' + machine.clock);
      portDecls.push('input  wire ' + machine.reset);
      machine.inputs.forEach(function (p) {
        portDecls.push('input  wire ' + busSpec(p.width) + p.name);
      });
      machine.outputs.forEach(function (p) {
        portDecls.push('output reg  ' + busSpec(p.width) + p.name);
      });
      line('// -----------------------------------------------------------------------------');
      line('// ' + machine.name + ' - maquina de estados generada por FSM Editor');
      line('// Codificacion: ' + enc + '   |   Estados: ' + states.length +
        '   |   Reset: ' + (machine.resetSync ? 'sincrono' : 'asincrono') +
        ' activo en ' + (machine.resetActiveLow ? 'bajo' : 'alto'));
      line('// -----------------------------------------------------------------------------');
      line('module ' + machine.name + ' (');
      portDecls.forEach(function (d, i) {
        line(indent(1) + d + (i < portDecls.length - 1 ? ',' : ''));
      });
      line(');');
      line('');
    } else {
      line('// Cuerpo FSM para bloque basic.code de Icestudio.');
      line('// Puertos esperados por el bloque:  in: [' +
        [machine.clock, machine.reset].concat(machine.inputs.map(function (p) { return p.name; })).join(', ') +
        ']   out: [' + machine.outputs.map(function (p) { return p.name; }).join(', ') + ']');
      line('// La entrada "' + machine.clock + '" debe marcarse como reloj en el bloque.');
      line('');
    }

    /* ---------- localparams de estado ---------- */
    line(indent(bodyOnly ? 0 : 1) + 'localparam ST_W = ' + W + ';');
    var lpLines = states.map(function (s, i) {
      return indent(bodyOnly ? 1 : 2) + pad(s.name, maxNameLen(states)) + ' = ' +
        toBin(codeOf(s, i), W);
    });
    line(indent(bodyOnly ? 0 : 1) + 'localparam [ST_W-1:0]');
    lpLines.forEach(function (t, i) { line(t + (i < lpLines.length - 1 ? ',' : ';')); });
    line('');

    /* ---------- registros ---------- */
    line(indent(bodyOnly ? 0 : 1) + 'reg [ST_W-1:0] ' + REG + ', ' + NXT + ';');
    if (bodyOnly) {
      machine.outputs.forEach(function (p) {
        line(indent(0) + 'reg ' + busSpec(p.width) + outRegName[p.name] + ';');
        line(indent(0) + 'assign ' + p.name + ' = ' + outRegName[p.name] + ';');
      });
    }
    line('');

    /* ---------- 1) registro de estado (secuencial) ---------- */
    var i0 = bodyOnly ? 0 : 1;
    var rstTerm = machine.resetActiveLow ? ('!' + machine.reset) : machine.reset;
    line(indent(i0) + '// 1) Registro de estado');
    if (machine.resetSync) {
      line(indent(i0) + 'always @(posedge ' + machine.clock + ') begin');
    } else {
      var rstEdge = machine.resetActiveLow ? 'negedge' : 'posedge';
      line(indent(i0) + 'always @(posedge ' + machine.clock + ' or ' + rstEdge + ' ' + machine.reset + ') begin');
    }
    line(indent(i0 + 1) + 'if (' + rstTerm + ')');
    line(indent(i0 + 2) + REG + ' <= ' + initName + ';');
    line(indent(i0 + 1) + 'else');
    line(indent(i0 + 2) + REG + ' <= ' + NXT + ';');
    line(indent(i0) + 'end');
    line('');

    /* ---------- 2) logica de proximo estado (combinacional) ---------- */
    line(indent(i0) + '// 2) Logica de proximo estado');
    line(indent(i0) + 'always @(*) begin');
    line(indent(i0 + 1) + NXT + ' = ' + REG + ';');
    line(indent(i0 + 1) + 'case (' + REG + ')');
    states.forEach(function (s) {
      var outs = FSM.outgoing(machine, s.id);
      line(indent(i0 + 2) + s.name + ': begin');
      emitTransitionChain(outs, i0 + 3);
      line(indent(i0 + 2) + 'end');
    });
    if (!coversAllCodes) line(indent(i0 + 2) + 'default: ' + NXT + ' = ' + initName + ';');
    line(indent(i0 + 1) + 'endcase');
    line(indent(i0) + 'end');
    line('');

    function emitTransitionChain(outs, lvl) {
      if (outs.length === 0) return;
      var seen = [];   // condiciones ya emitidas en esta cadena
      var stopped = false;
      outs.forEach(function (t) {
        if (stopped) return;
        var cond = String(t.cond).trim();
        var target = idToName[t.to];
        if (cond === '') {
          /* Una transicion sin condicion es "lo que queda". Se emite como la
             negacion explicita de las anteriores y no como un `else` pelado:
             el `else` pertenece a la sentencia, no al diagrama de estados. */
          if (seen.length === 0) {
            line(indent(lvl) + NXT + ' = ' + target + ';');
          } else {
            line(indent(lvl) + 'else if (' + complementOf(seen) + ') ' + NXT + ' = ' + target + ';');
          }
          stopped = true; // lo que venga despues es codigo muerto
        } else {
          line(indent(lvl) + (seen.length ? 'else if' : 'if') + ' (' + cond + ') ' + NXT + ' = ' + target + ';');
          seen.push(cond);
        }
      });
    }

    /* ---------- 3) logica de salidas (Moore + Mealy, combinacional) ---------- */
    if (machine.outputs.length > 0) {
      line(indent(i0) + '// 3) Logica de salidas');
      line(indent(i0) + 'always @(*) begin');
      machine.outputs.forEach(function (p) {
        line(indent(i0 + 1) + outRegName[p.name] + ' = ' + formatValue(p.def, p.width) + ';');
      });
      function mealyOf(s) {
        return FSM.outgoing(machine, s.id).filter(function (t) {
          return (t.outputs && Object.keys(t.outputs).length > 0) || t.dcUndefined;
        });
      }
      /* Solo los estados que de verdad asignan algo entran en el case. */
      var outStates = states.filter(function (s) {
        return Object.keys(s.outputs || {}).length > 0 || mealyOf(s).length > 0 || s.dcUndefined;
      });

      line(indent(i0 + 1) + 'case (' + REG + ')');
      outStates.forEach(function (s) {
        var mooreKeys = Object.keys(s.outputs || {});
        var mealyTs = mealyOf(s);
        line(indent(i0 + 2) + s.name + ': begin');
        // "valores no definidos a DC": las salidas no asignadas en este estado -> 'x'
        if (s.dcUndefined) {
          machine.outputs.forEach(function (p) {
            if (mooreKeys.indexOf(p.name) === -1) {
              line(indent(i0 + 3) + outRegName[p.name] + ' = ' + xValue(p.width) + ';');
            }
          });
        }
        mooreKeys.forEach(function (name) {
          var port = portByName(machine.outputs, name);
          if (!port) return;
          line(indent(i0 + 3) + outRegName[name] + ' = ' + formatValue(s.outputs[name], port.width) + ';');
        });
        // Mealy: por prioridad de transicion
        var seenOut = [];
        mealyTs.forEach(function (t) {
          var cond = String(t.cond).trim();
          var assigns = [];
          if (t.dcUndefined) {
            machine.outputs.forEach(function (p) {
              if (!t.outputs || t.outputs[p.name] == null) assigns.push(outRegName[p.name] + ' = ' + xValue(p.width) + ';');
            });
          }
          Object.keys(t.outputs || {}).forEach(function (name) {
            var port = portByName(machine.outputs, name);
            if (port) assigns.push(outRegName[name] + ' = ' + formatValue(t.outputs[name], port.width) + ';');
          });
          if (assigns.length === 0) return;
          if (cond === '') {
            if (seenOut.length === 0) {
              line(indent(i0 + 3) + 'begin ' + assigns.join(' ') + ' end');
            } else {
              line(indent(i0 + 3) + 'else if (' + complementOf(seenOut) + ') begin ' + assigns.join(' ') + ' end');
            }
          } else {
            line(indent(i0 + 3) + (seenOut.length ? 'else if' : 'if') + ' (' + cond + ') begin ' + assigns.join(' ') + ' end');
            seenOut.push(cond);
          }
        });
        line(indent(i0 + 2) + 'end');
      });
      /* Rama por defecto explicita y vacia. Funcionalmente no hace falta,
         porque cada salida ya recibio su valor por defecto antes del case,
         pero deja el case cubierto de forma visible y evita los avisos de
         "case incompleto" de las herramientas de sintesis. */
      line(indent(i0 + 2) + 'default: begin');
      line(indent(i0 + 2) + 'end');
      line(indent(i0 + 1) + 'endcase');
      line(indent(i0) + 'end');
      line('');
    }

    if (!bodyOnly) {
      line('endmodule');
    }

    return L.join('\n').replace(/[ \t]+$/gm, '') + '\n';
  }

  /* --------------------------------------------------------------------- */
  /* Helpers                                                               */
  /* --------------------------------------------------------------------- */
  /* Complemento de una condicion, en la forma mas legible posible:
       x        -> !x
       !x       -> x
       a && b   -> !(a && b)                                                  */
  function negate(cond) {
    var c = String(cond).trim();
    if (/^[A-Za-z_]\w*$/.test(c)) return '!' + c;
    if (/^!\s*[A-Za-z_]\w*$/.test(c)) return c.replace(/^!\s*/, '');
    return '!(' + c + ')';
  }
  /* "ninguna de estas se cumplio": !a && !b && ... */
  function complementOf(conds) {
    return conds.map(negate).join(' && ');
  }

  function busSpec(width) { return width > 1 ? ('[' + (width - 1) + ':0] ') : ''; }
  function xValue(width) { return (width > 1 ? width : 1) + "'bx"; }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function maxNameLen(states) {
    return states.reduce(function (m, s) { return Math.max(m, s.name.length); }, 1);
  }
  function portByName(list, name) {
    for (var i = 0; i < list.length; i += 1) if (list[i].name === name) return list[i];
    return null;
  }

  global.VERILOG = {
    ceilLog2: ceilLog2,
    stateCode: stateCode,
    stateWidth: stateWidth,
    formatValue: formatValue,
    generateModule: function (machine) { return build(machine, { bodyOnly: false }); },
    generateBody: function (machine) { return build(machine, { bodyOnly: true }); }
  };
}(window));
