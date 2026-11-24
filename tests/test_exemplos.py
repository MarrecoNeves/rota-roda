"""Confere os cenários do botão Exemplos (app/static/exemplos.js).

Não chama o solver nem a internet: só garante que cada caso é consistente
(50 clientes, um depósito, demanda que cabe no veículo, janelas dentro da jornada).
"""
import json
from pathlib import Path

import pytest

JS = Path(__file__).resolve().parents[1] / "app" / "static" / "exemplos.js"


def _casos():
    s = JS.read_text(encoding="utf-8")
    return json.loads(s[s.index("["):s.rindex(";")])


def _min(h):
    a, b = h.split(":")
    return int(a) * 60 + int(b)


def test_ids_dos_casos():
    assert [c["id"] for c in _casos()] == ["farmacias", "supermercado", "bebidas", "mcdonalds"]


@pytest.mark.parametrize("caso", _casos(), ids=lambda c: c["id"])
def test_caso_consistente(caso):
    pts = caso["points"]
    deps = [p for p in pts if p.get("isDepot")]
    cli = [p for p in pts if not p.get("isDepot")]
    assert len(deps) == 1 and len(cli) == 50
    cap = max(v["capacity"] for v in caso["fleet"])
    assert all(0 < p["demand"] <= cap for p in cli)
    assert sum(p["demand"] for p in cli) <= sum(v["capacity"] * v["qty"] for v in caso["fleet"])
    ini, fim = _min(caso["opts"]["dayStart"]), _min(caso["opts"]["dayEnd"])
    for p in cli:
        a, b = _min(p["twStart"]), _min(p["twEnd"])
        assert ini <= a < b <= fim, p["name"]
    # todos os pontos no estado do RJ (caixa larga)
    assert all(-23.4 < p["lat"] < -20.7 and -44.9 < p["lng"] < -40.9 for p in pts)


def test_mcdonalds_premissas_da_planilha():
    c = next(x for x in _casos() if x["id"] == "mcdonalds")
    cli = [p for p in c["points"] if not p.get("isDepot")]
    assert sum(p["demand"] for p in cli) == 13230
    assert {(p["twStart"], p["twEnd"]) for p in cli} == {
        ("05:00", "08:00"), ("06:00", "10:00"), ("14:00", "18:00"), ("09:00", "15:00"), ("08:00", "18:00")}
