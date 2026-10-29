/* Moore traffic-light controller. */
(function (global) {
  'use strict';

  global.FSM.registerExample({
    id: 'trafficLight',
    label: 'Traffic light',
    machine: {
      version: 1,
      name: 'traffic_light',
      clock: 'clk',
      reset: 'rst',
      resetActiveLow: false,
      resetSync: false,
      encoding: 'binary',
      inputs: [{ id: 'in_tick', name: 'tick', width: 1 }],
      outputs: [
        { id: 'out_red', name: 'red', width: 1, def: '0' },
        { id: 'out_yellow', name: 'yellow', width: 1, def: '0' },
        { id: 'out_green', name: 'green', width: 1, def: '0' }
      ],
      states: [
        { id: 'red', name: 'RED', x: 300, y: 180, outputs: { red: '1' }, comment: '' },
        { id: 'green', name: 'GREEN', x: 560, y: 340, outputs: { green: '1' }, comment: '' },
        { id: 'yellow', name: 'YELLOW', x: 300, y: 500, outputs: { yellow: '1' }, comment: '' }
      ],
      transitions: [
        { id: 't0', from: 'red', to: 'green', cond: 'tick', curve: 20, auto: true, comment: '' },
        { id: 't1', from: 'green', to: 'yellow', cond: 'tick', curve: 20, auto: true, comment: '' },
        { id: 't2', from: 'yellow', to: 'red', cond: 'tick', curve: 20, auto: true, comment: '' }
      ],
      initial: 'red'
    }
  });
}(window));
