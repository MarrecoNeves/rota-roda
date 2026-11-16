/* ==========================================================================
   Rota Roda — linha do tempo das rotas (Route Timeline) e animação dos veículos
   Funções puras: não mexem no DOM da página, só devolvem dados ou SVG em texto.
   Todos os tempos são minutos contados a partir da saída padrão do depósito.
   ========================================================================== */

/**
 * Agenda de uma rota.
 * @param {object} r      rota devolvida pela API (stops, arrivals, legs)
 * @param {object[]} nodes um item por parada, em ordem: {service, twA, twB}
 * @param {object} o      {returnToDepot, useTW, horizon}
 * @param {number} depart minuto de saída do depósito
 */
export function simulate(r, nodes, o, depart = 0) {
  const legs = legTimes(r, nodes, o);
  let t = depart;
  const items = [];
  let ok = true;
  nodes.forEach((n, k) => {
    t += legs[k];
    const arrive = t;
    const start = o.useTW && n.twA != null ? Math.max(t, n.twA) : t;
    const end = start + (n.service || 0);
    if (o.useTW && n.twB != null && start > n.twB + 1e-6) ok = false;
    items.push({ arrive, start, wait: start - arrive, end, service: n.service || 0, twA: n.twA, twB: n.twB, travel: legs[k] });
    t = end;
  });
  let back = null;
  if (o.returnToDepot) {
    back = t + (legs[nodes.length] || 0);
    if (o.useTW && o.horizon != null && back > o.horizon + 1e-6) ok = false;
  }
  return { depart, items, back, finish: back ?? t, feasible: ok, legs };
}

/**
 * Tempo de cada trecho. A API nova manda `legs`; para resultados antigos,
 * reconstrói a partir dos horários (assume que não houve espera).
 */
export function legTimes(r, nodes, o) {
  const n = nodes.length;
  if (Array.isArray(r.legs) && r.legs.length >= n) return r.legs.map(Number);
  const out = [];
  let prevEnd = 0;
  nodes.forEach((nd, k) => {
    out.push(Math.max(0, (r.arrivals?.[k] ?? prevEnd) - prevEnd));
    prevEnd = (r.arrivals?.[k] ?? prevEnd) + (nd.service || 0);
  });
  if (o.returnToDepot) out.push(Math.max(0, (r.time_min ?? prevEnd) - prevEnd));
  return out;
}

/**
 * Agenda com saída "o mais tarde possível": o veículo sai do depósito tão tarde quanto
 * der sem perder nenhuma janela, então só sobra a espera que não dá para evitar.
 * Sem janelas de tempo, sai no início da jornada.
 */
export function schedule(r, nodes, o) {
  const base = simulate(r, nodes, o, 0);
  if (!o.useTW || !base.feasible || !base.items.some((it) => it.wait > 0.01)) return { ...base, shift: 0 };
  let lo = 0, hi = Math.max(0, (o.horizon ?? 1440) - (base.finish - base.depart));
  // Viabilidade é monótona na hora de saída: busca binária no maior atraso viável
  for (let i = 0; i < 40 && hi - lo > 0.01; i++) {
    const mid = (lo + hi) / 2;
    if (simulate(r, nodes, o, mid).feasible) lo = mid; else hi = mid;
  }
  // Não adianta sair depois do ponto em que a espera some: limita ao total de espera
  const totalWait = base.items.reduce((s, it) => s + it.wait, 0);
  const shift = Math.floor(Math.min(lo, totalWait) + 1e-6);
  const sch = simulate(r, nodes, o, shift);
  return sch.feasible ? { ...sch, shift } : { ...base, shift: 0 };
}

/* ---------------------------------------------------------------------------
   Geometria para a animação
   --------------------------------------------------------------------------- */
const RAD = Math.PI / 180;
export function kmBetween([a1, b1], [a2, b2]) {
  const dy = (a2 - a1) * RAD, dx = (b2 - b1) * RAD * Math.cos(((a1 + a2) / 2) * RAD);
  return Math.hypot(dx, dy) * 6371;
}

/**
 * Quebra o traçado da rota em trechos (um por deslocamento entre paradas).
 * Para cada parada, procura o vértice do traçado mais próximo, sempre andando para a frente.
 * @param {number[][]} path  traçado [[lat,lng],...]
 * @param {number[][]} stops coordenadas na ordem: depósito, clientes..., (depósito)
 * @returns {number[][][]} lista de trechos, cada um uma lista de [lat,lng]
 */
