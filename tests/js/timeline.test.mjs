// Testes da linha do tempo e da animação:  node tests/js/timeline.test.mjs
import assert from "node:assert/strict";
import { simulate, schedule, legTimes, splitPath, along, vehicleAt, timelineSVG } from "../../app/static/timeline.js";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

// rota: depósito → A → B → depósito; trechos de 10, 20 e 15 min
const route = { stops: [1, 2], arrivals: [60, 80], legs: [10, 20, 15], time_min: 105 };
const nodes = [{ service: 10, twA: 60, twB: 90 }, { service: 5, twA: 0, twB: 200 }];
const o = { returnToDepot: true, useTW: true, horizon: 600 };

t("simulação com espera na janela", () => {
  const s = simulate(route, nodes, o, 0);
  near(s.items[0].arrive, 10); near(s.items[0].wait, 50); near(s.items[0].start, 60); near(s.items[0].end, 70);
  near(s.items[1].arrive, 90); near(s.items[1].wait, 0); near(s.items[1].end, 95);
  near(s.back, 110);
  assert.equal(s.feasible, true);
});

t("saída o mais tarde possível elimina a espera evitável", () => {
  const s = schedule(route, nodes, o);
  assert.equal(s.shift, 50);
  near(s.items[0].wait, 0);
  near(s.items[0].start, 60);
  near(s.back, 110); // o fim não muda; só some a espera
  assert.equal(s.feasible, true);
});

t("saída tardia respeita o fim das janelas", () => {
  // A atende 60–62 e B fecha às 92: sair depois de 52 perderia as janelas
  const tight = [{ service: 10, twA: 60, twB: 62 }, { service: 5, twA: 0, twB: 92 }];
  const s = schedule(route, tight, o);
  assert.equal(s.feasible, true);
  assert.ok(s.shift <= 52);
  assert.ok(s.items[1].start <= 92 + 1e-6);
  const late = [{ service: 10, twA: 0, twB: 30 }, { service: 5, twA: 0, twB: 200 }];
  assert.ok(schedule(route, late, o).shift === 0); // sem espera, não atrasa a saída
  assert.ok(s.items[0].start <= 62 + 1e-6);
});

t("sem janelas: sai no início e não espera", () => {
  const s = schedule(route, nodes.map((x) => ({ ...x, service: 0, twA: null, twB: null })), { ...o, useTW: false });
  assert.equal(s.shift, 0); near(s.depart, 0); near(s.items[0].start, 10);
});

t("resultado antigo (sem legs) reconstrói os trechos", () => {
  const legs = legTimes({ stops: [1, 2], arrivals: [10, 40], time_min: 60 }, [{ service: 5 }, { service: 5 }], { returnToDepot: true });
  assert.deepEqual(legs, [10, 25, 15]);
});

t("traçado dividido em trechos por parada", () => {
  const path = [[0, 0], [0, 0.01], [0, 0.02], [0, 0.03], [0, 0.04]];
  const legs = splitPath(path, [[0, 0], [0, 0.02], [0, 0.04]]);
  assert.equal(legs.length, 2);
  assert.deepEqual(legs[0].at(-1), [0, 0.02]);
  assert.deepEqual(legs[1][0], [0, 0.02]);
  assert.deepEqual(splitPath([], [[0, 0], [1, 1]]), [[[0, 0], [1, 1]]]);
});

t("posição ao longo do trecho e fases do veículo", () => {
  const seg = [[0, 0], [0, 0.01], [0, 0.02]];
  near(along(seg, 0.5)[1], 0.01, 1e-9);
  const s = schedule(route, nodes, o); // sai 50, chega A 60, atende até 70, chega B 90, volta 110
  const stops = [[0, 0], [0, 1], [0, 2], [0, 0]];
  const legs = splitPath(null, stops);
  assert.equal(vehicleAt(s, legs, stops, 40).phase, "depot");
  const mid = vehicleAt(s, legs, stops, 55);
  assert.equal(mid.phase, "travel"); near(mid.pos[1], 0.5, 1e-9);
  assert.equal(vehicleAt(s, legs, stops, 65).phase, "service");
  assert.equal(vehicleAt(s, legs, stops, 200).phase, "done");
});

t("SVG da linha do tempo", () => {
  const s = schedule(route, nodes, o);
  const { svg } = timelineSVG(s, { names: ["CD", "Loja A", "Loja B"], clock: (m) => `${m}`, useTW: true, horizon: 600, now: 70 });
  assert.match(svg, /^<svg/);
  assert.equal((svg.match(/class="tl-row/g) || []).length, 4); // saída, A, B, retorno
  assert.match(svg, /tl-now/);
  assert.match(svg, /Loja A/);
});

console.log(`\n${n} testes ok`);
