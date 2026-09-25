/* ==========================================================================
   Rota Roda — front-end (OpenStreetMap ou Google Maps + API FastAPI/VRPSolverEasy)
   ========================================================================== */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (d = 0) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const uid = () => Math.random().toString(36).slice(2, 9);

// Paleta de rotas: 10 cores distinguíveis, com contraste para texto branco
const COLORS = ["#004f9f", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4d7c0f", "#b45309", "#475569"];
const colorOf = (i) => COLORS[i % COLORS.length];

const HOUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 11h3v9h5v-6h4v6h5v-9h3z"/></svg>';
const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const TRUCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7z"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>';
const PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';

/* --------------------------------------------------------------------------
   Estado
   -------------------------------------------------------------------------- */
const STORE_KEY = "vrp-uff-v1"; // mantido para não perder dados já salvos
const state = {
  step: 1,
  points: [],   // {id,name,address,lat,lng,demand,isDepot,service,twStart,twEnd}
  fleet: [],    // {id,name,capacity,qty,costKm,fixedCost,depotId}
  opts: { returnToDepot: true, useTW: false, dayStart: "08:00", dayEnd: "18:00", timeLimit: 30 },
  result: null, // resposta da API + snapshot dos dados usados
  config: { browser_key: "", map_id: "DEMO_MAP_ID", server_key: false, max_points: 80 },
};

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ points: state.points, fleet: state.fleet, opts: state.opts }));
  } catch { /* armazenamento indisponível: segue sem persistir */ }
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (d) {
      state.points = d.points || [];
      state.fleet = d.fleet || [];
      Object.assign(state.opts, d.opts || {});
    }
  } catch { /* ignora dados corrompidos */ }
}
function changed() {
  state.result = null;
  save();
}