export function splitPath(path, stops) {
  if (!path || path.length < 2) {
    return stops.slice(1).map((s, k) => [stops[k], s]);
  }
  const idx = [0];
  let from = 0;
  for (let k = 1; k < stops.length; k++) {
    const last = k === stops.length - 1;
    let best = from, bestD = Infinity;
    for (let i = from; i < path.length; i++) {
      const d = kmBetween(path[i], stops[k]);
      if (d < bestD - 1e-9) { bestD = d; best = i; }
      // já passou bem perto da parada e se afastou: fica com essa passagem,
      // para não "pular" para uma passagem futura pelo mesmo lugar
      if (bestD < 0.2 && d > bestD + 0.5) break;
    }
    if (last) best = path.length - 1;
    idx.push(Math.max(best, from));
    from = Math.max(best, from);
  }
  const legs = [];
  for (let k = 0; k < idx.length - 1; k++) {
    const seg = path.slice(idx[k], idx[k + 1] + 1);
    legs.push(seg.length >= 2 ? seg : [stops[k], stops[k + 1]]);
  }
  return legs;
}

/** Ponto a uma fração f (0..1) do comprimento de uma polilinha. */
export function along(seg, f) {
  if (seg.length === 1 || f <= 0) return seg[0];
  if (f >= 1) return seg[seg.length - 1];
  const cum = [0];
  for (let i = 1; i < seg.length; i++) cum.push(cum[i - 1] + kmBetween(seg[i - 1], seg[i]));
  const total = cum[cum.length - 1];
  if (!total) return seg[0];
  const target = f * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < target) i++;
  const s0 = cum[i - 1], s1 = cum[i];
  const u = s1 > s0 ? (target - s0) / (s1 - s0) : 0;
  const [a1, b1] = seg[i - 1], [a2, b2] = seg[i];
  return [a1 + (a2 - a1) * u, b1 + (b2 - b1) * u];
}

/**
 * Onde está o veículo no minuto t.
 * @returns {{pos:number[], phase:string, k:number}} phase: depot | travel | wait | service | done
 */
export function vehicleAt(sch, legs, stops, t) {
  if (t <= sch.depart) return { pos: stops[0], phase: "depot", k: -1 };
  let prevEnd = sch.depart;
  for (let k = 0; k < sch.items.length; k++) {
    const it = sch.items[k];
    if (t < it.arrive) {
      const f = it.arrive > prevEnd ? (t - prevEnd) / (it.arrive - prevEnd) : 1;
      return { pos: along(legs[k], f), phase: "travel", k };
    }
    if (t < it.start) return { pos: stops[k + 1], phase: "wait", k };
    if (t < it.end) return { pos: stops[k + 1], phase: "service", k };
    prevEnd = it.end;
  }
  const n = sch.items.length;
  if (sch.back != null && legs[n]) {
    if (t < sch.back) {
      const f = sch.back > prevEnd ? (t - prevEnd) / (sch.back - prevEnd) : 1;
      return { pos: along(legs[n], f), phase: "travel", k: n };
    }
    return { pos: stops[stops.length - 1], phase: "done", k: n };
  }
  return { pos: stops[stops.length - 1], phase: "done", k: n };
}

/* ---------------------------------------------------------------------------
   SVG da linha do tempo (uma linha por visita, na ordem da rota)
   --------------------------------------------------------------------------- */
const escX = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * @param {object} sch    resultado de schedule()
 * @param {object} cfg    {names:[depósito, clientes...], color, clock:(min)=>"hh:mm", offset, useTW, horizon, width, now}
 */
