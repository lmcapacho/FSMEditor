import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModules, plain } from './helpers.mjs';

const { FSM, VERILOG, ICE } = loadBrowserModules();
const errorsOf = (m) => Array.from(FSM.validate(m)).filter((p) => p.level === 'error').map((p) => p.msg);
const warningsOf = (m) => Array.from(FSM.validate(m)).filter((p) => p.level === 'warn').map((p) => p.msg);

test('ceilLog2 / stateWidth', () => {
  assert.equal(VERILOG.ceilLog2(1), 1);
  assert.equal(VERILOG.ceilLog2(2), 1);
  assert.equal(VERILOG.ceilLog2(3), 2);
  assert.equal(VERILOG.ceilLog2(4), 2);
  assert.equal(VERILOG.ceilLog2(5), 3);
  assert.equal(VERILOG.stateWidth(4, 'binary'), 2);
  assert.equal(VERILOG.stateWidth(4, 'onehot'), 4);
});

test('gray code sequence', () => {
  const seq = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => VERILOG.stateCode(i, 8, 'gray'));
  assert.deepEqual(seq, [0, 1, 3, 2, 6, 7, 5, 4]);
});

test('demo (detector 101): validacion limpia', () => {
  assert.deepEqual(errorsOf(FSM.demoMachine()), []);
});

