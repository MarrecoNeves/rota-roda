"""Testes do nucleo de otimizacao (rode com: python -m pytest -q)."""
import itertools
import random

import pytest

from app.geo import _matrix_haversine
from app.solver import (Options, Point, ProblemError, VehicleType, clarke_wright,
                        evaluate_route, solve)

# Pontos reais de Niteroi (aprox.), deposito em Sao Domingos
NITEROI = [
    ("Deposito", -22.9007, -43.1294, 0, True),
    ("Pres. Backer", -22.9043, -43.1106, 100, False),
    ("Conceicao", -22.8957, -43.1215, 80, False),
    ("R. Silveira", -22.9076, -43.1060, 70, False),
    ("Nobrega", -22.9066, -43.1142, 80, False),
    ("Mal. Deodoro", -22.8912, -43.1197, 100, False),
    ("Leite Ribeiro", -22.8837, -43.1080, 50, False),
    ("Ten. Osorio", -22.8790, -43.1010, 60, False),
]


def pts(data=NITEROI, **kw):
    return [Point(n, la, lo, d, dep, **kw) for n, la, lo, d, dep in data]


def matrices(points):
    m = _matrix_haversine([(p.lat, p.lng) for p in points])
    return m.dist_km, m.time_min


def check_solution(routes, points, vtypes, dist, tmat, opt):
    served = sorted(c for r in routes for c in r.stops)
    customers = [i for i, p in enumerate(points) if not p.is_depot]
    assert served == customers, "cada cliente deve ser atendido exatamente uma vez"
    used = {}
    for r in routes:
        v = vtypes[r.vehicle_type]
        assert r.load <= v.capacity + 1e-9
        assert r.depot == v.depot
        used[r.vehicle_type] = used.get(r.vehicle_type, 0) + 1
        assert evaluate_route(r.stops, r.depot, points, dist, tmat, opt)[3]
    for k, n in used.items():
        assert n <= vtypes[k].qty


def brute_force_cvrp(points, cap, dist):
    """Otimo exato por enumeracao (permutacao + split otimo). So para n pequeno."""
    cust = [i for i, p in enumerate(points) if not p.is_depot]
    best = float("inf")
    for perm in itertools.permutations(cust):
        n = len(perm)
        f = [0.0] + [float("inf")] * n
        for i in range(n):
            load, cost = 0, 0.0
            for j in range(i, n):
                load += points[perm[j]].demand
                if load > cap:
                    break
                cost = (dist[0][perm[i]] if j == i else cost - dist[perm[j - 1]][0]
                        + dist[perm[j - 1]][perm[j]])
                cost += dist[perm[j]][0]
                f[j + 1] = min(f[j + 1], f[i] + cost)
        best = min(best, f[n])
    return best


def test_exemplo_niteroi_otimo():
    points = pts()
    vt = [VehicleType("Van", 300, 2, 1.0, 0.0, 0)]
    dist, tmat = matrices(points)
    opt = Options()
    exact, heur = solve(points, vt, dist, tmat, opt)
    assert exact["status"] == "otimo"
    check_solution(exact["routes"], points, vt, dist, tmat, opt)
    assert exact["cost"] <= heur["cost"] + 1e-6


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_otimo_confere_com_forca_bruta(seed):
    rnd = random.Random(seed)
    data = [("D", -22.90, -43.12, 0, True)] + [
        (f"C{i}", -22.90 + rnd.uniform(-0.03, 0.03), -43.12 + rnd.uniform(-0.03, 0.03),
         rnd.randint(10, 40), False) for i in range(6)]
    points = pts(data)
    dist, tmat = matrices(points)
    vt = [VehicleType("V", 60, 6, 1.0, 0.0, 0)]
    exact, _ = solve(points, vt, dist, tmat, Options())
    assert exact["cost"] == pytest.approx(brute_force_cvrp(points, 60, dist), abs=1e-2)