export function timelineSVG(sch, cfg) {
  const W = Math.max(520, cfg.width || 900);
  const labelW = 236, padR = 18, top = 30, rowH = 24;
  const rows = [{ kind: "dep", name: cfg.names[0], t: sch.depart }]
    .concat(sch.items.map((it, k) => ({ kind: "stop", name: cfg.names[k + 1], it, k })));
  if (sch.back != null) rows.push({ kind: "back", name: cfg.names[0], t: sch.back });
  const H = top + rows.length * rowH + 14;

  // domínio do eixo: a rota inteira e as janelas visíveis
  let t0 = sch.depart, t1 = sch.finish;
  if (cfg.useTW) {
    sch.items.forEach((it) => {
      if (it.twA != null) t0 = Math.min(t0, it.twA);
      if (it.twB != null) t1 = Math.max(t1, it.twB);
    });
    t0 = Math.max(0, t0);
    if (cfg.horizon != null) t1 = Math.min(Math.max(t1, sch.finish), Math.max(cfg.horizon, sch.finish));
  }
  if (t1 - t0 < 30) t1 = t0 + 30;
  const span = t1 - t0;
  const step = span > 600 ? 120 : span > 300 ? 60 : span > 120 ? 30 : 15;
  const x = (t) => labelW + ((t - t0) / span) * (W - labelW - padR);
  const y = (i) => top + i * rowH + rowH / 2;
  const c = cfg.color || "#004f9f";
  const out = [];
  out.push(`<svg class="tl-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Linha do tempo da rota" xmlns="http://www.w3.org/2000/svg">`);

  // grade e eixo de horas
  const off = cfg.offset || 0; // minuto do relógio em que a jornada começa: marcas em horas cheias
  const first = Math.ceil((t0 + off) / step) * step - off;
  for (let t = first; t <= t1 + 1e-6; t += step) {
    out.push(`<line class="tl-grid" x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 10}"/>`);
    out.push(`<text class="tl-tick" x="${x(t)}" y="${top - 12}" text-anchor="middle">${escX(cfg.clock(t))}</text>`);
  }
  // listras alternadas
  rows.forEach((_, i) => { if (i % 2) out.push(`<rect class="tl-zebra" x="0" y="${top + i * rowH}" width="${W}" height="${rowH}"/>`); });

  // deslocamentos (diagonais ligando o fim de um atendimento à chegada seguinte)
  let px = x(sch.depart), py = y(0);
  rows.forEach((row, i) => {
    if (row.kind === "stop") {
      out.push(`<line class="tl-travel" x1="${px}" y1="${py}" x2="${x(row.it.arrive)}" y2="${y(i)}" stroke="${c}"/>`);
      px = x(row.it.end); py = y(i);
    } else if (row.kind === "back") {
      out.push(`<line class="tl-travel" x1="${px}" y1="${py}" x2="${x(row.t)}" y2="${y(i)}" stroke="${c}"/>`);
    }
  });

  rows.forEach((row, i) => {
    const yy = y(i);
    const label = row.kind === "stop" ? `${row.k + 1}. ${row.name}` : row.kind === "dep" ? `Depósito · saída` : `Depósito · retorno`;
    out.push(`<g class="tl-row${row.kind !== "stop" ? " dep" : ""}" data-row="${row.kind === "stop" ? row.k : row.kind}">`);
    out.push(`<text class="tl-label" x="10" y="${yy + 4}"><title>${escX(row.name)}</title>${escX(label.length > 33 ? label.slice(0, 32) + "…" : label)}</text>`);
    if (row.kind !== "stop") {
      out.push(`<line class="tl-depline" x1="${labelW}" x2="${x(row.t)}" y1="${yy}" y2="${yy}"/>`);
      out.push(`<rect class="tl-depmark" x="${x(row.t) - 4.5}" y="${yy - 4.5}" width="9" height="9" fill="${c}"><title>${escX(label)} ${escX(cfg.clock(row.t))}</title></rect>`);
    } else {
      const it = row.it;
      const tip = [
        `${row.k + 1}. ${row.name}`,
        `Chegada ${cfg.clock(it.arrive)}`,
        it.wait > 0.5 ? `Espera ${Math.round(it.wait)} min` : null,
        `Início do atendimento ${cfg.clock(it.start)}`,
        it.service ? `Serviço ${Math.round(it.service)} min (até ${cfg.clock(it.end)})` : null,
        cfg.useTW && it.twA != null ? `Janela ${cfg.clock(it.twA)}–${cfg.clock(it.twB)}` : null,
      ].filter(Boolean).join("\n");
      if (cfg.useTW && it.twA != null && it.twB != null) {
        const a = x(it.twA), b = x(it.twB);
        out.push(`<line class="tl-tw" x1="${a}" x2="${b}" y1="${yy}" y2="${yy}"/><line class="tl-tw" x1="${a}" x2="${a}" y1="${yy - 5}" y2="${yy + 5}"/><line class="tl-tw" x1="${b}" x2="${b}" y1="${yy - 5}" y2="${yy + 5}"/>`);
      }
      if (it.wait > 0.5) {
        out.push(`<line class="tl-wait" x1="${x(it.arrive)}" x2="${x(it.start)}" y1="${yy}" y2="${yy}"/>`);
        const ax = x(it.arrive);
        out.push(`<path class="tl-arr" d="M${ax - 3.5} ${yy - 3.5}l7 7M${ax + 3.5} ${yy - 3.5}l-7 7"/>`);
      }
      if (it.service > 0) out.push(`<line class="tl-svc" x1="${x(it.start)}" x2="${Math.max(x(it.end), x(it.start) + 2)}" y1="${yy}" y2="${yy}"/>`);
      out.push(`<circle class="tl-start" cx="${x(it.start)}" cy="${yy}" r="4"/>`);
      out.push(`<rect class="tl-hit" x="${labelW}" y="${yy - rowH / 2}" width="${W - labelW}" height="${rowH}"><title>${escX(tip)}</title></rect>`);
    }
    out.push(`</g>`);
  });

  // cursor do "agora" (animação)
  const nowX = cfg.now != null ? x(Math.min(t1, Math.max(t0, cfg.now))) : x(t0);
  out.push(`<line class="tl-now" x1="${nowX}" x2="${nowX}" y1="${top - 6}" y2="${H - 10}"${cfg.now == null ? ' style="display:none"' : ""}/>`);
  out.push(`</svg>`);
  return { svg: out.join(""), x, t0, t1, W, H, labelW };
}
