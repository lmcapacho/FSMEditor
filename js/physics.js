/* =========================================================================
 * physics.js - Transition curves (without DOM access).
 * Exposes the global `PHYS` object.
 *
 * Model:
 *   - Each transition is one quadratic curve through a guide point (`pos`).
 *   - The guide point moves only on the segment perpendicular bisector and is
 *     stored as `curve`, its perpendicular offset.
 *   - It is attracted to the midpoint and repelled by states and other guide
 *     points until it settles, opening and separating curves automatically.
 * Attraction has a nonzero rest length so an isolated transition stays curved.
 * ========================================================================= */
(function (global) {
  'use strict';

  var C = {
    MASS: 50, FRICTION: 0.8, DT: 10, MAX_FORCE: 100000,
    REACH_STATE: 2000, REACH_TRANS: 1500,
    REST: 22,            // curvatura natural (px) de una linea sin otras fuerzas
    MAX_STEP: 8,         // desplazamiento maximo por paso (estabilidad)
    LINE: 2,
    HOLD_RATE: 0.02      // fraccion por paso con la que se llega al valor fijado por untangle
  };

  function hash(id) {
    var h = 0;
    for (var i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) | 0;
    return h;
  }

  /* Marco de referencia de un par de estados: direccion u, normal n, punto
     medio de los bordes (m) y punto medio de los centros (c). */
  function frameOf(A, B) {
    var dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) return null;
    var ux = dx / d, uy = dy / d;
    var sx = A.x + ux * A.r, sy = A.y + uy * A.r, ex = B.x - ux * B.r, ey = B.y - uy * B.r;
    return { ux: ux, uy: uy, nx: -uy, ny: ux, mx: (sx + ex) / 2, my: (sy + ey) / 2, cx: (A.x + B.x) / 2, cy: (A.y + B.y) / 2 };
  }

  /* Posicion del punto guia para un desplazamiento `l`. */
  function handlePos(A, B, l) {
    var f = frameOf(A, B);
    if (!f) return { x: A.x, y: A.y };
    return { x: f.mx + f.nx * l, y: f.my + f.ny * l };
  }

  /* Desplazamiento perpendicular que corresponde a un punto cualquiera. */
  function curveFromPoint(A, B, p) {
    var f = frameOf(A, B);
    if (!f) return 0;
    return (p.x - f.mx) * f.nx + (p.y - f.my) * f.ny;
  }

  /* Circunferencia que pasa EXACTAMENTE por 3 puntos (metodo del circuncentro).
     null si estan (casi) alineados -- ahi no hay circulo finito y se cae a recta. */
  function circleThrough3(P1, P2, P3) {
    var ax = P1.x, ay = P1.y, bx = P2.x, by = P2.y, cx = P3.x, cy = P3.y;
    var d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-7) return null;
    var a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    var ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    var uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    return { x: ux, y: uy, r: Math.hypot(ax - ux, ay - uy) };
  }
  /* Menor diferencia angular de a a b, en (-PI, PI]. */
  function angleDelta(a, b) {
    var d = b - a;
    while (d <= -Math.PI) d += 2 * Math.PI;
    while (d > Math.PI) d -= 2 * Math.PI;
    return d;
  }

  /* Arco de una transicion: un ARCO DE CIRCUNFERENCIA real (siempre redondo,
     sin los picos que puede dar una cuadratica con un solo punto de control)
     que pasa por el borde de cada estado y por el punto guia `pos`. Si los
     3 puntos caen casi alineados (curva ~0) no hay circulo finito: se cae a
     una recta (`circle: null`), que es lo correcto para ese caso limite. */
  function arc(A, B, l) {
    var f = frameOf(A, B);
    if (!f) return null;
    var p = { x: f.mx + f.nx * l, y: f.my + f.ny * l };
    function unit(x, y) { var d = Math.sqrt(x * x + y * y) || 1; return { x: x / d, y: y / d }; }
    var ua = unit(p.x - A.x, p.y - A.y), ub = unit(p.x - B.x, p.y - B.y);
    var start = { x: A.x + ua.x * (A.r + C.LINE), y: A.y + ua.y * (A.r + C.LINE) };
    var end = { x: B.x + ub.x * (B.r + C.LINE + 2), y: B.y + ub.y * (B.r + C.LINE + 2) };
    return { start: start, mid: p, end: end, pos: p, circle: circleThrough3(start, p, end), frame: f };
  }

  /* Punto sobre el arco en la fraccion `t` (0..1), pasando EXACTAMENTE por
     `mid` en t=0.5 (recta start->mid->end si el arco no tiene circulo). */
  function arcPointAt(a, t) {
    if (!a.circle) {
      return { x: a.start.x + (a.end.x - a.start.x) * t, y: a.start.y + (a.end.y - a.start.y) * t };
    }
    var c = a.circle;
    var aS = Math.atan2(a.start.y - c.y, a.start.x - c.x);
    var aM = Math.atan2(a.mid.y - c.y, a.mid.x - c.x);
    var d1 = angleDelta(aS, aM), d2 = angleDelta(aM, Math.atan2(a.end.y - c.y, a.end.x - c.x));
    var ang = t <= 0.5 ? aS + d1 * (t / 0.5) : aM + d2 * ((t - 0.5) / 0.5);
    return { x: c.x + c.r * Math.cos(ang), y: c.y + c.r * Math.sin(ang) };
  }

  function arcSamples(A, B, l, n) {
    var a = arc(A, B, l), out = [];
    if (!a) return out;
    for (var i = 0; i <= n; i += 1) out.push(arcPointAt(a, i / n));
    return out;
  }

  /* La misma curva, pero terminada `cut` px (arco) antes del extremo (sitio
     para la punta de la flecha): recorta el ANGULO equivalente a esa
     longitud, sin deformar el circulo. Devuelve el nuevo extremo, la
     tangente ahi (para orientar la flecha) y los flags que necesita el
     comando SVG "A" para dibujar exactamente ese tramo. */
  function arcTrimmed(a, cut) {
    if (!a.circle) {
      var ex = a.end.x - a.start.x, ey = a.end.y - a.start.y, d = Math.hypot(ex, ey) || 1;
      var t = Math.max(0, 1 - cut / d);
      var dir = { x: ex / d, y: ey / d };
      return { end: { x: a.start.x + ex * t, y: a.start.y + ey * t }, tangent: dir, circle: null };
    }
    var c = a.circle;
    var aS = Math.atan2(a.start.y - c.y, a.start.x - c.x);
    var aM = Math.atan2(a.mid.y - c.y, a.mid.x - c.x);
    var aE = Math.atan2(a.end.y - c.y, a.end.x - c.x);
    var d1 = angleDelta(aS, aM), d2 = angleDelta(aM, aE);
    var total = d1 + d2;                          // barrido con signo de start a end, pasando por mid
    var dir = total >= 0 ? 1 : -1;
    var cutAngle = Math.min(Math.abs(total) * 0.9, cut / c.r);
    var newEnd = aE - dir * cutAngle;
    var trimmedTotal = total - dir * cutAngle;
    return {
      end: { x: c.x + c.r * Math.cos(newEnd), y: c.y + c.r * Math.sin(newEnd) },
      tangent: { x: -Math.sin(newEnd) * dir, y: Math.cos(newEnd) * dir },
      circle: c,
      largeArc: Math.abs(trimmedTotal) > Math.PI ? 1 : 0,
      sweep: trimmedTotal >= 0 ? 1 : 0
    };
  }

  /* ------------------------------- loops -------------------------------- */
  var LOOP_STEP = 58;    // grados entre bucles de un mismo estado

  /* Angulo (grados, y hacia abajo) de cada auto-transicion: automatico = el
     opuesto a donde estan los vecinos del estado (y del triangulo inicial,
     que esta a la izquierda). Si el usuario lo fijo (auto === false) se respeta. */
  function loopAngles(input) {
    var byId = {}, out = {}, count = {};
    input.states.forEach(function (s) { byId[s.id] = s; });
    input.trans.forEach(function (t) {
      if (t.from !== t.to || !byId[t.from]) return;
      if (t.auto === false) { out[t.id] = t.loopAngle == null ? -90 : t.loopAngle; return; }
      var S = byId[t.from], ax = 0, ay = 0, any = false;
      input.trans.forEach(function (o) {
        if (o.from === o.to) return;
        var other = o.from === S.id ? byId[o.to] : (o.to === S.id ? byId[o.from] : null);
        if (!other) return;
        var dx = other.x - S.x, dy = other.y - S.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        ax += dx / d; ay += dy / d; any = true;
      });
      if (input.initial === S.id) { ax -= 1.5; any = true; }
      var base = any && (Math.abs(ax) + Math.abs(ay) > 1e-6) ? Math.atan2(-ay, -ax) * 180 / Math.PI : -90;
      var k = count[S.id] || 0;
      count[S.id] = k + 1;
      var off = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * LOOP_STEP;
      out[t.id] = base + off;
    });
    return out;
  }

  function loopApex(S, deg) {
    var a = deg * Math.PI / 180, d = S.r * 2.22;
    return { x: S.x + Math.cos(a) * d, y: S.y + Math.sin(a) * d };
  }

  /* ------------------------------ physics ------------------------------- */
  function repel(p, q, reach, id) {
    var dx = p.x - q.x, dy = p.y - q.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 1e-6) {
      var h = hash(id);
      return { x: ((h % 7) - 3) * 0.5 + 0.7, y: (((h >> 3) % 7) - 3) * 0.5 - 0.3 };
    }
    var f = reach * reach / (d * d) / 2;
    return { x: dx / d * f, y: dy / d * f };
  }

  /* Avanza `steps` pasos. input: {states:[{id,x,y,r}], trans:[{id,from,to,curve,auto,loopAngle}], initial}
     phys: velocidades (se conserva entre llamadas).
     Devuelve { curves: {id: nuevaCurvatura} (solo automaticas), loops: {id: angulo}, settled }. */
  function step(input, phys, steps) {
    var byId = {};
    input.states.forEach(function (s) { byId[s.id] = s; });
    var trs = input.trans.filter(function (t) { return byId[t.from] && byId[t.to]; });
    var loops = loopAngles(input), cur = {}, last = 0;
    trs.forEach(function (t) { cur[t.id] = t.curve || 0; });
    phys.v = phys.v || {};

    for (var k = 0; k < steps; k += 1) {
      var pos = {};
      trs.forEach(function (t) {
        pos[t.id] = t.from === t.to ? loopApex(byId[t.from], loops[t.id]) : handlePos(byId[t.from], byId[t.to], cur[t.id]);
      });
      last = 0;
      trs.forEach(function (t) {
        if (t.from === t.to || t.auto === false) return;
        var A = byId[t.from], B = byId[t.to], f = frameOf(A, B);
        if (!f) return;
        var p = pos[t.id], l = cur[t.id], sg = l >= 0 ? 1 : -1;
        var hold = input.hold && input.hold[t.id] != null ? input.hold[t.id] : null;
        if (hold != null) {                       // valor decidido por untangle: se acerca suavemente
          var dh = (hold - l) * C.HOLD_RATE;
          cur[t.id] = l + dh;
          phys.v[t.id] = 0;
          last = Math.max(last, Math.abs(dh));
          return;
        }
        var Fx = 0, Fy = 0;
        input.states.forEach(function (s) {
          if (s.id === t.from || s.id === t.to) return;
          var r = repel(p, s, C.REACH_STATE, t.id + s.id);
          Fx += r.x; Fy += r.y;
        });
        trs.forEach(function (o) {
          if (o === t) return;
          var r = repel(p, pos[o.id], C.REACH_TRANS, t.id + o.id);
          Fx += r.x; Fy += r.y;
        });
        var fn = Fx * f.nx + Fy * f.ny - (l - sg * C.REST);            // + atraccion (resorte con longitud natural)
        fn = Math.max(-C.MAX_FORCE, Math.min(C.MAX_FORCE, fn));
        var v = ((phys.v[t.id] || 0) + fn * C.DT / C.MASS);
        var dl = Math.max(-C.MAX_STEP, Math.min(C.MAX_STEP, v * C.DT / 1000));
        cur[t.id] = l + dl;
        phys.v[t.id] = v * C.FRICTION;
        last = Math.max(last, Math.abs(dl));
      });
    }
    var curves = {};
    trs.forEach(function (t) { if (t.from !== t.to && t.auto !== false) curves[t.id] = cur[t.id]; });
    return { curves: curves, loops: loops, settled: last < 0.02 };
  }

  /* ------------------------- crossing removal --------------------------- */
  function segCross(p1, p2, p3, p4) {
    function ccw(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
    var d1 = ccw(p3, p4, p1), d2 = ccw(p3, p4, p2), d3 = ccw(p1, p2, p3), d4 = ccw(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  var TOUCH = 3;      // dos lineas a menos de esto (px) cuentan como conflicto, aunque no se corten
  function bbox(p) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < p.length; i += 1) {
      if (p[i].x < x0) x0 = p[i].x; if (p[i].x > x1) x1 = p[i].x;
      if (p[i].y < y0) y0 = p[i].y; if (p[i].y > y1) y1 = p[i].y;
    }
    return [x0, y0, x1, y1];
  }
  function ptSeg(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    var ex = p.x - a.x - t * dx, ey = p.y - a.y - t * dy;
    return ex * ex + ey * ey;
  }
  function polyHit(a, b) {
    var A = bbox(a), B = bbox(b);
    if (A[0] > B[2] + TOUCH || B[0] > A[2] + TOUCH || A[1] > B[3] + TOUCH || B[1] > A[3] + TOUCH) return false;
    var t2 = TOUCH * TOUCH;
    for (var i = 0; i < a.length - 1; i += 1) {
      for (var j = 0; j < b.length - 1; j += 1) {
        if (segCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
        if (ptSeg(a[i], b[j], b[j + 1]) < t2 || ptSeg(a[i + 1], b[j], b[j + 1]) < t2 ||
            ptSeg(b[j], a[i], a[i + 1]) < t2 || ptSeg(b[j + 1], a[i], a[i + 1]) < t2) return true;
      }
    }
    return false;
  }

  var CLEAR = 6, LABEL_CLEAR = 18;    // holgura minima curva-estado y etiqueta-estado (px)

  /* Cuantos "problemas" tiene un conjunto de curvaturas: cruces entre arcos,
     arcos que atraviesan un estado y arcos casi rectos. `only` limita el
     recuento a las parejas/arcos que implican a ese indice (para comparar
     rapido un cambio en una sola transicion). */
  function untangle(input, curves) {
    var byId = {};
    input.states.forEach(function (s) { byId[s.id] = s; });
    var arcs = input.trans.filter(function (t) { return t.from !== t.to && byId[t.from] && byId[t.to]; });
    var n = arcs.length, cur = arcs.map(function (t) { return curves[t.id] != null ? curves[t.id] : (t.curve || 0); });
    var free = arcs.map(function (t) { return t.auto !== false; });
    var out = {};
    if (n < 1) return { values: out, changed: false, problems: 0 };

    var cache = [];
    function poly(i, l) {
      var key = i + ':' + Math.round(l * 4);
      return cache[key] || (cache[key] = PHYS_samples(byId[arcs[i].from], byId[arcs[i].to], l));
    }
    function PHYS_samples(A, B, l) { return arcSamples(A, B, l, 22); }
    function trim(p) { return p.slice(2, p.length - 2); }
    /* Muestras de la curva i para compararla con la j: solo se recorta el extremo
       que comparte estado con j (ahi dos lineas siempre se "tocan" sin que sea un cruce). */
    var TRIM_LEN = 46;    // px de arco que se recorta junto a un estado compartido
    function trimByLen(p, fromStart, fromEnd) {
      var lo = 0, hi = p.length - 1;
      if (fromStart) {
        var acc = 0;
        while (lo < hi && acc < TRIM_LEN) { acc += Math.hypot(p[lo + 1].x - p[lo].x, p[lo + 1].y - p[lo].y); lo += 1; }
      }
      if (fromEnd) {
        var acc2 = 0;
        while (hi > lo && acc2 < TRIM_LEN) { acc2 += Math.hypot(p[hi].x - p[hi - 1].x, p[hi].y - p[hi - 1].y); hi -= 1; }
      }
      return hi > lo ? p.slice(lo, hi + 1) : [];
    }
    /* Muestras de la curva i para compararla con la j: solo se recorta el extremo
       (por LONGITUD, no por indice) que comparte estado con j -- ahi dos lineas
       siempre "se tocan" sin que sea un cruce real. */
    function against(i, l, j) {
      var p = poly(i, l), a = arcs[i], b = arcs[j];
      return trimByLen(p, a.from === b.from || a.from === b.to, a.to === b.from || a.to === b.to);
    }

    var costStamp = 0, costCache = {};
    function bumpStamp() { costStamp += 1; }
    function costOf(i, l) {
      var key = i + ':' + Math.round(l * 4) + ':' + costStamp;
      if (costCache[key] !== undefined) return costCache[key];
      var c = 0, mine = trim(poly(i, l)), t = arcs[i];
      if (Math.abs(l) < 10) c += 4;
      c += 0.02 * Math.abs(l);
      var hp = handlePos(byId[t.from], byId[t.to], l);
      for (var s = 0; s < input.states.length; s += 1) {
        var S = input.states[s];
        // la etiqueta va en el punto guia: debe quedar despejada (no tapada por un estado)
        if (S.id !== t.from && S.id !== t.to && Math.hypot(hp.x - S.x, hp.y - S.y) < S.r + LABEL_CLEAR) c += 30;
        // la curva no debe rozar ni atravesar estados (holgura CLEAR)
        var worst = 0;
        for (var k = 3; k < mine.length - 3; k += 1) {
          var dd = Math.hypot(mine[k].x - S.x, mine[k].y - S.y);
          if (dd < S.r - 1) { worst = 100; break; }               // atraviesa el estado: como un cruce
          if (dd < S.r + CLEAR) worst = 40;                       // solo lo roza
        }
        c += worst;
      }
      for (var j = 0; j < n; j += 1) {
        if (j === i) continue;
        if (polyHit(against(i, l, j), against(j, cur[j], i))) c += 100;
      }
      return c;
    }
    function total() {
      var t = 0;
      for (var i = 0; i < n; i += 1) t += costOf(i, cur[i]);
      return t;
    }

    var best = total(), start = best, changed = false;
    var STEP = 22, MAX_MAG = 280;
    var LADDER = [30, 90, 180];   // escalera (corta, rapida) de magnitudes para el escape de una sola transicion
    function isBad(i) { return costOf(i, cur[i]) >= 30 || Math.abs(cur[i]) < 10; }
    function anyBad() { for (var i = 0; i < n; i += 1) if (free[i] && isBad(i)) return true; return false; }
    function clampMag(v) { return Math.max(-MAX_MAG, Math.min(MAX_MAG, v)); }

    /* Para cada transicion en problemas se prueban 2 movimientos: crecer un
       poco mas hacia el lado en el que ya esta, o saltar de un golpe al lado
       contrario (refleja el total actual) -- crecer solo no basta cuando el
       lado que hace falta es el opuesto al que ya tiene. Se comprueban las 4
       combinaciones (grow/flip x grow/flip) para cada pareja en problemas y
       se aplica la primera que de verdad la resuelva; si ninguna lo hace
       todavia, se sigue creciendo (mas iteraciones le dan otra oportunidad). */
    for (var iter = 0; iter < 6 && anyBad(); iter += 1) {
      var stepChanged = false;
      for (var i = 0; i < n; i += 1) {
        if (!free[i] || !isBad(i)) continue;
        if (Math.abs(cur[i]) < 10) {                    // casi recta: aleja del cero, sin esperar a un cruce
          var sgn0 = cur[i] >= 0 ? 1 : -1;
          cur[i] = clampMag(sgn0 * 22);
          bumpStamp();
          stepChanged = true;
        } else if (costOf(i, cur[i]) >= 30) {
          // problema que no es un cruce con OTRA transicion (roza/atraviesa un
          // estado ajeno, o tapa una etiqueta): recorre una escalera amplia de
          // magnitudes a ambos lados -- un solo paso pequeno (o un par de
          // saltos) no basta cuando TODO el entorno cercano esta ocupado por
          // OTRA transicion y hay que saltar mas lejos para salir del todo.
          var here0 = costOf(i, cur[i]);
          var best0 = null, bestCost0 = here0;
          for (var m0 = 0; m0 < LADDER.length; m0 += 1) {
            var c0p = costOf(i, LADDER[m0]);
            if (c0p < bestCost0) { bestCost0 = c0p; best0 = LADDER[m0]; }
            var c0n = costOf(i, -LADDER[m0]);
            if (c0n < bestCost0) { bestCost0 = c0n; best0 = -LADDER[m0]; }
          }
          if (best0 !== null) { cur[i] = best0; bumpStamp(); stepChanged = true; }
        }
        for (var j = 0; j < n; j += 1) {
          if (j === i || !free[j]) continue;
          if (!polyHit(against(i, cur[i], j), against(j, cur[j], i))) continue;

          var sgnI = cur[i] >= 0 ? 1 : -1, sgnJ = cur[j] >= 0 ? 1 : -1;
          var growI = clampMag(cur[i] + sgnI * STEP);
          var flipI = clampMag(-sgnI * Math.max(Math.abs(cur[i]), STEP));
          var growJ = clampMag(cur[j] + sgnJ * STEP);
          var flipJ = clampMag(-sgnJ * Math.max(Math.abs(cur[j]), STEP));
          var combos = [[growI, growJ], [growI, flipJ], [flipI, growJ], [flipI, flipJ]];
          var applied = false;
          for (var c = 0; c < combos.length; c += 1) {
            var ci = combos[c][0], cj = combos[c][1];
            if (!polyHit(against(i, ci, j), against(j, cj, i))) {
              cur[i] = ci; cur[j] = cj; bumpStamp();
              applied = true;
              break;
            }
          }
          if (!applied) { cur[i] = growI; bumpStamp(); }
          stepChanged = true;
        }
      }
      if (!stepChanged) break;
      changed = true;
    }
    best = total();
    arcs.forEach(function (t, i) { if (free[i]) out[t.id] = cur[i]; });
    return { values: out, changed: changed, problems: best, before: start };
  }

  /* Deja asentar la fisica, deshace cruces y deja que las curvas lleguen a los
     valores decididos (util para pruebas y para cargar una maquina). */
  function settle(input, phys, maxRounds) {
    var res, work = input.trans.map(function (t) { return { id: t.id, from: t.from, to: t.to, curve: t.curve, auto: t.auto, loopAngle: t.loopAngle }; });
    var hold = null, rounds = 0, problems = 0;
    for (var i = 0; i < (maxRounds || 80); i += 1) {
      rounds = i;
      res = step({ states: input.states, trans: work, initial: input.initial, hold: hold }, phys, 100);
      work.forEach(function (t) { if (res.curves[t.id] != null) t.curve = res.curves[t.id]; });
      if (res.settled) {
        if (hold) break;
        var u = untangle({ states: input.states, trans: work }, res.curves);
        problems = u.problems;
        if (!u.changed) break;
        hold = u.values;
      }
    }
    return {
      curves: work.reduce(function (m, t) { m[t.id] = t.curve; return m; }, {}),
      loops: res ? res.loops : {}, rounds: rounds, hold: hold, problems: problems
    };
  }

  global.PHYS = {
    C: C, frameOf: frameOf, handlePos: handlePos, curveFromPoint: curveFromPoint,
    arc: arc, arcTrimmed: arcTrimmed, arcSamples: arcSamples, loopAngles: loopAngles, loopApex: loopApex,
    step: step, settle: settle, untangle: untangle
  };
}(window));
