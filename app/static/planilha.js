/* ==========================================================================
   Rota Roda — leitura de planilhas de pontos (.xlsx, .xls, .ods, .csv)
   Tolerante ao que as pessoas fazem de verdade com uma planilha:
   • título e instruções acima do cabeçalho;
   • nomes de coluna livres ("Endereço completo", "Demanda (kg)", "Depósito?");
   • endereço inteiro numa coluna OU separado em rua / número / bairro / cidade;
   • planilha sem cabeçalho, só com endereços colados;
   • CEP digitado como número (perde o zero da frente), vírgula decimal, horários
     como "9h", "09:00" ou fração do dia do Excel.
   Funções puras (sem DOM): recebem a biblioteca SheetJS por parâmetro.
   ========================================================================== */

/** Erro com mensagem pronta para mostrar a quem está usando o app. */
export class PlanilhaError extends Error {}

export const norm = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9]/g, "");

// Ordem importa: a primeira regra que casar define o campo da coluna
const FIELDS = [
  ["lat", /^(lat|latitude)$/],
  ["lng", /^(lng|lon|long|longitude)$/],
  ["cep", /^cep/],
  ["number", /^(numero|num|nro|no|n)$/],
  ["district", /^bairro/],
  ["city", /^(cidade|municipio)/],
  ["uf", /^(uf|estado)$/],
  ["street", /^(rua|logradouro|avenida|via)/],
  ["address", /(endereco|^address|^local$|^localizacao)/],
  ["name", /^(nome|cliente|ponto|loja|descricao|razaosocial|name|destinatario)/],
  ["demand", /^(demanda|quantidade|qtd|qtde|volume|carga|pedido|demand|peso|caixas)/],
  ["depot", /^(deposito|depot|tipo|cd$|origem|base$)/],
  ["twStart", /(inicio|^abre|abertura|apartir|twstart|^de$|^das$)/],
  ["twEnd", /(^fim|fecha|termino|twend|^ate$|^as$)/],
  ["service", /(servico|atendimento|descarga|parada|service)/],
];

const LOCATING = ["address", "street", "cep", "lat"];

export function fieldOf(header) {
  const raw = String(header ?? "").trim();
  // frases longas são instruções e células com número são dados ("Rua X, 100"), não cabeçalho
  if (!raw || raw.length > 45 || /\d/.test(raw)) return null;
  const n = norm(raw);
  if (!n) return null;
  for (const [f, re] of FIELDS) if (re.test(n)) return f;
  return null;
}

function mapHeader(row) {
  const map = {};
  row.forEach((cell, i) => {
    const f = fieldOf(cell);
    if (f && map[f] === undefined) map[f] = i;
  });
  return map;
}

const looksLikeAddress = (v) => typeof v === "string" && /[a-zA-ZÀ-ú]{3}/.test(v) && (v.includes(",") || /\d/.test(v)) && v.length >= 8;
const looksLikeCEP = (v) => /^\s*\d{5}-?\d{3}\s*$/.test(String(v ?? "")) || (typeof v === "number" && v >= 1000000 && v <= 99999999);

/** Encontra a linha de cabeçalho (até a linha 25) ou deduz a coluna de endereço. */
export function locateTable(rows) {
  const lim = Math.min(rows.length, 25);
  for (let r = 0; r < lim; r++) {
    const map = mapHeader(rows[r] || []);
    if (LOCATING.some((f) => map[f] !== undefined)) return { headerRow: r, map };
  }
  // Sem cabeçalho: procura a coluna em que a maioria das células parece endereço ou CEP
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => (r || []).length));
  let best = null;
  for (let c = 0; c < width; c++) {
    const vals = rows.slice(0, 50).map((r) => (r || [])[c]).filter((v) => v !== "" && v != null);
    if (!vals.length) continue;
    const addr = vals.filter(looksLikeAddress).length / vals.length;
    const cep = vals.filter(looksLikeCEP).length / vals.length;
    if (addr >= 0.6 && (!best || addr > best.score)) best = { score: addr, map: { address: c } };
    else if (cep >= 0.6 && !best) best = { score: cep, map: { cep: c } };
  }
  return best ? { headerRow: -1, map: best.map } : null;
}

/* ---------------------------- conversores -------------------------------- */
const str = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

export function toNumber(v) {
  if (v === "" || v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^\d,.\-]/g, "");
  // o último separador é o decimal: "1.200,50" (Brasil) ou "1,200.50"
  if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function toCEP(v) {
  if (v === "" || v == null) return "";
  let d = String(typeof v === "number" ? Math.round(v) : v).replace(/\D/g, "");
  if (d.length === 7) d = "0" + d; // Excel come o zero da frente (ex.: 01310-100)
  return d.length === 8 ? d : "";
}

