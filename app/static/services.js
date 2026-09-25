/* ==========================================================================
   Rota Roda — serviços gratuitos chamados direto do navegador (sem chave)
   • Endereços: Photon + Nominatim (OpenStreetMap)
   • CEP: ViaCEP (com BrasilAPI como reserva)
   • Clima: Open-Meteo
   • Postos de combustível: Overpass (OpenStreetMap)
   Rodar no navegador usa a conexão de quem está usando o app. Servidores
   gratuitos na nuvem costumam ser bloqueados por esses serviços públicos.
   ========================================================================== */

export async function fetchJSON(url, { timeout = 15000, ...init } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const UF = {
  "Acre": "AC", "Alagoas": "AL", "Amapá": "AP", "Amazonas": "AM", "Bahia": "BA", "Ceará": "CE",
  "Distrito Federal": "DF", "Espírito Santo": "ES", "Goiás": "GO", "Maranhão": "MA", "Mato Grosso": "MT",
  "Mato Grosso do Sul": "MS", "Minas Gerais": "MG", "Pará": "PA", "Paraíba": "PB", "Paraná": "PR",
  "Pernambuco": "PE", "Piauí": "PI", "Rio de Janeiro": "RJ", "Rio Grande do Norte": "RN",
  "Rio Grande do Sul": "RS", "Rondônia": "RO", "Roraima": "RR", "Santa Catarina": "SC",
  "São Paulo": "SP", "Sergipe": "SE", "Tocantins": "TO",
};

function photonLabel(pr) {
  const street = pr.street || "", num = pr.housenumber || "", name = pr.name || "";
  let main = street && num ? `${street}, ${num}` : (street || name);
  if (name && street && name !== street && name !== main) main = `${name} · ${main}`;
  const area = pr.district || pr.locality || pr.suburb || "";
  const city = pr.city || pr.county || "";
  const uf = UF[pr.state] || pr.state || "";
  const sec = [[area, city].filter(Boolean).join(", "), uf].filter(Boolean).join(" - ");
  return { main: main || sec, sec, address: [main, sec].filter(Boolean).join(", ") };
}

function nominatimItem(it) {
  const parts = String(it.display_name || "").split(", ");
  return { main: parts.slice(0, 2).join(", "), sec: parts.slice(2, 5).join(", "), address: it.display_name, lat: Number(it.lat), lng: Number(it.lon) };
}

// Nominatim pede no máximo 1 requisição por segundo
let lastNominatim = 0;
async function nominatim(path, params) {
  const wait = 1100 - (Date.now() - lastNominatim);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatim = Date.now();
  const qs = new URLSearchParams({ format: "json", "accept-language": "pt-BR", ...params });
  return fetchJSON(`https://nominatim.openstreetmap.org/${path}?${qs}`);
}

export const OSM = {
  /** Sugestões enquanto digita (Photon; Nominatim como reserva). */
  async suggest(q, center) {
    try {
      const qs = new URLSearchParams({ q, limit: "12" });
      if (center) { qs.set("lat", center.lat.toFixed(4)); qs.set("lon", center.lng.toFixed(4)); }
      const d = await fetchJSON(`https://photon.komoot.io/api/?${qs}`, { timeout: 8000 });
      const items = (d.features || [])
        .filter((f) => ["BR", ""].includes(String(f.properties?.countrycode || "").toUpperCase()))
        .map((f) => ({ ...photonLabel(f.properties || {}), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
      const seen = new Set();
      const uniq = items.filter((i) => { const k = i.address; if (seen.has(k)) return false; seen.add(k); return true; });
      if (uniq.length) return uniq.slice(0, 6);
    } catch { /* tenta o Nominatim */ }
    const d = await nominatim("search", { q, limit: "5", countrycodes: "br" });
    return d.map(nominatimItem);
  },

  /** Endereço digitado → coordenada (Nominatim; Photon como reserva). */
  async search(text) {
    try {
      const d = await nominatim("search", { q: text, limit: "1", countrycodes: "br" });
      if (d.length) return nominatimItem(d[0]);
    } catch { /* tenta o Photon */ }
    const s = await OSM.suggest(text);
    return s[0] || null;
  },

  /** Coordenada → endereço (clique no mapa / marcador arrastado). */
  async reverse(lat, lng) {
    try {
      const d = await fetchJSON(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}`, { timeout: 8000 });
      const f = d.features?.[0];
      if (f) return photonLabel(f.properties || {}).address;
    } catch { /* tenta o Nominatim */ }
    try {
      const d = await nominatim("reverse", { lat, lon: lng, zoom: "18" });
      return d.display_name || null;
    } catch { return null; }
  },

  /** Vários endereços em sequência (respeita 1 req/s). */
  async batch(addresses, onProgress) {
    const out = [];
    for (let i = 0; i < addresses.length; i++) {
      onProgress?.(i, addresses.length);
      try { out.push(await OSM.search(addresses[i])); } catch { out.push(null); }
    }
    return out;
  },
};

/* ---------------------------- CEP ---------------------------------------- */
export const isCEP = (s) => /^\s*\d{5}-?\d{3}\s*$/.test(s);

export async function lookupCEP(raw) {
  const cep = String(raw).replace(/\D/g, "");
  try {
    const d = await fetchJSON(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 8000 });
    if (!d.erro) return { cep, street: d.logradouro, district: d.bairro, city: d.localidade, uf: d.uf };
  } catch { /* tenta a BrasilAPI */ }
  const d = await fetchJSON(`https://brasilapi.com.br/api/cep/v2/${cep}`, { timeout: 8000 });
  const c = d.location?.coordinates || {};
  return { cep, street: d.street, district: d.neighborhood, city: d.city, uf: d.state,
    lat: c.latitude ? Number(c.latitude) : null, lng: c.longitude ? Number(c.longitude) : null };
}

export function cepAddress(c, number = "") {
  const street = [c.street, number].filter(Boolean).join(", ");
  return [street, c.district, `${c.city} - ${c.uf}`].filter(Boolean).join(", ");
}

/* ---------------------------- Clima -------------------------------------- */
const WMO = [
  [[0], "☀️", "céu limpo"], [[1, 2], "🌤️", "poucas nuvens"], [[3], "☁️", "nublado"],
  [[45, 48], "🌫️", "neblina"], [[51, 53, 55, 56, 57], "🌦️", "garoa"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "🌧️", "chuva"], [[71, 73, 75, 77, 85, 86], "❄️", "neve"],
  [[95, 96, 99], "⛈️", "tempestade"],
];
export const weatherInfo = (code) => { const w = WMO.find(([c]) => c.includes(code)); return w ? { icon: w[1], text: w[2] } : { icon: "🌡️", text: "" }; };

/** Previsão horária de hoje (Open-Meteo, sem chave). */
export async function forecast(lat, lng) {
  const qs = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lng.toFixed(4), timezone: "America/Sao_Paulo", forecast_days: "2",
    hourly: "temperature_2m,precipitation_probability,weather_code",
  });
  const d = await fetchJSON(`https://api.open-meteo.com/v1/forecast?${qs}`, { timeout: 10000 });
  return d.hourly; // { time: ["2026-09-25T08:00", ...], temperature_2m, precipitation_probability, weather_code }
}

/** Resume o clima entre dois horários (minutos do dia) de hoje. */
export function summarizeWeather(hourly, startMin, endMin, day = new Date()) {
  const ymd = day.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }); // AAAA-MM-DD
  const h0 = Math.floor(startMin / 60), h1 = Math.min(23, Math.floor(endMin / 60));
  const idx = hourly.time.map((t, i) => [t, i]).filter(([t]) => t.startsWith(ymd) && +t.slice(11, 13) >= h0 && +t.slice(11, 13) <= h1).map(([, i]) => i);
  if (!idx.length) return null;
  const rain = Math.max(...idx.map((i) => hourly.precipitation_probability[i] ?? 0));
  const temps = idx.map((i) => hourly.temperature_2m[i]);
  const worst = idx.map((i) => hourly.weather_code[i]).sort((a, b) => b - a)[0];
  return { rain, tmin: Math.min(...temps), tmax: Math.max(...temps), code: worst };
}

/* ---------------------------- Postos (Overpass) -------------------------- */
export async function fuelStations(bbox) {
  // bbox = [sul, oeste, norte, leste]
  const q = `[out:json][timeout:25];(node["amenity"="fuel"](${bbox.join(",")});way["amenity"="fuel"](${bbox.join(",")}););out center 80;`;
  const d = await fetchJSON("https://overpass-api.de/api/interpreter", {
    method: "POST", body: new URLSearchParams({ data: q }), timeout: 30000,
  });
  return (d.elements || []).map((e) => ({
    lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
    name: e.tags?.name || e.tags?.brand || "Posto de combustível", brand: e.tags?.brand || "",
  })).filter((p) => p.lat && p.lng);
}

/* ---------------------------- Compartilhar ------------------------------- */
export function whatsappLink(text) {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

export function qrSvg(text, cell = 5) {
  // qrcode-generator (MIT) carregado como script global em /static/vendor/qrcode.js
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}