const depots = () => state.points.filter((p) => p.isDepot);
const customers = () => state.points.filter((p) => !p.isDepot);
const totalDemand = () => customers().reduce((s, p) => s + (Number(p.demand) || 0), 0);
const toMin = (hhmm) => { const [h, m] = String(hhmm || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
const fmtClock = (min) => { const t = Math.round(min); const h = Math.floor(t / 60) % 24; return `${String(h).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
const fmtDur = (min) => { const t = Math.round(min); const h = Math.floor(t / 60); return h ? `${h} h ${String(t % 60).padStart(2, "0")} min` : `${t} min`; };

/* --------------------------------------------------------------------------
   UI utilitária
   -------------------------------------------------------------------------- */
let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", isErr);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 7000 : 3500);
}
function footMsg(msg, isErr = false) {
  const f = $("#foot-msg");
  f.textContent = msg;
  f.classList.toggle("err", isErr);
}

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* resposta sem JSON */ }
  if (!r.ok) {
    const msg = data?.error || data?.detail?.[0]?.msg || data?.detail || `Erro ${r.status} no servidor.`;
    throw new Error(typeof msg === "string" ? msg : "Dados inválidos.");
  }
  return data;
}

/* --------------------------------------------------------------------------
   Mapa — dois provedores com a mesma interface:
   • OpenStreetMap + Leaflet (padrão, 100% gratuito, sem chave)
   • Google Maps (opcional, quando existe GOOGLE_MAPS_BROWSER_KEY)
   -------------------------------------------------------------------------- */
const G = { ok: false, provider: "none", view: null, markers: new Map(), routes: [], hidden: new Set(), placesLib: null, geocoder: null };

// Decodifica polylines no formato do Google (o OSRM usa o mesmo formato, precisão 5)
function decodePolyline(str, precision = 5) {
  const f = 10 ** precision, out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lat / f, lng / f]);
  }
  return out;
}

// Setas de sentido ao longo da rota (Leaflet): uma a cada ~450 m
function arrowPoints(path, every = 0.45) {
  const R = 6371, rad = Math.PI / 180, pts = [];
  let acc = every / 2;
  for (let k = 1; k < path.length; k++) {
    const [a1, b1] = path[k - 1], [a2, b2] = path[k];
    const dy = (a2 - a1) * rad, dx = (b2 - b1) * rad * Math.cos(((a1 + a2) / 2) * rad);
    const seg = Math.hypot(dx, dy) * R;
    if (!seg) continue;
    const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    while (acc <= seg) { const t = acc / seg; pts.push({ lat: a1 + (a2 - a1) * t, lng: b1 + (b2 - b1) * t, deg }); acc += every; }
    acc -= seg;
  }
  if (!pts.length && path.length > 1) {
    const [a1, b1] = path[0], [a2, b2] = path.at(-1);
    pts.push({ lat: (a1 + a2) / 2, lng: (b1 + b2) / 2, deg: (Math.atan2((b2 - b1) * Math.cos(a1 * rad), a2 - a1) * 180) / Math.PI });
  }
  return pts;
}

function loadScript(src) {
  return new Promise((ok, fail) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => fail(new Error("Falha ao carregar " + src)); document.head.append(s); });
}
function loadCss(href) {
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href; document.head.append(l);
}

const LeafletView = {
  async init(el) {
    loadCss("/static/vendor/leaflet/leaflet.css");
    await loadScript("/static/vendor/leaflet/leaflet.js");
    this.map = L.map(el, { zoomControl: false, preferCanvas: false }).setView([-22.9035, -43.115], 13);
    L.control.zoom({ position: "topright" }).addTo(this.map);
    // Mapa base gratuito do OpenStreetMap (sem chave; exige só a atribuição)
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
  },
  onClick(cb) { this.map.on("click", (e) => cb(e.latlng.lat, e.latlng.lng)); },
  addMarker(o) {
    const icon = L.divIcon({ html: o.el, className: "lf-icon", iconSize: [0, 0], iconAnchor: [0, 0] });
    const m = L.marker([o.lat, o.lng], { icon, draggable: o.draggable, zIndexOffset: o.zIndex, title: o.title, riseOnHover: true }).addTo(this.map);
    m.on("click", () => { m.unbindPopup(); m.bindPopup(o.popup(), { offset: [0, -30], className: "lf-pop" }).openPopup(); o.onClick?.(); });
    m.on("dragend", () => { const p = m.getLatLng(); o.onDragEnd?.(p.lat, p.lng); });
    return { el: o.el, remove: () => m.remove(), open: () => m.fire("click") };
  },
  addRoute(o) {
    const casing = L.polyline(o.path, { color: "#ffffff", weight: 8, opacity: 0.9, interactive: false, lineJoin: "round" }).addTo(this.map);
    const line = L.polyline(o.path, { color: o.color, weight: 4.5, opacity: 0.95, lineJoin: "round" }).addTo(this.map);
    line.on("click", o.onClick);
    const arrows = arrowPoints(o.path).map(({ lat, lng, deg }) => L.marker([lat, lng], {
      icon: L.divIcon({ className: "lf-arrow", html: `<span style="--c:${o.color};transform:rotate(${deg}deg)"></span>`, iconSize: [14, 14], iconAnchor: [7, 7] }),
      interactive: false, keyboard: false,
    }).addTo(this.map));
    return {
      remove() { casing.remove(); line.remove(); arrows.forEach((a) => a.remove()); },
      style(mode) {
        line.setStyle({ opacity: mode === "hidden" ? 0 : mode === "dim" ? 0.18 : 0.95 });
        casing.setStyle({ opacity: mode === "hidden" ? 0 : mode === "dim" ? 0.3 : 0.9 });
        arrows.forEach((a) => a.setOpacity(mode === "hidden" ? 0 : mode === "dim" ? 0.2 : 1));
        if (mode === "normal") { casing.bringToFront(); line.bringToFront(); }
      },
    };
  },
  fit(pts, pad) {
    if (pts.length === 1) this.map.setView(pts[0], 16);
    else this.map.fitBounds(L.latLngBounds(pts), { padding: [pad, pad] });
  },
  panTo(lat, lng) { this.map.panTo([lat, lng]); },
  center() { const c = this.map.getCenter(); return { lat: c.lat, lng: c.lng }; },
};

function loadGoogle(key) {
  // Carregador oficial (dynamic library import) do Maps JavaScript API
  /* eslint-disable */
  ((g) => { var h, a, k, p = "The Google Maps JavaScript API", c = "google", l = "importLibrary", q = "__ib__", m = document, b = window; b = b[c] || (b[c] = {}); var d = b.maps || (b.maps = {}), r = new Set(), e = new URLSearchParams(), u = () => h || (h = new Promise(async (f, n) => { await (a = m.createElement("script")); e.set("libraries", [...r] + ""); for (k in g) e.set(k.replace(/[A-Z]/g, (t) => "_" + t[0].toLowerCase()), g[k]); e.set("callback", c + ".maps." + q); a.src = `https://maps.${c}apis.com/maps/api/js?` + e; d[q] = f; a.onerror = () => (h = n(Error(p + " could not load."))); a.nonce = m.querySelector("script[nonce]")?.nonce || ""; m.head.append(a); })); d[l] ? console.warn(p + " only loads once. Ignoring:", g) : (d[l] = (f, ...n) => r.add(f) && u().then(() => d[l](f, ...n))); })({ key, v: "weekly", language: "pt-BR", region: "BR" });
  /* eslint-enable */
}

const GoogleView = {
  async init(el) {
    loadGoogle(state.config.browser_key);
    const { Map, InfoWindow } = await google.maps.importLibrary("maps");
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    this.Adv = AdvancedMarkerElement;
    this.map = new Map(el, {
      center: { lat: -22.9035, lng: -43.115 }, zoom: 13, mapId: state.config.map_id,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: true, clickableIcons: false, gestureHandling: "greedy",
    });
    this.info = new InfoWindow();
  },
  onClick(cb) { this.map.addListener("click", (e) => cb(e.latLng.lat(), e.latLng.lng())); },
  addMarker(o) {
    const m = new this.Adv({ map: this.map, position: { lat: o.lat, lng: o.lng }, content: o.el, title: o.title, gmpDraggable: o.draggable, zIndex: o.zIndex });
    m.addListener("click", () => { this.info.setContent(o.popup()); this.info.open({ map: this.map, anchor: m }); o.onClick?.(); });
    m.addListener("dragend", () => {
      const p = m.position;
      o.onDragEnd?.(typeof p.lat === "function" ? p.lat() : p.lat, typeof p.lng === "function" ? p.lng() : p.lng);
    });
    return { el: o.el, remove: () => (m.map = null), open: () => google.maps.event.trigger(m, "click") };
  },
  addRoute(o) {
    const path = o.path.map(([a, b]) => ({ lat: a, lng: b }));
    const casing = new google.maps.Polyline({ path, map: this.map, strokeColor: "#ffffff", strokeOpacity: 0.9, strokeWeight: 8, zIndex: 1 });
    const line = new google.maps.Polyline({
      path, map: this.map, strokeColor: o.color, strokeOpacity: 0.95, strokeWeight: 4.5, zIndex: 2,
      icons: [{ icon: { path: google.maps.SymbolPath.FORWARD_OPEN_ARROW, scale: 2.2, strokeWeight: 2.2, strokeColor: o.color, strokeOpacity: 1 }, offset: "40px", repeat: "110px" }],
    });
    line.addListener("click", o.onClick);
    return {
      remove() { casing.setMap(null); line.setMap(null); },
      style(mode) {
        const top = mode === "normal";
        line.setOptions({ strokeOpacity: mode === "hidden" ? 0 : mode === "dim" ? 0.18 : 0.95, zIndex: top ? 4 : 2 });
        casing.setOptions({ strokeOpacity: mode === "hidden" ? 0 : mode === "dim" ? 0.3 : 0.9, zIndex: top ? 3 : 1 });
        const icons = line.get("icons");
        icons[0].icon.strokeOpacity = mode === "hidden" ? 0 : mode === "dim" ? 0.2 : 1;
        line.set("icons", icons);
      },
    };
  },
  fit(pts, pad) {
    if (pts.length === 1) { this.map.setCenter({ lat: pts[0][0], lng: pts[0][1] }); this.map.setZoom(16); return; }
    const b = new google.maps.LatLngBounds();
    pts.forEach(([a, c]) => b.extend({ lat: a, lng: c }));
    this.map.fitBounds(b, pad);
  },
  panTo(lat, lng) { this.map.panTo({ lat, lng }); },
  center() { const c = this.map.getCenter(); return c ? { lat: c.lat(), lng: c.lng() } : null; },
};

function mapUnavailable(msg) {
  G.ok = false;
  $("#map-empty").hidden = false;
  $("#map-hint").hidden = true;
  if (msg) $("#map-empty-msg").textContent = msg;
}

async function startView(view, provider) {
  await view.init($("#map"));
  G.view = view;
  G.provider = provider;
  G.ok = true;
  view.onClick((lat, lng) => { if (state.step === 1) addFromMapClick(lat, lng); });
  $("#map-empty").hidden = true;
}

async function initMap() {
  if (state.config.map_provider === "google" && state.config.browser_key) {
    // Se a chave for recusada depois do carregamento, cai para o mapa gratuito
    window.gm_authFailure = async () => {
      $("#map").innerHTML = "";
      try { await startView(LeafletView, "osm"); renderMap(true); toast("Chave do Google recusada: usando o mapa gratuito do OpenStreetMap."); }
      catch { mapUnavailable("A chave do Google foi recusada e o mapa gratuito não carregou."); }
    };
    try { await startView(GoogleView, "google"); renderMap(true); return; }
    catch (err) { console.error(err); $("#map").innerHTML = ""; }
  }
  try {
    await startView(LeafletView, "osm");
    renderMap(true);
  } catch (err) {
    console.error(err);
    mapUnavailable("Não foi possível carregar o mapa. O cálculo das rotas funciona mesmo assim.");
  }
}

async function reverseGeocode(lat, lng) {
  if (G.provider === "google") {
    try {
      if (!G.geocoder) {
        const { Geocoder } = await google.maps.importLibrary("geocoding");
        G.geocoder = new Geocoder();
      }
      const { results } = await G.geocoder.geocode({ location: { lat, lng }, language: "pt-BR" });
      if (results?.[0]) return results[0].formatted_address;
    } catch { /* tenta pelo servidor */ }
  }
  try {
    const { address } = await api(`/api/reverse?lat=${lat}&lng=${lng}`);
    return address;
  } catch { return null; }
}

async function addFromMapClick(lat, lng) {
  const p = addPoint({ lat, lng, address: "Buscando endereço…", name: "" });
  if (!p) return;
  const addr = await reverseGeocode(lat, lng);
  p.address = addr || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  if (!p.name) p.name = shortName(p.address);
  save();
  renderPoints();
}

function markerContent(label, color, isDepot) {
  const el = document.createElement("div");
  el.className = "mk";
  if (isDepot) el.innerHTML = `<div class="mk-dep" title="Depósito">${HOUSE}</div>`;
  else el.innerHTML = `<div class="mk-pin" style="--c:${color}"><span>${esc(label)}</span></div>`;
  return el;
}

function routeIndexByPoint() {
  const m = new Map();
  if (!state.result) return m;
  state.result.exact.routes.forEach((r, ri) => r.stops.forEach((s, k) => m.set(state.result.pointIds[s], { ri, order: k + 1, arrival: r.arrivals[k] })));
  return m;
}

function renderMap(fit = false) {
  if (!G.ok) return;
  G.markers.forEach((m) => m.remove());
  G.markers.clear();
  G.routes.forEach((r) => r.remove());
  G.routes = [];

  const showResult = state.step === 3 && state.result;
  const byPoint = showResult ? routeIndexByPoint() : new Map();
  const pts = [];
  let custN = 0;

  state.points.forEach((p) => {
    if (!p.isDepot) custN++;
    const info = byPoint.get(p.id);
    const el = markerContent(info ? info.order : custN, info ? colorOf(info.ri) : "#475569", p.isDepot);
    if (info && G.hidden.has(info.ri)) el.classList.add("dim");
    const handle = G.view.addMarker({
      lat: p.lat, lng: p.lng, el, title: p.name || p.address,
      draggable: state.step === 1, zIndex: p.isDepot ? 1000 : 100,
      popup: () => {
        const extra = info ? `<span>Rota ${info.ri + 1} · parada ${info.order} · chegada ~${fmtClock(toMin(state.result.opts.dayStart) + info.arrival)}</span>` : "";
        return `<div class="iw"><strong>${esc(p.name || "Ponto")}</strong><span>${esc(p.address)}</span>${p.isDepot ? "<span><b>Depósito</b></span>" : `<span>Demanda: <b>${nf().format(p.demand || 0)}</b></span>`}${extra}</div>`;
      },
      onClick: () => highlightPoint(p.id),
      onDragEnd: async (lat, lng) => {
        Object.assign(p, { lat, lng });
        const addr = await reverseGeocode(lat, lng);
        if (addr) p.address = addr;
        changed();
        renderPoints();
      },
    });
    G.markers.set(p.id, handle);
    pts.push([p.lat, p.lng]);
  });

  if (showResult) pts.push(...drawRoutes());
  if (fit && pts.length) G.view.fit(pts, 60);
  renderLegend();
}

function drawRoutes() {
  const res = state.result;
  const ptById = new Map(res.points.map((p) => [p.id, p]));
  const all = [];
  res.exact.routes.forEach((r, ri) => {
    let path = [];
    if (r.polylines?.length) r.polylines.forEach((enc) => path.push(...decodePolyline(enc)));
    else {
      const seq = [r.depot, ...r.stops, ...(res.opts.returnToDepot ? [r.depot] : [])];
      path = seq.map((i) => { const p = ptById.get(res.pointIds[i]); return [p.lat, p.lng]; });
    }
    const h = G.view.addRoute({ path, color: colorOf(ri), onClick: () => focusRoute(ri) });
    h.ri = ri;
    if (G.hidden.has(ri)) h.style("hidden");
    G.routes.push(h);
    all.push(...path);
  });
  return all;
}

function setRouteEmphasis(ri) {
  // ri = null → todas normais; número → destaca uma rota e esmaece as outras
  if (!G.ok) return;
  G.routes.forEach((h) => h.style(G.hidden.has(h.ri) ? "hidden" : ri !== null && h.ri !== ri ? "dim" : "normal"));
  const byPoint = routeIndexByPoint();
  G.markers.forEach((m, id) => {
    const info = byPoint.get(id);
    if (info) m.el.classList.toggle("dim", G.hidden.has(info.ri) || (ri !== null && info.ri !== ri));
  });
}

function focusRoute(ri) {
  if (!G.ok || !state.result) return;
  const r = state.result.exact.routes[ri];
  const ptById = new Map(state.result.points.map((p) => [p.id, p]));
  const pts = [r.depot, ...r.stops].map((i) => { const p = ptById.get(state.result.pointIds[i]); return [p.lat, p.lng]; });
  G.view.fit(pts, 80);
  setRouteEmphasis(ri);
  $$(".route").forEach((el) => el.classList.toggle("hl", Number(el.dataset.ri) === ri));
  $(`.route[data-ri="${ri}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderLegend() {
  const lg = $("#legenda");
  if (!(G.ok && state.step === 3 && state.result)) { lg.hidden = true; return; }
  lg.innerHTML = state.result.exact.routes.map((r, ri) =>
    `<button type="button" data-ri="${ri}" aria-pressed="${!G.hidden.has(ri)}" style="--c:${colorOf(ri)}"><i></i>Rota ${ri + 1} · ${esc(r.vehicle_name)}</button>`).join("");
  lg.hidden = false;
}

function highlightPoint(id) {
  $$(".pt").forEach((el) => el.classList.toggle("hl", el.dataset.id === id));
  const el = $(`.pt[data-id="${id}"]`);
  if (el && state.step === 1) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* --------------------------------------------------------------------------
   Etapa 1 — pontos
   -------------------------------------------------------------------------- */
function shortName(address) {
  return String(address || "").split(",").slice(0, 2).join(",").trim() || "Ponto";
}

function addPoint({ name, address, lat, lng, demand, isDepot, service, twStart, twEnd }) {
  if (state.points.length >= state.config.max_points) {
    toast(`Limite de ${state.config.max_points} pontos atingido.`, true);
    return null;
  }
  const first = state.points.length === 0;
  const p = {
    id: uid(),
    name: name || shortName(address),
    address: address || "",
    lat: Number(lat), lng: Number(lng),
    demand: isDepot || (isDepot === undefined && first) ? 0 : Number(demand ?? 10),
    isDepot: isDepot ?? first,
    service: Number(service ?? 5),
    twStart: twStart || state.opts.dayStart,
    twEnd: twEnd || state.opts.dayEnd,
  };
  state.points.push(p);
  changed();
  renderPoints();
  renderMap(true);
  return p;
}

function renderPoints() {
  const list = $("#lista-pontos");
  const tw = state.opts.useTW;
  let n = 0;
  list.innerHTML = state.points.map((p) => {
    const badge = p.isDepot ? HOUSE : String(++n);
    const idp = `p-${p.id}`;
    return `<li class="pt ${p.isDepot ? "is-depot" : ""}" data-id="${p.id}">
      <span class="pt-badge" aria-hidden="true">${badge}</span>
      <div class="pt-main">
        <label class="sr-only" for="${idp}-nome">Nome do ponto</label>
        <input class="pt-name" id="${idp}-nome" data-f="name" value="${esc(p.name)}" maxlength="60">
        <p class="pt-addr" title="${esc(p.address)}">${esc(p.address)}</p>
        <div class="pt-fields">
          ${p.isDepot ? "" : `<div class="field"><label for="${idp}-dem">Demanda</label><input id="${idp}-dem" data-f="demand" type="number" min="1" step="1" inputmode="numeric" value="${esc(p.demand)}" aria-describedby="foot-msg"></div>`}
          ${tw && !p.isDepot ? `
            <div class="field tw"><label for="${idp}-ini">Abre às</label><input id="${idp}-ini" data-f="twStart" type="time" value="${esc(p.twStart)}"></div>
            <div class="field tw"><label for="${idp}-fim">Fecha às</label><input id="${idp}-fim" data-f="twEnd" type="time" value="${esc(p.twEnd)}"></div>
            <div class="field"><label for="${idp}-srv">Atend. (min)</label><input id="${idp}-srv" data-f="service" type="number" min="0" step="1" inputmode="numeric" value="${esc(p.service)}"></div>` : ""}
          <label class="chk"><input type="checkbox" data-f="isDepot" ${p.isDepot ? "checked" : ""}> Depósito</label>
        </div>
      </div>
      <button type="button" class="icon-btn" data-act="del" aria-label="Remover ${esc(p.name)}">${TRASH}</button>
    </li>`;
  }).join("");
  $("#vazio-pontos").hidden = state.points.length > 0;
  $("#btn-limpar").hidden = state.points.length === 0;
  $("#count-pontos").textContent = state.points.length;
  const d = depots().length, c = customers().length;
  $("#resumo-demanda").textContent = state.points.length ? `${d} depósito${d !== 1 ? "s" : ""} · ${c} cliente${c !== 1 ? "s" : ""} · demanda ${nf().format(totalDemand())}` : "";
  updateFooter();
}

$("#lista-pontos").addEventListener("input", (e) => {
  const li = e.target.closest(".pt");
  const f = e.target.dataset.f;
  if (!li || !f || f === "isDepot") return;
  const p = state.points.find((x) => x.id === li.dataset.id);
  p[f] = e.target.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value;
  e.target.removeAttribute("aria-invalid");
  changed();
  if (f === "demand") { $("#resumo-demanda").textContent = `${depots().length} depósito(s) · ${customers().length} cliente(s) · demanda ${nf().format(totalDemand())}`; updateFooter(); }
});
$("#lista-pontos").addEventListener("change", (e) => {
  const li = e.target.closest(".pt");
  if (!li) return;
  const p = state.points.find((x) => x.id === li.dataset.id);
  if (e.target.dataset.f === "isDepot") {
    p.isDepot = e.target.checked;
    if (p.isDepot) p.demand = 0; else if (!p.demand) p.demand = 10;
    fixFleetDepots();
    changed();
    renderPoints();
    renderMap();
  } else if (e.target.dataset.f === "name") {
    renderMap();
  }
});
$("#lista-pontos").addEventListener("click", (e) => {
  const li = e.target.closest(".pt");
  if (!li) return;
  if (e.target.closest('[data-act="del"]')) {
    state.points = state.points.filter((x) => x.id !== li.dataset.id);
    fixFleetDepots();
    changed();
    renderPoints();
    renderMap();
    return;
  }
  if (G.ok && !e.target.closest("input,button,label")) {
    const p = state.points.find((x) => x.id === li.dataset.id);
    G.view.panTo(p.lat, p.lng);
    G.markers.get(p.id)?.open();
  }
});

$("#btn-limpar").addEventListener("click", () => {
  if (!confirmInline($("#btn-limpar"), "Confirmar limpeza")) return;
  state.points = [];
  changed();
  renderPoints();
  renderMap();
});

// Confirmação em dois cliques (sem diálogos nativos)
function confirmInline(btn, label) {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; return true; }
  btn.dataset.orig = btn.textContent;
  btn.dataset.armed = "1";
  btn.textContent = label;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.orig; } }, 3000);
  return false;
}

/* ---- busca com sugestões (Google Places ou OpenStreetMap/Photon) ---- */
const search = { token: null, items: [], active: -1, timer: null, seq: 0 };
const inputBusca = $("#busca");
const listaSug = $("#sugestoes");

function closeSug() {
  listaSug.hidden = true;
  $("#search-box").setAttribute("aria-expanded", "false");
  search.active = -1;
  inputBusca.removeAttribute("aria-activedescendant");
}
function renderSug() {
  if (!search.items.length) { closeSug(); return; }
  listaSug.innerHTML = search.items.map((s, i) =>
    s.note ? `<li class="sug-note" role="option" aria-disabled="true">${esc(s.note)}</li>`
      : `<li role="option" id="sug-${i}" data-i="${i}" aria-selected="${i === search.active}">${PIN}<span><span class="sug-main">${esc(s.main)}</span><br><span class="sug-sec">${esc(s.sec)}</span></span></li>`).join("");
  listaSug.hidden = false;
  $("#search-box").setAttribute("aria-expanded", "true");
  if (search.active >= 0) inputBusca.setAttribute("aria-activedescendant", `sug-${search.active}`);
}

async function fetchSuggestions(q) {
  const my = ++search.seq;
  try {
    if (G.provider === "google") {
      if (!G.placesLib) G.placesLib = await google.maps.importLibrary("places");
      const { AutocompleteSessionToken, AutocompleteSuggestion } = G.placesLib;
      if (!search.token) search.token = new AutocompleteSessionToken();
      const req = { input: q, sessionToken: search.token, language: "pt-BR", region: "br", includedRegionCodes: ["br"] };
      const c = G.view.center();
      if (c) req.locationBias = { center: c, radius: 30000 };
      const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(req);
      if (my !== search.seq) return; // resposta antiga
      search.items = suggestions.filter((s) => s.placePrediction).slice(0, 6).map((s) => {
        const pp = s.placePrediction;
        return { sel: true, main: pp.mainText?.toString() || pp.text.toString(), sec: pp.secondaryText?.toString() || "", pred: pp };
      });
    } else {
      // Modo gratuito: sugestões do OpenStreetMap (Photon) via servidor, priorizando a região visível
      const c = G.ok ? G.view.center() : null;
      const qs = new URLSearchParams({ q });
      if (c) { qs.set("lat", c.lat.toFixed(4)); qs.set("lng", c.lng.toFixed(4)); }
      const { items } = await api(`/api/suggest?${qs}`);
      if (my !== search.seq) return;
      search.items = items.map((it) => ({ sel: true, ...it }));
    }
    if (!search.items.length) search.items = [{ note: "Nenhum endereço encontrado. Tente incluir número, bairro e cidade." }];
    search.active = search.items[0]?.sel ? 0 : -1;
    renderSug();
  } catch (err) {
    console.error(err);
    if (my !== search.seq) return;
    search.items = [{ note: "Sugestões indisponíveis agora. Pressione Enter para localizar o endereço digitado." }];
    search.active = -1;
    renderSug();
  }
}

async function pickSuggestion(s) {
  closeSug();
  inputBusca.value = "";
  try {
    if (s.pred) {
      const place = s.pred.toPlace();
      await place.fetchFields({ fields: ["location", "formattedAddress", "displayName"] });
      search.token = null; // encerra a sessão de cobrança do autocomplete
      addPoint({ name: s.main, address: place.formattedAddress, lat: place.location.lat(), lng: place.location.lng() });
    } else {
      addPoint({ name: s.main, address: s.address, lat: s.lat, lng: s.lng });
    }
  } catch (err) {
    console.error(err);
    toast("Não foi possível obter a localização desse endereço.", true);
  }
}

async function geocodeViaServer(text) {
  footMsg("Localizando endereço…");
  try {
    const { results } = await api("/api/geocode", { addresses: [text] });
    const r = results[0].result;
    if (!r) throw new Error("Endereço não encontrado. Inclua número, bairro e cidade.");
    inputBusca.value = "";
    closeSug();
    addPoint({ address: r.formatted, lat: r.lat, lng: r.lng, name: shortName(text) });
  } catch (err) {
    toast(err.message, true);
  } finally { updateFooter(); }
}

inputBusca.addEventListener("input", () => {
  clearTimeout(search.timer);
  const q = inputBusca.value.trim();
  if (q.length < 3) { closeSug(); return; }
  search.timer = setTimeout(() => fetchSuggestions(q), 220);
});
inputBusca.addEventListener("keydown", (e) => {
  const real = search.items.filter((s) => s.sel);
  if (e.key === "ArrowDown" && real.length) { e.preventDefault(); search.active = (search.active + 1) % real.length; renderSug(); }
  else if (e.key === "ArrowUp" && real.length) { e.preventDefault(); search.active = (search.active - 1 + real.length) % real.length; renderSug(); }
  else if (e.key === "Escape") closeSug();
  else if (e.key === "Enter") {
    e.preventDefault();
    if (search.active >= 0 && search.items[search.active]?.sel) pickSuggestion(search.items[search.active]);
    else if (inputBusca.value.trim().length >= 3) geocodeViaServer(inputBusca.value.trim());
  }
});
listaSug.addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  e.preventDefault();
  pickSuggestion(search.items[Number(li.dataset.i)]);
});
inputBusca.addEventListener("blur", () => setTimeout(closeSug, 120));

/* ---- exemplo de Niterói (mesmos endereços do enunciado) ---- */
const EXEMPLO = [
  { name: "Escola de Engenharia UFF", address: "Rua Passo da Pátria, 156 - São Domingos, Niterói - RJ", lat: -22.90563, lng: -43.13306, isDepot: true, demand: 0 },
  { name: "Presidente Backer, 337", address: "Rua Presidente Backer, 337 - Icaraí, Niterói - RJ", lat: -22.90476, lng: -43.11059, demand: 100 },
  { name: "Rua da Conceição, 100", address: "Rua da Conceição, 100 - Centro, Niterói - RJ", lat: -22.89417, lng: -43.12251, demand: 80 },
  { name: "Av. Roberto Silveira, 512", address: "Avenida Roberto Silveira, 512 - Icaraí, Niterói - RJ", lat: -22.90338, lng: -43.10626, demand: 70 },
  { name: "Rua Nóbrega, 672", address: "Rua Nóbrega, 672 - Icaraí, Niterói - RJ", lat: -22.90592, lng: -43.10352, demand: 80 },
  { name: "Mal. Deodoro, 200", address: "Rua Marechal Deodoro, 200 - Centro, Niterói - RJ", lat: -22.89052, lng: -43.12061, demand: 100 },
  { name: "Leite Ribeiro, 212", address: "Rua Leite Ribeiro, 212 - Fonseca, Niterói - RJ", lat: -22.87718, lng: -43.10247, demand: 50 },
  { name: "Tenente Osório, 30", address: "Rua Tenente Osório, 30 - Fonseca, Niterói - RJ", lat: -22.88286, lng: -43.10438, demand: 60 },
];

$("#btn-exemplo").addEventListener("click", async () => {
  if (state.points.length && !confirmInline($("#btn-exemplo"), "Substituir pontos atuais?")) return;
  state.points = EXEMPLO.map((p) => ({ id: uid(), service: 5, twStart: state.opts.dayStart, twEnd: state.opts.dayEnd, ...p }));
  state.fleet = [];
  changed();
  ensureFleet();
  state.fleet[0] = { ...state.fleet[0], name: "Van", capacity: 300, qty: 2, costKm: 1, fixedCost: 0 };
  save();
  renderPoints();
  renderMap(true);
  toast("Exemplo carregado: 1 depósito e 7 clientes em Niterói.");
  refineExample(state.points.map((p) => p.id));
});

// Refina em segundo plano as coordenadas do exemplo pelo geocodificador do servidor
// (Google com chave; OpenStreetMap sem chave). Só aceita resultados a menos de 2 km do ponto embutido.
async function refineExample(ids) {
  const pts = ids.map((id) => state.points.find((p) => p.id === id)).filter(Boolean);
  try {
    const { results } = await api("/api/geocode", { addresses: pts.map((p) => p.address) });
    let n = 0;
    results.forEach((r, i) => {
      const p = pts[i], g = r.result;
      if (!g || !state.points.includes(p) || state.step !== 1) return;
      const dkm = Math.hypot(g.lat - p.lat, (g.lng - p.lng) * Math.cos((p.lat * Math.PI) / 180)) * 111;
      if (dkm < 2 && dkm > 0.01) { Object.assign(p, { lat: g.lat, lng: g.lng }); n++; }
    });
    if (n) { changed(); renderMap(); }
  } catch { /* mantém as coordenadas embutidas */ }
}
/* ---- importação de planilha (.xlsx / .csv) ---- */
async function xlsxLib() {
  if (!window.XLSX) await loadScript("/static/vendor/xlsx.full.min.js");
  return window.XLSX;
}
const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
function pickCol(row, names) {
  for (const k of Object.keys(row)) if (names.includes(norm(k))) return row[k];
  return undefined;
}
const truthy = (v) => ["sim", "s", "x", "1", "true", "yes", "deposito"].includes(norm(v ?? ""));
const asTime = (v) => {
  if (v === undefined || v === "") return undefined;
  if (typeof v === "number") return fmtClock(v * 24 * 60); // fração do dia (Excel)
  return String(v).slice(0, 5);
};

$("#btn-importar").addEventListener("click", () => $("#arquivo").click());
$("#arquivo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    footMsg("Lendo planilha…");
    const XLSX = await xlsxLib();
    let wb;
    if (/\.csv$/i.test(file.name)) {
      // CSV: aceita UTF-8 ou Windows-1252 (padrão do Excel em português) e separador ; ou ,
      const buf = await file.arrayBuffer();
      let text = new TextDecoder("utf-8").decode(buf);
      if (text.includes("\uFFFD")) text = new TextDecoder("windows-1252").decode(buf);
      const head = text.split(/\r?\n/)[0];
      const FS = (head.match(/;/g) || []).length > (head.match(/,/g) || []).length ? ";" : ",";
      wb = XLSX.read(text.replace(/^\uFEFF/, ""), { type: "string", FS });
    } else {
      wb = XLSX.read(await file.arrayBuffer());
    }
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    if (!rows.length) throw new Error("A planilha está vazia.");
    const items = rows.map((r) => ({
      address: String(pickCol(r, ["endereco", "address", "local"]) ?? "").trim(),
      name: String(pickCol(r, ["nome", "name", "cliente"]) ?? "").trim(),
      demand: Number(pickCol(r, ["demanda", "demand", "quantidade"]) || 0),
      isDepot: truthy(pickCol(r, ["deposito", "depot", "tipo"])),
      lat: Number(pickCol(r, ["lat", "latitude"])) || null,
      lng: Number(pickCol(r, ["lng", "lon", "long", "longitude"])) || null,
      twStart: asTime(pickCol(r, ["inicio", "abre", "janelainicio", "twstart"])),
      twEnd: asTime(pickCol(r, ["fim", "fecha", "janelafim", "twend"])),
      service: Number(pickCol(r, ["servico", "atendimento", "tempoatendimento", "service"]) || 5),
    })).filter((x) => x.address || (x.lat && x.lng));
    if (!items.length) throw new Error("Não achei a coluna 'endereco' (ou 'lat'/'lng') na planilha.");
    if (items.length > state.config.max_points) throw new Error(`A planilha tem ${items.length} pontos; o limite é ${state.config.max_points}.`);
    if (!items.some((x) => x.isDepot)) items[0].isDepot = true;
    const need = items.filter((x) => !(x.lat && x.lng));
    if (need.length) {
      footMsg(`Geocodificando ${need.length} endereço(s)…`);
      const { results } = await api("/api/geocode", { addresses: need.map((x) => x.address) });
      results.forEach((r, i) => { if (r.result) Object.assign(need[i], { lat: r.result.lat, lng: r.result.lng, formatted: r.result.formatted }); });
    }
    const ok = items.filter((x) => x.lat && x.lng);
    const fail = items.length - ok.length;
    if (!ok.length) throw new Error("Nenhum endereço da planilha foi localizado. Confira os endereços ou inclua colunas lat e lng.");
    state.points = ok.map((x) => ({
      id: uid(), name: x.name || shortName(x.address), address: x.formatted || x.address, lat: x.lat, lng: x.lng,
      demand: x.isDepot ? 0 : x.demand || 10, isDepot: x.isDepot, service: x.service,
      twStart: x.twStart || state.opts.dayStart, twEnd: x.twEnd || state.opts.dayEnd,
    }));
    if (items.some((x) => x.twStart || x.twEnd)) { state.opts.useTW = true; $("#usar-tw").checked = true; $("#tw-box").open = true; }
    fixFleetDepots();
    changed();
    renderPoints();
    renderMap(true);
    toast(fail ? `${ok.length} pontos importados; ${fail} endereço(s) não encontrado(s).` : `${ok.length} pontos importados.`, fail > 0);
  } catch (err) {
    toast(err.message, true);
  } finally { updateFooter(); }
});

/* ---- janelas de tempo ---- */
$("#usar-tw").addEventListener("change", (e) => { state.opts.useTW = e.target.checked; changed(); renderTWSummary(); renderPoints(); });
$("#jornada-ini").addEventListener("change", (e) => { state.opts.dayStart = e.target.value || "08:00"; changed(); });
$("#jornada-fim").addEventListener("change", (e) => { state.opts.dayEnd = e.target.value || "18:00"; changed(); });
function renderTWSummary() {
  const s = $("#tw-box summary strong");
  s.innerHTML = `Janelas de tempo${state.opts.useTW ? '<span class="tw-on">ativas</span>' : ""}`;
}

/* --------------------------------------------------------------------------
   Etapa 2 — frota
   -------------------------------------------------------------------------- */
const PRESETS = [
  { name: "Moto", capacity: 40, costKm: 0.4, fixedCost: 0 },
  { name: "Van", capacity: 300, costKm: 1.0, fixedCost: 0 },
  { name: "Caminhão 3/4", capacity: 800, costKm: 2.2, fixedCost: 0 },
];

function ensureFleet() {
  if (!state.fleet.length && depots().length) {
    state.fleet.push({ id: uid(), name: "Van", capacity: 300, qty: 2, costKm: 1, fixedCost: 0, depotId: depots()[0].id });
  }
  fixFleetDepots();
}
function fixFleetDepots() {
  const ids = depots().map((d) => d.id);
  state.fleet.forEach((v) => { if (!ids.includes(v.depotId)) v.depotId = ids[0] ?? null; });
}

function renderFleet() {
  const opts = depots().map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("");
  $("#lista-frota").innerHTML = state.fleet.map((v) => {
    const i = `v-${v.id}`;
    return `<li class="veh" data-id="${v.id}">
      <div class="veh-head">
        <span class="veh-ic">${TRUCK}</span>
        <label class="sr-only" for="${i}-nome">Nome do tipo de veículo</label>
        <input class="pt-name" id="${i}-nome" data-f="name" value="${esc(v.name)}" maxlength="40">
        ${state.fleet.length > 1 ? `<button type="button" class="icon-btn" data-act="del" aria-label="Remover ${esc(v.name)}">${TRASH}</button>` : ""}
      </div>
      <div class="grid-3">
        <div class="field"><label for="${i}-cap">Capacidade</label><input id="${i}-cap" data-f="capacity" type="number" min="1" step="1" inputmode="numeric" value="${esc(v.capacity)}"></div>
        <div class="field"><label for="${i}-qtd">Quantidade</label><input id="${i}-qtd" data-f="qty" type="number" min="1" max="100" step="1" inputmode="numeric" value="${esc(v.qty)}"></div>
        <div class="field"><label for="${i}-km">Custo por km</label><div class="input-prefix"><span>R$</span><input id="${i}-km" data-f="costKm" type="number" min="0" step="0.05" inputmode="decimal" value="${esc(v.costKm)}"></div></div>
      </div>
      <div class="grid-2">
        <div class="field"><label for="${i}-fixo">Custo fixo por uso</label><div class="input-prefix"><span>R$</span><input id="${i}-fixo" data-f="fixedCost" type="number" min="0" step="1" inputmode="decimal" value="${esc(v.fixedCost)}"></div></div>
        <div class="field"><label for="${i}-dep">Depósito de origem</label><select id="${i}-dep" data-f="depotId">${opts}</select></div>
      </div>
    </li>`;
  }).join("") + `<li class="presets" aria-label="Modelos rápidos">${PRESETS.map((p, k) => `<button type="button" class="chip" data-preset="${k}">+ ${esc(p.name)} · ${p.capacity}</button>`).join("")}</li>`;
  state.fleet.forEach((v) => { const s = $(`#v-${v.id}-dep`); if (s) s.value = v.depotId; });
  renderCapacity();
}

function renderCapacity() {
  const cap = state.fleet.reduce((s, v) => s + (Number(v.capacity) || 0) * (Number(v.qty) || 0), 0);
  const dem = totalDemand();
  const ok = cap >= dem && dem > 0;
  const pct = cap ? Math.min(100, (dem / cap) * 100) : 100;
  const el = $("#capacidade");
  el.className = `capacity ${ok ? "ok" : "bad"}`;
  el.innerHTML = `
    <div class="cap-row"><span>Demanda dos clientes</span><span>Capacidade da frota</span></div>
    <div class="cap-row"><strong class="num">${nf().format(dem)}</strong><strong class="num">${nf().format(cap)}</strong></div>
    <div class="bar" role="img" aria-label="Demanda ocupa ${nf().format(pct)}% da capacidade"><span style="width:${pct}%"></span></div>
    <p class="cap-msg">${ok ? `Frota suficiente · ocupação máxima de ${nf().format(pct)}%` : `Faltam ${nf().format(Math.max(0, dem - cap))} unidades de capacidade`}</p>`;
}

$("#lista-frota").addEventListener("input", (e) => {
  const li = e.target.closest(".veh");
  const f = e.target.dataset.f;
  if (!li || !f) return;
  const v = state.fleet.find((x) => x.id === li.dataset.id);
  v[f] = e.target.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value;
  e.target.removeAttribute("aria-invalid");
  changed();
  renderCapacity();
  updateFooter();
});
$("#lista-frota").addEventListener("click", (e) => {
  const pr = e.target.closest("[data-preset]");
  if (pr) {
    const p = PRESETS[Number(pr.dataset.preset)];
    state.fleet.push({ id: uid(), ...p, qty: 1, depotId: depots()[0]?.id ?? null });
    changed(); renderFleet(); updateFooter();
    return;
  }
  const del = e.target.closest('[data-act="del"]');
  if (del) {
    const id = del.closest(".veh").dataset.id;
    state.fleet = state.fleet.filter((v) => v.id !== id);
    changed(); renderFleet(); updateFooter();
  }
});
$("#btn-add-veiculo").addEventListener("click", () => {
  state.fleet.push({ id: uid(), name: `Veículo ${state.fleet.length + 1}`, capacity: 300, qty: 1, costKm: 1, fixedCost: 0, depotId: depots()[0]?.id ?? null });
  changed(); renderFleet(); updateFooter();
  $(`#v-${state.fleet.at(-1).id}-nome`)?.focus();
});
$("#retorna").addEventListener("change", (e) => { state.opts.returnToDepot = e.target.checked; changed(); });
$("#tempo-limite").addEventListener("change", (e) => { state.opts.timeLimit = Math.min(120, Math.max(5, Number(e.target.value) || 30)); e.target.value = state.opts.timeLimit; changed(); });

/* --------------------------------------------------------------------------
   Validação
   -------------------------------------------------------------------------- */
function invalid(sel, msg) {
  const el = $(sel);
  if (el) { el.setAttribute("aria-invalid", "true"); el.focus(); }
  footMsg(msg, true);
  return false;
}
function validatePoints() {
  if (!depots().length) { footMsg("Marque pelo menos um ponto como depósito.", true); return false; }
  if (!customers().length) { footMsg("Adicione pelo menos um cliente além do depósito.", true); return false; }
  for (const p of customers()) {
    const d = Number(p.demand);
    if (!(d > 0) || !Number.isInteger(d)) return invalid(`#p-${p.id}-dem`, `A demanda de “${p.name}” deve ser um número inteiro maior que zero.`);
  }
  if (state.opts.useTW) {
    const a = toMin(state.opts.dayStart), b = toMin(state.opts.dayEnd);
    if (b <= a) return invalid("#jornada-fim", "O fim da jornada deve ser depois da saída do depósito.");
    for (const p of customers()) {
      if (toMin(p.twEnd) < toMin(p.twStart)) return invalid(`#p-${p.id}-fim`, `A janela de “${p.name}” fecha antes de abrir.`);
      if (toMin(p.twStart) > b || toMin(p.twEnd) < a) return invalid(`#p-${p.id}-ini`, `A janela de “${p.name}” está fora da jornada.`);
    }
  }
  return true;
}
function validateFleet() {
  if (!state.fleet.length) { footMsg("Adicione pelo menos um tipo de veículo.", true); return false; }
  for (const v of state.fleet) {
    if (!(Number(v.capacity) > 0) || !Number.isInteger(Number(v.capacity))) return invalid(`#v-${v.id}-cap`, `A capacidade de “${v.name}” deve ser um inteiro maior que zero.`);
    if (!(Number(v.qty) >= 1) || !Number.isInteger(Number(v.qty))) return invalid(`#v-${v.id}-qtd`, `A quantidade de “${v.name}” deve ser pelo menos 1.`);
    if (!(Number(v.costKm) >= 0)) return invalid(`#v-${v.id}-km`, `O custo por km de “${v.name}” não pode ser negativo.`);
  }
  const maxCap = Math.max(...state.fleet.map((v) => Number(v.capacity)));
  const big = customers().find((p) => Number(p.demand) > maxCap);
  if (big) { footMsg(`“${big.name}” pede ${big.demand}, mais que o maior veículo (${maxCap}).`, true); return false; }
  const cap = state.fleet.reduce((s, v) => s + v.capacity * v.qty, 0);
  if (cap < totalDemand()) { footMsg("A capacidade total da frota não cobre a demanda.", true); return false; }
  return true;
}

/* --------------------------------------------------------------------------
   Navegação entre etapas
   -------------------------------------------------------------------------- */
function goto(step) {
  state.step = step;
  $$(".stage").forEach((s) => (s.hidden = s.id !== `stage-${step}`));
  $$(".step").forEach((b) => {
    const n = Number(b.dataset.step);
    if (n === step) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    b.classList.toggle("done", n < step);
  });
  $("#map-hint").hidden = !(step === 1 && G.ok);
  if (step === 2) { ensureFleet(); renderFleet(); $("#retorna").checked = state.opts.returnToDepot; $("#tempo-limite").value = state.opts.timeLimit; }
  if (step === 3) renderResult();
  if (step !== 3) G.hidden.clear();
  $(".panel-body").scrollTop = 0;
  updateFooter();
  renderMap(step === 3);
}

function updateFooter() {
  const back = $("#btn-voltar"), next = $("#btn-avancar");
  $$(".step").forEach((b) => {
    const n = Number(b.dataset.step);
    b.disabled = n === 3 ? !state.result : n === 2 ? !(depots().length && customers().length) : false;
  });
  footMsg("");
  if (state.step === 1) {
    back.hidden = true;
    next.textContent = "Próximo: frota";
    next.disabled = !state.points.length;
    if (state.points.length) footMsg(`${state.points.length} ponto(s) · demanda ${nf().format(totalDemand())}`);
  } else if (state.step === 2) {
    back.hidden = false; back.textContent = "Voltar";
    next.textContent = "Calcular rotas";
    next.disabled = false;
  } else {
    back.hidden = false; back.textContent = "Editar dados";
    next.textContent = "Baixar Excel";
    next.disabled = !state.result;
  }
}

$(".stepper").addEventListener("click", (e) => {
  const b = e.target.closest(".step");
  if (!b || b.disabled) return;
  const n = Number(b.dataset.step);
  if (n > state.step && state.step === 1 && !validatePoints()) return;
  goto(n);
});
$("#btn-voltar").addEventListener("click", () => goto(state.step === 3 ? 2 : 1));
$("#btn-avancar").addEventListener("click", () => {
  if (state.step === 1) { if (validatePoints()) goto(2); }
  else if (state.step === 2) { if (validateFleet()) runSolve(); }
  else exportExcel();
});

/* --------------------------------------------------------------------------
   Solução
   -------------------------------------------------------------------------- */
async function runSolve() {
  const pts = state.points.map((p) => ({ ...p }));
  const idx = new Map(pts.map((p, i) => [p.id, i]));
  const opts = { ...state.opts };
  const start = toMin(opts.dayStart);
  const payload = {
    points: pts.map((p) => ({
      name: p.name, address: p.address, lat: p.lat, lng: p.lng,
      demand: p.isDepot ? 0 : Number(p.demand), is_depot: p.isDepot,
      service_min: opts.useTW && !p.isDepot ? Number(p.service) || 0 : 0,
      tw_start: opts.useTW && !p.isDepot ? toMin(p.twStart) - start : null,
      tw_end: opts.useTW && !p.isDepot ? toMin(p.twEnd) - start : null,
    })),
    vehicles: state.fleet.map((v) => ({ name: v.name, capacity: Number(v.capacity), qty: Number(v.qty), cost_km: Number(v.costKm) || 0, fixed_cost: Number(v.fixedCost) || 0, depot: idx.get(v.depotId) })),
    options: { return_to_depot: opts.returnToDepot, use_time_windows: opts.useTW, time_limit: Number(opts.timeLimit) || 30, horizon_min: Math.max(1, toMin(opts.dayEnd) - start) },
  };
  const ov = $("#overlay");
  ov.hidden = false;
  $("#btn-avancar").disabled = true;
  try {
    const data = await api("/api/solve", payload);
    data.points = pts;
    data.pointIds = pts.map((p) => p.id);
    data.opts = opts;
    data.fleet = state.fleet.map((v) => ({ ...v }));
    state.result = data;
    G.hidden.clear();
    goto(3);
  } catch (err) {
    toast(err.message || "Falha ao calcular as rotas.", true);
    footMsg(err.message, true);
  } finally {
    ov.hidden = true;
    $("#btn-avancar").disabled = false;
  }
}

const STATUS_UI = {
  otimo: ["ok", '<path d="M5 12.5l4.5 4.5L19 7.5"/>', "Solução ótima provada"],
  viavel: ["warn", '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>', "Solução viável (tempo limite atingido)"],
  sem_solucao: ["bad", '<path d="M6 6l12 12M18 6 6 18"/>', "Nenhuma solução encontrada"],
  inviavel: ["bad", '<path d="M6 6l12 12M18 6 6 18"/>', "Problema inviável"],
  erro: ["bad", '<path d="M6 6l12 12M18 6 6 18"/>', "Erro no solver"],
};
const SOURCE_TXT = {
  google: ["Distâncias e tempos reais pelas ruas · Google Routes API", false],
  osrm: ["Distâncias e tempos reais pelas ruas · OpenStreetMap (OSRM, gratuito)", false],
  haversine: ["Distâncias estimadas (linha reta × 1,35): o serviço de rotas do OpenStreetMap não respondeu. Tente recalcular.", true],
};

function mapsLinks(r, res) {
  const ptById = new Map(res.points.map((p) => [p.id, p]));
  const ll = (i) => { const p = ptById.get(res.pointIds[i]); return `${p.lat},${p.lng}`; };
  const seq = [r.depot, ...r.stops, ...(res.opts.returnToDepot ? [r.depot] : [])];
  // O Google Maps aceita até 9 paradas intermediárias por link: rotas longas viram partes
  const links = [];
  for (let s = 0; s < seq.length - 1; s += 10) {
    const part = seq.slice(s, s + 11);
    const u = new URL("https://www.google.com/maps/dir/");
    u.searchParams.set("api", "1");
    u.searchParams.set("origin", ll(part[0]));
    u.searchParams.set("destination", ll(part.at(-1)));
    if (part.length > 2) u.searchParams.set("waypoints", part.slice(1, -1).map(ll).join("|"));
    u.searchParams.set("travelmode", "driving");
    links.push(u.toString());
  }
  return links;
}

function renderResult() {
  const res = state.result;
  const box = $("#resultado");
  if (!res) { box.innerHTML = '<p class="muted">Calcule as rotas na etapa Frota.</p>'; return; }
  const ex = res.exact, h = res.heuristic, t = res.totals;
  const [cls, icon, title] = STATUS_UI[ex.status] || STATUS_UI.erro;
  const subtitle = ex.status !== "otimo" ? ex.message
    : ex.status_code === 2 ? "O solver provou que nenhuma solução supera a da heurística."
      : "O limite inferior encontrou o custo da solução: não existe rota mais barata.";
  const ptById = new Map(res.points.map((p) => [p.id, p]));
  const P = (i) => ptById.get(res.pointIds[i]);
  const start = toMin(res.opts.dayStart);
  const occ = t.capacity_used ? (t.load / t.capacity_used) * 100 : 0;

  if (!ex.routes.length) {
    box.innerHTML = `<div class="status ${cls}"><svg viewBox="0 0 24 24">${icon}</svg><div><strong>${title}</strong><span>${esc(ex.message)}</span></div></div>
      <p class="muted">Tente aumentar a frota, o tempo máximo do solver ou afrouxar as janelas de tempo.</p>`;
    return;
  }

  const maxCost = Math.max(ex.cost, h.feasible ? h.cost : 0);
  const gap = res.gap_pct;
  const gapPill = !h.feasible ? '<span class="gap-pill pos">C&amp;W inviável com esta frota</span>'
    : gap > 0.005 ? `<span class="gap-pill pos">C&amp;W ${nf(1).format(gap)}% acima do ótimo</span>`
      : '<span class="gap-pill">C&amp;W já atingiu o ótimo</span>';
  const [srcTxt, srcEst] = SOURCE_TXT[res.matrix.source] || SOURCE_TXT.haversine;
  const st = ex.stats || {};

  box.innerHTML = `
    <div class="status ${cls}"><svg viewBox="0 0 24 24">${icon}</svg><div><strong>${title}</strong><span>${esc(subtitle)}</span></div></div>

    <section class="kpis" aria-label="Indicadores">
      <div class="kpi main"><div><p class="kpi-l">Custo total</p><p class="kpi-v">${brl.format(ex.cost)}</p></div>
        <div class="kpi-side">${t.vehicles_used} veículo${t.vehicles_used !== 1 ? "s" : ""}<br>${res.points.filter((p) => !p.isDepot).length} clientes</div></div>
      <div class="kpi"><p class="kpi-l">Distância</p><p class="kpi-v">${nf(1).format(t.dist_km)}<small>km</small></p></div>
      <div class="kpi"><p class="kpi-l">Tempo total</p><p class="kpi-v">${fmtDur(t.time_min)}</p></div>
      <div class="kpi"><p class="kpi-l">Ocupação média</p><p class="kpi-v">${nf().format(occ)}<small>%</small></p></div>
      <div class="kpi"><p class="kpi-l">Tempo de cálculo</p><p class="kpi-v">${nf(2).format(ex.time_s)}<small>s</small></p></div>
    </section>

    <section class="compare" aria-labelledby="cmp-t">
      <h3 id="cmp-t">Exato × heurística ${gapPill}</h3>
      <div class="cmp-row"><span>VRPSolverEasy<br><span class="cmp-meta">branch-cut-and-price</span></span><div class="bar"><span style="width:${(ex.cost / maxCost) * 100}%"></span></div><span class="cmp-v">${brl.format(ex.cost)}</span></div>
      <div class="cmp-row h"><span>Clarke &amp; Wright<br><span class="cmp-meta">savings · ${h.time_s < 0.001 ? "< 1 ms" : `${nf(3).format(h.time_s)} s`}</span></span><div class="bar"><span style="width:${h.feasible ? (h.cost / maxCost) * 100 : 0}%"></span></div><span class="cmp-v">${h.feasible ? brl.format(h.cost) : "—"}</span></div>
    </section>

    <h3 class="list-title spaced">Rotas <span class="count">${ex.routes.length}</span></h3>
    <ol class="routes">
      ${ex.routes.map((r, ri) => {
        const dep = P(r.depot);
        const links = mapsLinks(r, res);
        const loadPct = r.capacity ? (r.load / r.capacity) * 100 : 0;
        return `<li class="route" data-ri="${ri}" style="--c:${colorOf(ri)}">
          <div class="route-head">
            <span class="route-dot">${ri + 1}</span>
            <div><p class="route-t">Rota ${ri + 1} · ${esc(r.vehicle_name)}</p><p class="route-s">Sai de ${esc(dep.name)}</p></div>
            <p class="route-cost">${brl.format(r.cost)}</p>
          </div>
          <p class="route-stats"><span><b>${nf(1).format(r.dist_km)}</b> km</span><span><b>${fmtDur(r.time_min)}</b></span><span><b>${r.stops.length}</b> paradas</span><span>carga <b>${nf().format(r.load)}</b>/${nf().format(r.capacity)}</span></p>
          <div class="route-load"><div class="bar" role="img" aria-label="Ocupação de ${nf().format(loadPct)}%"><span style="width:${loadPct}%"></span></div></div>
          <details>
            <summary>Sequência de entregas <span class="chev" aria-hidden="true"></span></summary>
            <ol class="stops">
              <li class="stop dep"><span class="stop-n">${HOUSE.replace("<svg", '<svg width="11" height="11" fill="currentColor"')}</span><span><span class="stop-name">${esc(dep.name)}</span><br><span class="stop-addr">Saída</span></span><span class="stop-t">${fmtClock(start)}</span></li>
              ${r.stops.map((s, k) => { const p = P(s); const late = res.opts.useTW ? ` · janela ${esc(p.twStart)}–${esc(p.twEnd)}` : ""; return `<li class="stop"><span class="stop-n">${k + 1}</span><span><span class="stop-name">${esc(p.name)}</span><br><span class="stop-addr">${esc(p.address)} · ${nf().format(p.demand)} un.${late}</span></span><span class="stop-t">${fmtClock(start + r.arrivals[k])}</span></li>`; }).join("")}
              ${res.opts.returnToDepot ? `<li class="stop dep"><span class="stop-n">${HOUSE.replace("<svg", '<svg width="11" height="11" fill="currentColor"')}</span><span><span class="stop-name">${esc(dep.name)}</span><br><span class="stop-addr">Retorno</span></span><span class="stop-t">${fmtClock(start + r.time_min)}</span></li>` : ""}
            </ol>
          </details>
          <div class="route-actions">
            ${links.map((u, k) => `<a class="btn btn-ghost btn-sm" href="${esc(u)}" target="_blank" rel="noopener">${PIN} ${links.length > 1 ? `Google Maps · parte ${k + 1}` : "Abrir no Google Maps"}</a>`).join("")}
            ${G.ok ? `<button type="button" class="btn btn-ghost btn-sm" data-focus="${ri}">Ver no mapa</button>` : ""}
          </div>
        </li>`;
      }).join("")}
    </ol>

    <div class="result-actions">
      <button type="button" class="btn btn-secondary" id="btn-print">Imprimir / PDF</button>
      <button type="button" class="btn btn-secondary" id="btn-json">Baixar JSON</button>
    </div>

    <details class="method">
      <summary>Detalhes do método</summary>
      <div class="method-body">
        <p>O problema é resolvido de forma <strong>exata</strong> pelo VRPSolverEasy (branch-cut-and-price, BaPCod + CLP). A heurística de Clarke &amp; Wright roda antes e serve de comparação e de limite superior para o solver.</p>
        <dl>
          <dt>Custo ótimo</dt><dd>${brl.format(ex.cost)}</dd>
          ${st.root_lb != null ? `<dt>Limite inferior (raiz)</dt><dd>${nf(3).format(st.root_lb)}</dd>` : ""}
          ${st.best_lb != null ? `<dt>Melhor limite inferior</dt><dd>${nf(3).format(st.best_lb)}</dd>` : ""}
          ${st.bb_nodes != null ? `<dt>Nós de branch-and-bound</dt><dd>${st.bb_nodes}</dd>` : ""}
          <dt>Tempo do solver</dt><dd>${nf(3).format(ex.time_s)} s</dd>
          <dt>Tempo da matriz</dt><dd>${nf(2).format(res.matrix.time_s)} s</dd>
          <dt>Variante</dt><dd>${[
            new Set(res.fleet.map((v) => `${v.capacity}|${v.costKm}|${v.fixedCost}`)).size > 1 ? "frota heterogênea" : "frota homogênea",
            res.points.filter((p) => p.isDepot).length > 1 ? "multidepósito" : "depósito único",
            res.opts.useTW ? "com janelas de tempo" : "sem janelas",
            res.opts.returnToDepot ? "rotas fechadas" : "rotas abertas",
          ].join(" · ")}</dd>
        </dl>
      </div>
    </details>
    <p class="source-tag ${srcEst ? "est" : ""}"><i></i>${esc(srcTxt)}</p>`;

  $("#btn-print").addEventListener("click", () => { $$(".route details").forEach((d) => (d.open = true)); window.print(); });
  $("#btn-json").addEventListener("click", () => download(new Blob([JSON.stringify(res, null, 2)], { type: "application/json" }), "rotas.json"));
}

$("#resultado").addEventListener("click", (e) => {
  const f = e.target.closest("[data-focus]");
  if (f) focusRoute(Number(f.dataset.focus));
});
$("#resultado").addEventListener("mouseover", (e) => {
  const r = e.target.closest(".route");
  if (r && G.ok && !G.hidden.size) setRouteEmphasis(Number(r.dataset.ri));
});
$("#resultado").addEventListener("mouseleave", () => { if (G.ok && !G.hidden.size) setRouteEmphasis(null); });
$("#legenda").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-ri]");
  if (!b) return;
  const ri = Number(b.dataset.ri);
  if (G.hidden.has(ri)) G.hidden.delete(ri); else G.hidden.add(ri);
  b.setAttribute("aria-pressed", String(!G.hidden.has(ri)));
  setRouteEmphasis(null);
});

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function exportExcel() {
  const res = state.result;
  if (!res) return;
  try {
    const XLSX = await xlsxLib();
    const ptById = new Map(res.points.map((p) => [p.id, p]));
    const P = (i) => ptById.get(res.pointIds[i]);
    const start = toMin(res.opts.dayStart);
    const resumo = [
      ["Rota Roda — Roteirizador VRP (UFF)"],
      ["Desenvolvido por Daniel Neves, Juan Souza, Pedro Souza e Pedro Jensen"],
      [],
      ["Status", STATUS_UI[res.exact.status]?.[2] || res.exact.status],
      ["Custo total (R$)", res.exact.cost],
      ["Distância total (km)", res.totals.dist_km],
      ["Tempo total (min)", res.totals.time_min],
      ["Veículos usados", res.totals.vehicles_used],
      ["Custo Clarke & Wright (R$)", res.heuristic.feasible ? res.heuristic.cost : "inviável"],
      ["Gap C&W vs ótimo (%)", res.gap_pct ?? "—"],
      ["Tempo do solver (s)", res.exact.time_s],
      ["Fonte das distâncias", SOURCE_TXT[res.matrix.source]?.[0] || res.matrix.source],
    ];
    const rotas = [["Rota", "Veículo", "Ordem", "Ponto", "Endereço", "Demanda", "Carga acumulada", "Chegada prevista", "Latitude", "Longitude"]];
    res.exact.routes.forEach((r, ri) => {
      const d = P(r.depot);
      rotas.push([ri + 1, r.vehicle_name, 0, d.name, d.address, 0, 0, fmtClock(start), d.lat, d.lng]);
      let acc = 0;
      r.stops.forEach((s, k) => { const p = P(s); acc += Number(p.demand); rotas.push([ri + 1, r.vehicle_name, k + 1, p.name, p.address, Number(p.demand), acc, fmtClock(start + r.arrivals[k]), p.lat, p.lng]); });
      if (res.opts.returnToDepot) rotas.push([ri + 1, r.vehicle_name, r.stops.length + 1, d.name, d.address, 0, acc, fmtClock(start + r.time_min), d.lat, d.lng]);
    });
    const porRota = [["Rota", "Veículo", "Paradas", "Carga", "Capacidade", "Distância (km)", "Tempo (min)", "Custo (R$)"]]
      .concat(res.exact.routes.map((r, ri) => [ri + 1, r.vehicle_name, r.stops.length, r.load, r.capacity, r.dist_km, r.time_min, r.cost]));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(resumo), "Resumo");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(porRota), "Por rota");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rotas), "Sequência");
    XLSX.writeFile(wb, "rotas_otimizadas.xlsx");
  } catch (err) {
    toast("Não foi possível gerar o Excel: " + err.message, true);
  }
}

/* --------------------------------------------------------------------------
   Início
   -------------------------------------------------------------------------- */
async function boot() {
  load();
  $("#usar-tw").checked = state.opts.useTW;
  $("#jornada-ini").value = state.opts.dayStart;
  $("#jornada-fim").value = state.opts.dayEnd;
  if (state.opts.useTW) $("#tw-box").open = true;
  renderTWSummary();
  renderPoints();
  goto(1);
  try { state.config = { ...state.config, ...(await api("/api/config")) }; } catch { /* usa padrão */ }
  await initMap();
  goto(1);
}
boot();
