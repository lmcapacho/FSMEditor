/* Mealy sequence detector: y pulses on the transition that completes 101. */
(function (global) {
  'use strict';

  global.FSM.registerExample({
    id: 'detector101Mealy',
    label: 'Mealy sequence detector (101)',
    machine: {
      version: 1,
      name: 'detector_101_mealy',
      clock: 'clk',
      reset: 'rst',
      resetActiveLow: false,
      resetSync: false,
      encoding: 'binary',
      inputs: [{ id: 'in_x', name: 'x', width: 1 }],
      outputs: [{ id: 'out_y', name: 'y', width: 1, def: '0' }],
      states: [
        { id: 's0', name: 'S0', x: 200, y: 300, outputs: {}, comment: '' },
        { id: 's1', name: 'S1', x: 440, y: 180, outputs: {}, comment: '' },
        { id: 's10', name: 'S10', x: 680, y: 300, outputs: {}, comment: '' }
      ],
      transitions: [
        { id: 't0', from: 's0', to: 's1', cond: 'x', curve: 20, auto: true, comment: '' },
        { id: 't1', from: 's0', to: 's0', cond: '!x', auto: true, loopAngle: -90, comment: '' },
        { id: 't2', from: 's1', to: 's10', cond: '!x', curve: 20, auto: true, comment: '' },
        { id: 't3', from: 's1', to: 's1', cond: 'x', auto: true, loopAngle: -90, comment: '' },
        { id: 't4', from: 's10', to: 's1', cond: 'x', outputs: { y: '1' }, curve: 20, auto: true, comment: '' },
        { id: 't5', from: 's10', to: 's0', cond: '!x', curve: -20, auto: true, comment: '' }
      ],
      initial: 's0'
    }
  });
}(window));
