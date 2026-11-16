"""Gera app/static/exemplos.js com os 3 casos de ~50 clientes do Rota Roda.

Os pontos são endereços reais do OpenStreetMap (lojas, bares e residências), coletados
em 16/11/2026 via Overpass/Photon e guardados em tools/dados_exemplos/*.txt.
Demandas, janelas de tempo e frota são ilustrativas e geradas de forma reprodutível
(semente fixa), para cada caso ter o perfil típico da operação.

    python tools/gerar_exemplos.py
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "dados_exemplos"
OUT = ROOT.parent / "app" / "static" / "exemplos.js"


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def rows(name):
    for line in (DATA / name).read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            yield line.split("|")


def addr(street, hn, district, city):
    s = street + (f", {hn}" if hn else "")
    return f"{s} - {district}, {city} - RJ" if district else f"{s}, {city} - RJ"


def hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


# --------------------------------------------------------------------------- #
# Caso 1 — Rede de farmácias (Drogarias Pacheco): reposição das lojas
# --------------------------------------------------------------------------- #
def farmacias():
    rnd = random.Random(2026)
    seen, pts = set(), []
    longe = {"Méier", "Cachambi", "Rocinha"}
    for lat, lng, street, hn, district, city, *_ in rows("pacheco.txt"):
        lat, lng = float(lat), float(lng)
        city = city or "Rio de Janeiro"
        if district in longe:
            continue
        if any(km((lat, lng), s) < 0.08 for s in seen):  # mesma loja mapeada duas vezes
            continue
        seen.add((lat, lng))
        pts.append(dict(lat=lat, lng=lng, street=street, hn=hn, district=district, city=city))
    pts = pts[:50]
    assert len(pts) == 50, len(pts)
    cnt = {}
    out = [dict(name="CD Rota Roda · São Cristóvão", address="Rua Bela - São Cristóvão, Rio de Janeiro - RJ",
                lat=-22.8936477, lng=-43.2206753, isDepot=True, demand=0)]
    for p in pts:
        cnt[p["district"]] = cnt.get(p["district"], 0) + 1
    seq = {}
    for p in pts:
        d = p["district"]
        seq[d] = seq.get(d, 0) + 1
        name = f"Pacheco {d}" + (f" {seq[d]}" if cnt[d] > 1 else "")
        grande = d in ("Centro", "Copacabana", "Botafogo", "Icaraí", "Tijuca")
        demand = rnd.randint(14, 30) if grande else rnd.randint(8, 22)
        if p["city"] == "Niterói":
            tw = (8 * 60, 13 * 60)       # do outro lado da ponte: manhã toda
        elif d in ("Centro", "Lapa"):
            tw = (6 * 60, 9 * 60 + 30)   # Centro: antes do comércio abrir e do trânsito
        else:
            tw = (7 * 60, 12 * 60)
        out.append(dict(name=name, address=addr(p["street"], p["hn"], d, p["city"]), lat=p["lat"], lng=p["lng"],
                        demand=demand, service=12, twStart=hhmm(tw[0]), twEnd=hhmm(tw[1])))
    return dict(
        id="farmacias", color="#059669", icon="💊",
        title="Rede de farmácias · reposição das lojas",
        tag="VRPTW · 50 lojas · Rio e Niterói",
        desc="50 lojas reais da Drogarias Pacheco no Centro, Zona Sul, Tijuca/Vila Isabel e em Niterói, abastecidas a partir de um CD hipotético em "
             "São Cristóvão. As lojas do Centro recebem até 09h30; o solver decide quem atravessa a ponte.",
        stats=["50 lojas", "vans baú de 150 caixas", "janelas de recebimento", "atendimento 12 min"],
        points=out,
        fleet=[dict(name="Van baú", capacity=150, qty=10, costKm=2.1, fixedCost=150)],
        opts=dict(useTW=True, dayStart="06:00", dayEnd="14:00", timeLimit=90, returnToDepot=True),
    )


# --------------------------------------------------------------------------- #
# Caso 2 — Supermercado: entregas de compras online com hora marcada
# --------------------------------------------------------------------------- #
def supermercado():
    rnd = random.Random(1116)
    pts, seen = [], []
    for lat, lng, street, hn, district, *_ in rows("residencias.txt"):
        lat, lng = float(lat), float(lng)
        if any(km((lat, lng), s) < 0.05 for s in seen):
            continue
        seen.append((lat, lng))
        pts.append(dict(lat=lat, lng=lng, street=street, hn=hn, district=district or "Icaraí"))
    rnd.shuffle(pts)
    pts = pts[:50]
    assert len(pts) == 50, len(pts)
    slots = [(8, 10), (10, 12), (12, 14), (14, 16), (16, 18), (18, 20)]
    peso = [3, 3, 2, 3, 3, 2]
    out = [dict(name="Supermercados Mundial · Santa Rosa", address="Rua Doutor Mário Viana, 296 - Santa Rosa, Niterói - RJ",
                lat=-22.903447, lng=-43.0980613, isDepot=True, demand=0)]
    for k, p in enumerate(pts, 1):
        a, b = rnd.choices(slots, peso)[0]
        out.append(dict(name=f"Pedido #{1040 + k} · {p['street'].replace('Rua ', 'R. ').replace('Avenida ', 'Av. ')}, {p['hn']}",
                        address=addr(p["street"], p["hn"], p["district"], "Niterói"), lat=p["lat"], lng=p["lng"],
                        demand=rnd.choice([1, 2, 2, 3, 3, 3, 4, 4, 5, 6]), service=5, twStart=hhmm(a * 60), twEnd=hhmm(b * 60)))
    return dict(
        id="supermercado", color="#dc2626", icon="🛒",
        title="Supermercado · entregas com hora marcada",
        tag="VRPTW · 50 pedidos · Niterói",
        desc="50 pedidos de compras online em endereços reais de Icaraí, Santa Rosa, Ingá e arredores, saindo de uma loja "
             "em Santa Rosa. Cada cliente escolheu uma janela de 2 horas, entre 8h e 20h.",
        stats=["50 pedidos", "utilitários de 22 caixas", "janelas de 2 h", "atendimento 5 min"],
        points=out,
        fleet=[dict(name="Utilitário", capacity=22, qty=10, costKm=0.9, fixedCost=80)],
        opts=dict(useTW=True, dayStart="07:30", dayEnd="20:30", timeLimit=90, returnToDepot=True),
    )


# --------------------------------------------------------------------------- #
# Caso 3 — Distribuidora de bebidas: bares e restaurantes da Zona Sul
# --------------------------------------------------------------------------- #
def bebidas():
    rnd = random.Random(77)
    pts, names = [], set()
    for lat, lng, kind, name, street, hn, district in rows("bares.txt"):
        if name in ("Bar",) or name in names:
            continue
        names.add(name)
        pts.append(dict(lat=float(lat), lng=float(lng), kind=kind, name=name, street=street, hn=hn, district=district))
    c = (sum(p["lat"] for p in pts) / len(pts), sum(p["lng"] for p in pts) / len(pts))
    pts.sort(key=lambda p: km((p["lat"], p["lng"]), c))
    pts = pts[:50]
    assert len(pts) == 50, len(pts)
    out = [dict(name="Distribuidora · São Cristóvão", address="Rua General Bruce - São Cristóvão, Rio de Janeiro - RJ",
                lat=-22.894897, lng=-43.2217056, isDepot=True, demand=0)]
    for p in pts:
        bar = p["kind"] in ("bar", "pub")
        if bar:
            tw = rnd.choice([(14 * 60, 17 * 60), (14 * 60, 17 * 60), (9 * 60, 12 * 60)])  # antes de abrir
            demand = rnd.randint(20, 45)
        else:
            tw = rnd.choice([(8 * 60, 11 * 60 + 30), (8 * 60, 11 * 60 + 30), (15 * 60, 17 * 60 + 30)])  # antes do almoço
            demand = rnd.randint(12, 30)
        name = p["name"] if len(p["name"]) <= 34 else p["name"][:33] + "…"
        out.append(dict(name=name, address=addr(p["street"], p["hn"].split(" ")[0] if p["hn"] else "", p["district"], "Rio de Janeiro"),
                        lat=p["lat"], lng=p["lng"], demand=demand, service=10, twStart=hhmm(tw[0]), twEnd=hhmm(tw[1])))
    return dict(
        id="bebidas", color="#d97706", icon="🍺",
        title="Distribuidora de bebidas · bares da Zona Sul",
        tag="VRPTW · 50 bares e restaurantes · Rio",
        desc="50 bares e restaurantes reais de Botafogo, Humaitá, Copacabana e Leme. Restaurantes recebem antes do almoço e "
             "bares antes de abrir: as janelas da manhã e da tarde criam esperas, e aqui a heurística fica bem longe do ótimo.",
        stats=["50 clientes", "VUC de 150 caixas", "janelas manhã/tarde", "atendimento 10 min"],
        points=out,
        fleet=[dict(name="VUC", capacity=150, qty=12, costKm=1.9, fixedCost=140)],
        opts=dict(useTW=True, dayStart="07:00", dayEnd="19:00", timeLimit=90, returnToDepot=True),
    )


def main():
    casos = [farmacias(), supermercado(), bebidas()]
    head = ("// Gerado por tools/gerar_exemplos.py — não edite à mão.\n"
            "// Endereços reais do OpenStreetMap (© colaboradores do OpenStreetMap, ODbL);\n"
            "// demandas, janelas de tempo e frota são ilustrativas.\n")
    OUT.write_text(head + "export const CASOS = " + json.dumps(casos, ensure_ascii=False, indent=1) + ";\n", encoding="utf-8")
    for c in casos:
        cl = [p for p in c["points"] if not p.get("isDepot")]
        print(c["id"], len(cl), "clientes · demanda", sum(p["demand"] for p in cl))


if __name__ == "__main__":
    main()
