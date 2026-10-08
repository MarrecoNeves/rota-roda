// Testes do leitor de planilhas:  node tests/js/planilha.test.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { readWorkbook, parsePasted, toClock, toCEP, toNumber, fieldOf } from "../../app/static/planilha.js";

const require = createRequire(import.meta.url);
const XLSX = require("../../app/static/vendor/xlsx.full.min.js");
const FX = process.argv[2] || new URL("./fixtures/", import.meta.url).pathname;
const read = (f) => readWorkbook(XLSX, XLSX.read(readFileSync(join(FX, f))));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok -", name); };

t("cabeçalhos livres", () => {
  assert.equal(fieldOf("Endereço (rua, nº, bairro, cidade)"), "address");
  assert.equal(fieldOf("Depósito?"), "depot");
  assert.equal(fieldOf("Nº"), "number");
  assert.equal(fieldOf("Rua da Conceição, 100"), null); // dado, não cabeçalho
  assert.equal(fieldOf("Cole os endereços na coluna Endereço, um por linha. A linha 5 é o depósito"), null);
});
t("conversores", () => {
  assert.equal(toClock(0.375), "09:00");
  assert.equal(toClock("9h30"), "09:30");
  assert.equal(toClock("14:05:00"), "14:05");
  assert.equal(toCEP(1310100), "01310100");
  assert.equal(toCEP("24020-085"), "24020085");
  assert.equal(toNumber("12,5"), 12.5);
  assert.equal(toNumber("1.200,50"), 1200.5);
});
t("modelo vazio importa a aba Exemplo", () => {
  const r = read("modelo_vazio.xlsx");
  assert.equal(r.sheet, "Exemplo"); assert.equal(r.usedExample, true); assert.equal(r.items.length, 8);
  assert.equal(r.items[0].isDepot, true); assert.equal(r.items[1].demand, 100);
});
t("modelo preenchido usa a aba Pontos", () => {
  const r = read("modelo_preenchido.xlsx");
  assert.equal(r.sheet, "Pontos"); assert.equal(r.items.length, 4); // linha 8 só com CEP
  assert.equal(r.items[0].isDepot, true); assert.equal(r.items[0].name, "Depósito (ponto de saída)");
  assert.equal(r.items[1].demand, 80); assert.equal(r.items[1].twStart, "09:00"); assert.equal(r.items[1].twEnd, "12:30");
  assert.equal(r.items[2].demand, null); assert.equal(r.items[3].cep, "01310100"); assert.equal(r.items[3].address, ""); assert.equal(r.blankDemand, 2);
});
t("planilha pronta com título e nomes livres", () => {
  const r = read("pronta_titulo.xlsx");
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].isDepot, true); assert.equal(r.items[1].isDepot, false);
  assert.equal(r.items[1].demand, 13); assert.equal(r.items[1].twStart, "09:00"); assert.equal(r.items[1].twEnd, "11:30");
  assert.equal(r.items[1].service, 10); assert.equal(r.items[2].twStart, "12:00"); assert.equal(r.items[2].line, 7);
});
t("endereço em colunas separadas", () => {
  const r = read("separado.xlsx");
  assert.equal(r.items[0].address, "Rua Passo da Pátria, 156, São Domingos, Niterói - RJ");
  assert.equal(r.items[1].demand, 30);
});
t("sem cabeçalho", () => {
  const r = read("sem_cabecalho.xlsx");
  assert.equal(r.headerless, true); assert.equal(r.items.length, 3); assert.equal(r.items[0].address, "Rua Passo da Pátria, 156, Niterói");
});
t("formato antigo continua valendo e ignora Instruções", () => {
  const r = read("antigo.xlsx");
  assert.equal(r.sheet, "Pontos"); assert.equal(r.items.length, 2); assert.equal(r.items[0].isDepot, true); assert.equal(r.items[1].service, 5);
});
t("lat/lng com vírgula e CEP numérico", () => {
  const r = read("latlng.xlsx");
  assert.equal(r.items[0].lat, -22.9056); assert.equal(r.items[0].lng, -43.1331); assert.equal(r.items[2].cep, "01310100"); assert.equal(r.items[2].lat, null);
});
t("CSV com ponto e vírgula", () => {
  const wb = XLSX.read(readFileSync(join(FX, "fx.csv"), "utf8"), { type: "string", FS: ";", raw: true });
  const r = readWorkbook(XLSX, wb);
  assert.equal(r.items.length, 2); assert.equal(r.items[0].isDepot, true); assert.equal(r.items[1].demand, 30);
});
t("planilha sem endereço dá erro claro", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Produto", "Preço"], ["Café", 10]]), "A");
  assert.throws(() => readWorkbook(XLSX, wb), /Não encontrei uma coluna de endereço/);
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet([["Nome", "Endereço"], ["Depósito", ""]]), "Pontos");
  assert.throws(() => readWorkbook(XLSX, wb2), /tem o cabeçalho, mas nenhuma linha/);
});
t("colar lista", () => {
  const r = parsePasted("Rua A, 1, Niterói\nRua B, 2, Niterói; 80\n\n24020-085; 15\n");
  assert.equal(r.items.length, 3); assert.equal(r.items[1].demand, 80); assert.equal(r.items[2].cep, "24020085"); assert.equal(r.items[2].address, "");
  const x = parsePasted("Endereço\tDemanda\nRua A, 1, Niterói\t30");
  assert.equal(x.items.length, 1); assert.equal(x.items[0].demand, 30);
});
console.log(`\n${n} testes passaram`);