/** "9h", "9h30", "09:00", "9:00:00", 0.375 (fração do dia) ou Date → "HH:MM". */
export function toClock(v) {
  if (v === "" || v == null) return undefined;
  let min = null;
  if (v instanceof Date) min = v.getHours() * 60 + v.getMinutes();
  else if (typeof v === "number") min = v < 1 ? Math.round(v * 1440) : v <= 24 ? v * 60 : null;
  else {
    const m = String(v).trim().toLowerCase().match(/^(\d{1,2})\s*(?:[:h]\s*(\d{2})?)?/);
    if (m) min = Number(m[1]) * 60 + Number(m[2] || 0);
  }
  if (min == null || min < 0 || min >= 1440) return undefined;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

const DEPOT_WORDS = new Set(["sim", "s", "x", "1", "true", "yes", "y", "deposito", "cd", "origem", "base", "garagem", "saida", "verdadeiro"]);
export const isDepotValue = (v) => DEPOT_WORDS.has(norm(v));

function coord(v, max) {
  const n = toNumber(v);
  return n != null && Math.abs(n) <= max && n !== 0 ? n : null;
}

/** Converte as linhas de uma aba em pontos. */
export function rowsToItems(rows, table) {
  const { headerRow, map } = table;
  const get = (row, f) => (map[f] === undefined ? "" : row[map[f]]);
  const items = [];
  let blankDemand = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!row.some((c) => str(c) !== "")) continue;
    const it = {
      line: r + 1,
      name: str(get(row, "name")),
      address: str(get(row, "address")),
      cep: toCEP(get(row, "cep")),
      number: str(get(row, "number")),
      lat: coord(get(row, "lat"), 90),
      lng: coord(get(row, "lng"), 180),
      demand: toNumber(get(row, "demand")),
      isDepot: isDepotValue(get(row, "depot")),
      twStart: toClock(get(row, "twStart")),
      twEnd: toClock(get(row, "twEnd")),
      service: toNumber(get(row, "service")),
    };
    const street = str(get(row, "street")), district = str(get(row, "district"));
    const city = str(get(row, "city")), uf = str(get(row, "uf"));
    if (!it.address && street) {
      it.address = [[street, it.number].filter(Boolean).join(", "), district, [city, uf].filter(Boolean).join(" - ")]
        .filter(Boolean).join(", ");
    } else if (it.address) {
      if (it.number && !/\d/.test(it.address)) it.address = `${it.address}, ${it.number}`;
      if (city && !norm(it.address).includes(norm(city))) it.address += `, ${[city, uf].filter(Boolean).join(" - ")}`;
    }
    if (!(it.lat && it.lng)) { it.lat = null; it.lng = null; }
    // linha sem nenhuma forma de localizar (ex.: "Depósito" pré-preenchido sem endereço) é ignorada
    if (!it.address && !it.cep && !it.lat) continue;
    if (it.demand != null) it.demand = Math.max(0, Math.round(it.demand));
    if (it.service != null) it.service = Math.max(0, Math.round(it.service));
    if (!it.isDepot && it.demand == null) blankDemand++;
    items.push(it);
  }
  return { items, blankDemand };
}

const SKIP_SHEETS = /^(comousar|instruc|leiame|ajuda|readme|legenda)/;

/**
 * Lê o arquivo inteiro e escolhe a aba certa.
 * Preferência: aba "Pontos" preenchida → outra aba preenchida → aba "Exemplo".
 */
export function readWorkbook(XLSX, wb) {
  const sheets = [];
  for (const name of wb.SheetNames) {
    if (SKIP_SHEETS.test(norm(name))) continue;
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true, blankrows: true });
    const table = locateTable(rows);
    const parsed = table ? rowsToItems(rows, table) : { items: [], blankDemand: 0 };
    sheets.push({ name, table, ...parsed, isExample: /^exemplo/.test(norm(name)) });
  }
  const filled = sheets.filter((s) => s.items.length);
  const pick = filled.find((s) => norm(s.name) === "pontos") || filled.find((s) => !s.isExample) || filled[0];
  if (!pick) {
    const withHeader = sheets.find((s) => s.table && s.table.headerRow >= 0);
    if (withHeader) {
      throw new PlanilhaError(`A aba “${withHeader.name}” tem o cabeçalho, mas nenhuma linha com endereço. Cole os endereços na coluna Endereço, uma linha por ponto.`);
    }
    throw new PlanilhaError("Não encontrei uma coluna de endereço. Use o botão Modelo .xlsx ou dê à coluna o nome “Endereço” (também servem CEP, Rua ou Latitude/Longitude).");
  }
  return {
    sheet: pick.name,
    items: pick.items,
    blankDemand: pick.blankDemand,
    usedExample: pick.isExample && filled.length === 1,
    columns: Object.keys(pick.table.map),
    headerless: pick.table.headerRow < 0,
  };
}

/** Texto colado (uma linha por ponto). Aceita "endereço" ou "endereço ; demanda" ou colunas do Excel (tab). */
export function parsePasted(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { items: [], blankDemand: 0 };
  const rows = lines.map((l) => (l.includes("\t") ? l.split("\t") : l.split(/\s*;\s*/)));
  const table = locateTable(rows);
  if (table && table.headerRow >= 0) return rowsToItems(rows, table);
  // Sem cabeçalho: 1ª coluna = endereço; uma coluna numérica curta = demanda
  const items = [];
  let blankDemand = 0;
  rows.forEach((cols, i) => {
    const address = str(cols[0]);
    if (!address) return;
    const cep = looksLikeCEP(address) ? toCEP(address) : "";
    const extra = cols.slice(1).map(str);
    const dem = extra.map(toNumber).find((n) => n != null);
    const it = { line: i + 1, name: "", address: cep ? "" : address, cep, number: "", lat: null, lng: null,
      demand: dem != null ? Math.max(0, Math.round(dem)) : null, isDepot: extra.some(isDepotValue),
      twStart: undefined, twEnd: undefined, service: null };
    if (it.demand == null) blankDemand++;
    items.push(it);
  });
  return { items, blankDemand };
}