def test_frota_heterogenea_e_custo_fixo():
    points = pts()
    vt = [VehicleType("Moto", 120, 3, 0.5, 5.0, 0),
          VehicleType("Caminhao", 600, 1, 2.0, 50.0, 0)]
    dist, tmat = matrices(points)
    opt = Options()
    exact, heur = solve(points, vt, dist, tmat, opt)
    check_solution(exact["routes"], points, vt, dist, tmat, opt)
    assert exact["cost"] <= heur["cost"] + 1e-6


def test_multiplos_depositos():
    data = NITEROI + [("Deposito 2", -22.8800, -43.1050, 0, True)]
    points = pts(data)
    vt = [VehicleType("Van A", 300, 2, 1.0, 0, 0), VehicleType("Van B", 300, 2, 1.0, 0, 8)]
    dist, tmat = matrices(points)
    opt = Options()
    exact, _ = solve(points, vt, dist, tmat, opt)
    check_solution(exact["routes"], points, vt, dist, tmat, opt)
    assert {r.depot for r in exact["routes"]} == {0, 8}


def test_janelas_de_tempo():
    points = pts(service_min=10)
    for i, p in enumerate(points):
        if not p.is_depot:
            p.tw_start, p.tw_end = (0, 40) if i % 2 else (60, 240)
    vt = [VehicleType("Van", 300, 4, 1.0, 0, 0)]
    dist, tmat = matrices(points)
    opt = Options(use_time_windows=True, horizon_min=480)
    exact, _ = solve(points, vt, dist, tmat, opt)
    assert exact["status"] == "otimo"
    check_solution(exact["routes"], points, vt, dist, tmat, opt)
    for r in exact["routes"]:
        for c, t in zip(r.stops, r.arrivals):
            assert points[c].tw_start - 1e-6 <= t <= points[c].tw_end + 1e-6


def test_rota_aberta_mais_barata_que_fechada():
    points = pts()
    vt = [VehicleType("Van", 300, 2, 1.0, 0, 0)]
    dist, tmat = matrices(points)
    fechada, _ = solve(points, vt, dist, tmat, Options(return_to_depot=True))
    aberta, _ = solve(points, vt, dist, tmat, Options(return_to_depot=False))
    check_solution(aberta["routes"], points, vt, dist, tmat, Options(return_to_depot=False))
    assert aberta["cost"] < fechada["cost"]


def test_matriz_assimetrica():
    points = pts()
    dist, tmat = matrices(points)
    for i in range(len(points)):
        for j in range(i + 1, len(points)):
            dist[i][j] = round(dist[i][j] * 1.4, 3)  # "contramao"
    vt = [VehicleType("Van", 300, 2, 1.0, 0, 0)]
    opt = Options()
    exact, heur = solve(points, vt, dist, tmat, opt)
    check_solution(exact["routes"], points, vt, dist, tmat, opt)
    assert exact["cost"] <= heur["cost"] + 1e-6


def test_erros_de_entrada():
    points = pts()
    dist, tmat = matrices(points)
    with pytest.raises(ProblemError, match="Capacidade total"):
        solve(points, [VehicleType("Van", 100, 2, 1, 0, 0)], dist, tmat, Options())
    with pytest.raises(ProblemError, match="maior que a"):
        solve(points, [VehicleType("Moto", 60, 20, 1, 0, 0)], dist, tmat, Options())
    no_depot = [Point(p.name, p.lat, p.lng, max(p.demand, 1), False) for p in points]
    with pytest.raises(ProblemError, match="depósito"):
        solve(no_depot, [VehicleType("Van", 300, 3, 1, 0, 0)], dist, tmat, Options())


def test_clarke_wright_viavel():
    points = pts()
    vt = [VehicleType("Van", 300, 2, 1.0, 0, 0)]
    dist, tmat = matrices(points)
    opt = Options()
    h = clarke_wright(points, vt, dist, tmat, opt)
    assert h["feasible"]
    check_solution(h["routes"], points, vt, dist, tmat, opt)