test('demo -> Verilog modulo completo', () => {
  const m = FSM.demoMachine();
  const v = VERILOG.generateModule(m);

  assert.match(v, /module detector_101 \(/);
  assert.match(v, /endmodule\s*$/);
  assert.match(v, /input\s+wire\s+clk,/);
  assert.match(v, /input\s+wire\s+rst,/);
  assert.match(v, /input\s+wire\s+x/);
  assert.match(v, /output reg\s+y/);
  assert.match(v, /localparam ST_W = 2;/);
  assert.match(v, /S0\s+= 2'b00/);
  assert.match(v, /S101 = 2'b11/);
  assert.match(v, /always @\(posedge clk or posedge rst\) begin/);
  assert.match(v, /if \(rst\)\s*\n\s*state <= S0;/);
  assert.match(v, /next_state = state;/);
  assert.match(v, /S0: begin\s*\n\s*if \(x\) next_state = S1;\s*\n\s*else if \(!x\) next_state = S0;/);
  assert.match(v, /y = 1'b0;/);
  assert.match(v, /S101: begin\s*\n\s*y = 1'b1;/);

  // basic begin/end balance
  const begins = (v.match(/\bbegin\b/g) || []).length;
  const ends = (v.match(/\bend\b/g) || []).length;
  assert.equal(begins, ends, 'begin/end desbalanceados');
});

test('demo -> Verilog solo cuerpo (Icestudio basic.code)', () => {
  const m = FSM.demoMachine();
  const b = VERILOG.generateBody(m);
  assert.doesNotMatch(b, /\bmodule\b/, 'el cuerpo no debe declarar module');
  assert.doesNotMatch(b, /\bendmodule\b/);
  assert.doesNotMatch(b, /output\s+reg/, 'el cuerpo no puede usar output reg');
  assert.match(b, /reg y_r;/);
  assert.match(b, /assign y = y_r;/);
  assert.match(b, /y_r = 1'b1;/);
});

test('Mealy + bus + gray + reset sincrono activo bajo', () => {
  const m = FSM.createMachine();
  m.name = 'ctrl';
  m.encoding = 'gray';
  m.resetSync = true;
  m.resetActiveLow = true;
  FSM.createPort(m, 'input', 'en');
  const data = FSM.createPort(m, 'input', 'data'); data.width = 8;
  const q = FSM.createPort(m, 'output', 'q'); q.width = 8; q.def = '0';
  FSM.createPort(m, 'output', 'busy');

  const A = FSM.createState(m, 0, 0, 'A');
  const B = FSM.createState(m, 200, 0, 'B');
  const C = FSM.createState(m, 400, 0, 'C');
  m.initial = A.id;
  B.outputs.busy = '1';
  const t1 = FSM.createTransition(m, A.id, B.id, 'en');
  t1.outputs.q = "8'hAA";
  FSM.createTransition(m, A.id, A.id, '');
  FSM.createTransition(m, B.id, C.id, "data == 8'd0");
  FSM.createTransition(m, B.id, B.id, '');
  FSM.createTransition(m, C.id, A.id, '');

  assert.deepEqual(errorsOf(m), []);

  const v = VERILOG.generateModule(m);
  assert.match(v, /always @\(posedge clk\) begin/);            // synchronous reset: no or list
  assert.doesNotMatch(v, /negedge rst/);
  assert.match(v, /if \(!rst\)/);                              // activo en bajo
  assert.match(v, /output reg\s+\[7:0\] q/);
  assert.match(v, /input\s+wire\s+\[7:0\] data/);
  assert.match(v, /localparam ST_W = 2;/);                     // ceil(log2(3)) = 2
  assert.match(v, /A\s+= 2'b00/);
  assert.match(v, /B\s+= 2'b01/);
  assert.match(v, /C\s+= 2'b11/);                              // gray(2) = 3 -> 2'b11
  assert.match(v, /busy = 1'b1;/);
  assert.match(v, /q = 8'hAA;/);                               // Mealy output in A when enabled
  assert.match(v, /if \(en\) begin q = 8'hAA; end/);
});

test('transicion incondicional fuera de sitio -> aviso', () => {
  const m = FSM.createMachine();
  const A = FSM.createState(m, 0, 0, 'A');
  const B = FSM.createState(m, 1, 0, 'B');
  m.initial = A.id;
  FSM.createTransition(m, A.id, B.id, '');   // incondicional primero (mal)
  FSM.createTransition(m, A.id, A.id, 'x');
  FSM.createPort(m, 'input', 'x');
  assert.ok(warningsOf(m).some((w) => /menor prioridad/.test(w)), 'esperaba aviso de prioridad');
});

test('serializar / deserializar es idempotente', () => {
  const m = FSM.demoMachine();
  const round = FSM.deserialize(FSM.serialize(m));
  assert.equal(round.states.length, m.states.length);
  assert.equal(round.transitions.length, m.transitions.length);
  assert.equal(VERILOG.generateModule(round), VERILOG.generateModule(m));
});

test('parseOutputs / formatOutputs', () => {
  assert.deepEqual(plain(FSM.parseOutputs('y=1, z=0')), { y: '1', z: '0' });
  assert.deepEqual(plain(FSM.parseOutputs('run  done=2  q1=3')), { run: '1', done: '2', q1: '3' });
  assert.deepEqual(plain(FSM.parseOutputs("bus=8'hFF")), { bus: "8'hFF" });
  assert.deepEqual(plain(FSM.parseOutputs('')), {});
  assert.deepEqual(plain(FSM.parseOutputs('  1bad , =2 , ok ')), { ok: '1' });   // descarta invalidos
  assert.equal(FSM.formatOutputs({ y: '1', z: '0' }), 'y=1, z=0');
  assert.deepEqual(plain(FSM.parseOutputs(FSM.formatOutputs({ a: '1', b: '3' }))), { a: '1', b: '3' });
});

test('toda transicion nace curva (nunca recta)', () => {
  const m = FSM.createMachine();
  const A = FSM.createState(m, 0, 0, 'A');
  const B = FSM.createState(m, 200, 0, 'B');
  const t1 = FSM.createTransition(m, A.id, B.id, '');     // unica A->B
  assert.equal(t1.curve, 20, 'una sola transicion tambien se comba');
  assert.equal(t1.auto, true, 'nace en automatico: la fisica la coloca');
  const t2 = FSM.createTransition(m, B.id, A.id, '');     // reciproca
  assert.ok(t1.curve * t2.curve > 0, 'mismo signo: la normal cambia con el sentido, asi que quedan a lados opuestos');
  const t3 = FSM.createTransition(m, A.id, B.id, '');     // otra A->B
  assert.ok(t1.curve * t3.curve < 0, 'las paralelas del mismo sentido alternan lado');
  const loop = FSM.createTransition(m, A.id, A.id, '');
  assert.equal(loop.curve, 0);                            // loops use an angle, not curvature
});

test('migracion: aristas antiguas rectas (curve 0) pasan a arco', () => {
  const legacy = {
    states: [{ id: 's1', name: 'A', x: 0, y: 0 }, { id: 's2', name: 'B', x: 9, y: 0 }],
    transitions: [
      { id: 't1', from: 's1', to: 's2', cond: '', curve: 0 },
      { id: 't2', from: 's1', to: 's1', cond: '', curve: 0 }   // bucle: se queda
    ],
    initial: 's1'
  };
  const m = FSM.deserialize(JSON.stringify(legacy));
  assert.equal(FSM.getTransition(m, 't1').curve, 20);
  assert.equal(FSM.getTransition(m, 't2').curve, 0);
});

test('numero de estado forzado (s.code) manda en el Verilog', () => {
  const m = FSM.createMachine();
  const a = FSM.createState(m, 0, 0, 'A');
  const b = FSM.createState(m, 1, 0, 'B');
  const c = FSM.createState(m, 2, 0, 'C');
  m.initial = a.id;
  a.code = 2; b.code = 0; c.code = 1;
  FSM.createTransition(m, a.id, b.id, '');
  FSM.createTransition(m, b.id, c.id, '');
  FSM.createTransition(m, c.id, a.id, '');
  assert.deepEqual(errorsOf(m), []);
  const v = VERILOG.generateModule(m);
  assert.match(v, /A\s+= 2'b10/);
  assert.match(v, /B\s+= 2'b00/);
  assert.match(v, /C\s+= 2'b01/);
});

test('validacion: numeros de estado duplicados o fuera de rango', () => {
  const m = FSM.createMachine();
  const a = FSM.createState(m, 0, 0, 'A');
  const b = FSM.createState(m, 1, 0, 'B');
  m.initial = a.id;
  a.code = 1; b.code = 1;
  assert.ok(errorsOf(m).some((e) => /duplicado/.test(e)));
  b.code = 9;   // no cabe en 1 bit (2 estados -> width 1, max 1)
  assert.ok(errorsOf(m).some((e) => /no cabe/.test(e)));
});

test('"valores no definidos a DC" emite \'bx', () => {
  const m = FSM.createMachine();
  FSM.createPort(m, 'output', 'a');
  const pb = FSM.createPort(m, 'output', 'b'); pb.width = 4;
  const S = FSM.createState(m, 0, 0, 'S');
  const T = FSM.createState(m, 1, 0, 'T');
  m.initial = S.id;
  S.outputs.a = '1';
  S.dcUndefined = true;               // 'b' no asignada aqui -> x
  FSM.createTransition(m, S.id, T.id, '');
  FSM.createTransition(m, T.id, S.id, '');
  const v = VERILOG.generateModule(m);
  assert.match(v, /S: begin[\s\S]*?b = 4'bx;[\s\S]*?a = 1'b1;/);
});

test('deserialize conserva code / radius / dcUndefined', () => {
  const m = FSM.demoMachine();
  m.states[1].code = 3;
  m.states[1].radius = 55;
  m.states[2].dcUndefined = true;
  m.transitions[0].dcUndefined = true;
  const r = FSM.deserialize(FSM.serialize(m));
  assert.equal(r.states[1].code, 3);
  assert.equal(r.states[1].radius, 55);
  assert.equal(r.states[2].dcUndefined, true);
  assert.equal(r.transitions[0].dcUndefined, true);
});

test('FSM.EXAMPLES: ids unicos y cada ejemplo valida sin errores', () => {
  assert.ok(FSM.EXAMPLES.length >= 2, 'al menos 2 ejemplos ademas del detector');
  const ids = FSM.EXAMPLES.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'ids de ejemplo duplicados');
  FSM.EXAMPLES.forEach((ex) => {
    const m = FSM.exampleMachine(ex.id);
    assert.deepEqual(errorsOf(m), [], ex.id + ': no deberia tener errores');
    assert.ok(m.states.length > 0, ex.id + ': deberia tener estados');
  });
});

test('example machines are independent copies of read-only definitions', () => {
  const first = FSM.exampleMachine('detector101');
  const second = FSM.exampleMachine('detector101');
  first.name = 'changed_locally';
  first.states[0].name = 'CHANGED';
  assert.equal(second.name, 'detector_101');
  assert.equal(second.states[0].name, 'S0');
  assert.ok(Object.isFrozen(FSM.EXAMPLES[0]));
});

test('semaforo: 3 estados en ciclo, una salida Moore por estado', () => {
  const m = FSM.trafficLightMachine();
  assert.equal(m.states.length, 3);
  m.states.forEach((s) => assert.equal(Object.keys(s.outputs).length, 1));
  assert.deepEqual(errorsOf(m), []);
});

test('Mealy detector: y is a transition output, not a state output', () => {
  const m = FSM.mealySequenceMachine();
  m.states.forEach((s) => assert.equal(Object.keys(s.outputs).length, 0, 'sin salidas Moore: es puramente Mealy'));
  const withOutput = m.transitions.filter((t) => Object.keys(t.outputs).length > 0);
  assert.equal(withOutput.length, 1);
  assert.equal(withOutput[0].outputs.y, '1');
  assert.deepEqual(errorsOf(m), []);
});

test('.ice: estructura y bloque de codigo', () => {
  const m = FSM.demoMachine();
  const ice = ICE.buildIce(m);
  assert.equal(ice.version, '1.2');
  assert.equal(ice.package.name, 'detector_101');
  const blocks = ice.design.graph.blocks;
  const code = blocks.find((b) => b.type === 'basic.code');
  assert.ok(code, 'debe existir un basic.code');
  assert.deepEqual(Array.from(code.data.ports.in, (p) => p.name), ['clk', 'rst', 'x']);
  assert.deepEqual(Array.from(code.data.ports.out, (p) => p.name), ['y']);
  assert.doesNotMatch(code.data.code, /\bmodule\b/);

  const clk = blocks.find((b) => b.type === 'basic.input' && b.data.name === 'clk');
  assert.equal(clk.data.clock, true, 'clk debe ir marcado como reloj');

  // there is one wire for every code-block port
  assert.equal(ice.design.graph.wires.length, 3 /*in*/ + 1 /*out*/);
  // valid JSON without textual `undefined`
  const txt = ICE.iceText(m);
  JSON.parse(txt);
  assert.doesNotMatch(txt, /: *undefined/);
});

/* ---------------------------------------------------------------------------
 * The diagram has no "else": every transition has an explicit condition and
 * the generator emits the complement instead of a bare `else` branch.
 * ------------------------------------------------------------------------- */

test('los ejemplos no dejan transiciones sin condicion', () => {
  for (const example of FSM.EXAMPLES) {
    const m = FSM.exampleMachine(example.id);
    const vacias = m.transitions.filter((t) => String(t.cond).trim() === '');
    assert.equal(vacias.length, 0, m.name + ' tiene transiciones sin condicion');
  }
});

test('detector 101: cada estado decide con x y !x, sin else pelado', () => {
  const v = VERILOG.generateModule(FSM.demoMachine());
  assert.ok(!/else next_state/.test(v), 'no debe quedar un "else next_state"');
  assert.match(v, /S1: begin\s*\n\s*if \(!x\) next_state = S10;\s*\n\s*else if \(x\) next_state = S1;/);
  assert.match(v, /S101: begin\s*\n\s*if \(x\) next_state = S1;\s*\n\s*else if \(!x\) next_state = S0;/);
});

test('transicion sin condicion: se emite el complemento de las anteriores', () => {
  const m = FSM.createMachine();
  FSM.createPort(m, 'input', 'x');
  const a = FSM.createState(m, 0, 0, 'A');
  const b = FSM.createState(m, 100, 0, 'B');
  m.initial = a.id;
  FSM.createTransition(m, a.id, b.id, 'x');
  FSM.createTransition(m, a.id, a.id, '');          // "what remains"
  const v = VERILOG.generateModule(m);
  assert.match(v, /if \(x\) next_state = B;\s*\n\s*else if \(!x\) next_state = A;/);
  assert.ok(!/else next_state/.test(v));
});

test('complemento de varias condiciones y de una compuesta', () => {
  const m = FSM.createMachine();
  FSM.createPort(m, 'input', 'a');
  FSM.createPort(m, 'input', 'b');
  const s = FSM.createState(m, 0, 0, 'S');
  const t = FSM.createState(m, 100, 0, 'T');
  m.initial = s.id;
  FSM.createTransition(m, s.id, t.id, 'a && b');
  FSM.createTransition(m, s.id, t.id, '!a');
  FSM.createTransition(m, s.id, s.id, '');
  const v = VERILOG.generateModule(m);
  assert.match(v, /else if \(!\(a && b\) && a\) next_state = S;/);
});

/* ---------------------------------------------------------------------------
 * `default` appears only when it is actually needed.
 * ------------------------------------------------------------------------- */

test('sin default en el proximo estado si los codigos estan todos cubiertos', () => {
  const v = VERILOG.generateModule(FSM.demoMachine());   // 4 estados en 2 bits
  const proximo = v.slice(v.indexOf('// 2)'), v.indexOf('// 3)'));
  assert.ok(!/default:/.test(proximo), 'el case de proximo estado no deberia llevar default:\n' + proximo);
});

test('con default si quedan codigos sin usar', () => {
  const v = VERILOG.generateModule(FSM.trafficLightMachine()); // 3 estados en 2 bits
  assert.match(v, /default: next_state = RED;/);
});

test('el case de salidas cierra con una rama por defecto explicita y vacia', () => {
  for (const example of FSM.EXAMPLES) {
    const v = VERILOG.generateModule(FSM.exampleMachine(example.id));
    const salidas = v.slice(v.indexOf('// 3)'));
    assert.match(salidas, /default: begin\s*\n\s*end\s*\n\s*endcase/, example.id);
    assert.ok(!/default: ;/.test(v), example.id + ': la rama vacia se escribe con begin/end');
  }
});

test('one-hot: siempre hace falta default (quedan codigos sin usar)', () => {
  const m = FSM.demoMachine();
  m.encoding = 'onehot';
  const v = VERILOG.generateModule(m);
  assert.match(v, /default: next_state = S0;/);
});

/* ---------------------------------------------------------------------------
 * Mealy sequence detector: the output belongs to the matching transition.
 * ------------------------------------------------------------------------- */

test('Mealy detector assigns y on the transition, not in a state', () => {
  const m = FSM.mealySequenceMachine();
  const v = VERILOG.generateModule(m);
  assert.match(v, /S10: begin\s*\n\s*if \(x\) begin y = 1'b1; end/);
  assert.equal(m.states.filter((s) => Object.keys(s.outputs || {}).length).length, 0,
    'no state has outputs: this is a pure Mealy machine');
});

test('Mealy detector uses one input and one output', () => {
  const m = FSM.mealySequenceMachine();
  assert.deepEqual(plain(m.inputs.map((p) => p.name)), ['x']);
  assert.equal(m.outputs.length, 1);
  assert.equal(m.states.length, 3);
});

test('Mealy detector pulses when the transition completes 101', () => {
  const m = FSM.mealySequenceMachine();
  const conSalida = m.transitions.filter((t) => Object.keys(t.outputs || {}).length > 0);
  assert.equal(conSalida.length, 1, 'exactly one transition asserts y');
  assert.equal(conSalida[0].from, 's10');
  assert.equal(conSalida[0].to, 's1', 'the final 1 starts the next overlapping match');
  assert.equal(conSalida[0].cond, 'x');
});
