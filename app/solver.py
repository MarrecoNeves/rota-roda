"""Modelagem e solucao do problema de roteamento.

- Metodo exato: VRPSolverEasy (branch-cut-and-price, BaPCod + CLP).
- Heuristica de referencia: Clarke & Wright (savings, versao paralela), usada para
  (a) comparar com o otimo (gap %) e (b) fornecer limite superior ao solver exato.

Variantes suportadas:
  CVRP classico, frota heterogenea (capacidade, custo/km, custo fixo, quantidade),
  multiplos depositos, janelas de tempo com tempo de servico (VRPTW),
  rotas abertas (veiculo nao retorna ao deposito) e matriz assimetrica (ruas reais).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from VRPSolverEasy.src import solver as vrpse

BIG_HORIZON = 100_000.0  # minutos; "sem janela de tempo"


@dataclass
class Point:
    name: str
    lat: float
    lng: float
    demand: float = 0.0
    is_depot: bool = False
    service_min: float = 0.0
    tw_start: float | None = None  # minutos a partir do inicio do expediente
    tw_end: float | None = None


@dataclass
class VehicleType:
    name: str
    capacity: float
    qty: int
    cost_km: float = 1.0
    fixed_cost: float = 0.0
    depot: int = 0  # indice do ponto-deposito de origem


@dataclass
class Options:
    return_to_depot: bool = True
    use_time_windows: bool = False
    time_limit: float = 30.0
    horizon_min: float = 600.0  # duracao da jornada quando ha janelas de tempo


@dataclass
class Route:
    vehicle_type: int
    depot: int
    stops: list[int]                 # indices dos clientes, em ordem
    load: float = 0.0
    dist_km: float = 0.0
    time_min: float = 0.0
    cost: float = 0.0
    arrivals: list[float] = field(default_factory=list)  # chegada em cada cliente (min)


class ProblemError(ValueError):
    """Dados de entrada inconsistentes (mensagem pronta para o usuario)."""


# --------------------------------------------------------------------------- #
# Validacao
# --------------------------------------------------------------------------- #
def validate(points: list[Point], vtypes: list[VehicleType], opt: Options):
    depots = [i for i, p in enumerate(points) if p.is_depot]
    customers = [i for i, p in enumerate(points) if not p.is_depot]
    if not depots:
        raise ProblemError("Marque pelo menos um ponto como depósito.")
    if not customers:
        raise ProblemError("Inclua pelo menos um cliente.")
    if not vtypes:
        raise ProblemError("Cadastre pelo menos um tipo de veículo.")
    for c in customers:
        if float(points[c].demand) != int(points[c].demand):
            raise ProblemError(f"A demanda de '{points[c].name}' deve ser um número inteiro.")
        if points[c].demand <= 0:
            raise ProblemError(f"O cliente '{points[c].name}' precisa de demanda maior que zero.")
    for k, v in enumerate(vtypes):
        if v.depot not in depots:
            raise ProblemError(f"O veículo '{v.name}' está ligado a um ponto que não é depósito.")
        if float(v.capacity) != int(v.capacity):
            raise ProblemError(f"A capacidade do veículo '{v.name}' deve ser um número inteiro.")
        if v.capacity <= 0 or v.qty <= 0:
            raise ProblemError(f"O veículo '{v.name}' precisa de capacidade e quantidade positivas.")
    maxcap = max(v.capacity for v in vtypes)
    for c in customers:
        if points[c].demand > maxcap:
            raise ProblemError(
                f"A demanda de '{points[c].name}' ({points[c].demand:g}) é maior que a "
                f"capacidade do maior veículo ({maxcap:g}).")
    total_dem = sum(points[c].demand for c in customers)
    total_cap = sum(v.capacity * v.qty for v in vtypes)
    if total_cap < total_dem:
        raise ProblemError(
            f"Capacidade total da frota ({total_cap:g}) menor que a demanda ({total_dem:g}).")
    if opt.use_time_windows:
        for c in customers:
            p = points[c]
            a, b = _tw(p, opt)
            if b < a:
                raise ProblemError(f"Janela de tempo inválida em '{p.name}'.")
    return depots, customers


def _tw(p: Point, opt: Options) -> tuple[float, float]:
    if not opt.use_time_windows:
        return 0.0, BIG_HORIZON
    a = p.tw_start if p.tw_start is not None else 0.0
    b = p.tw_end if p.tw_end is not None else opt.horizon_min
    return float(a), float(b)


# --------------------------------------------------------------------------- #
# Avaliacao de rotas (usada pelas duas abordagens)
# --------------------------------------------------------------------------- #
def evaluate_route(seq: list[int], depot: int, points, dist, tmat, opt: Options):
    """Simula a rota depot -> seq -> (depot). Retorna (dist_km, fim_min, chegadas, viavel)."""
    t, d, prev, arrivals = 0.0, 0.0, depot, []
    dep_a, dep_b = _tw(points[depot], opt)
    t = dep_a
    feasible = True
    for c in seq:
        t += tmat[prev][c]
        d += dist[prev][c]
        a, b = _tw(points[c], opt)
        if t < a:
            t = a  # espera abrir a janela
        if t > b + 1e-6:
            feasible = False
        arrivals.append(t)
        t += points[c].service_min
        prev = c
    if opt.return_to_depot:
        t += tmat[prev][depot]
        d += dist[prev][depot]
        if t > dep_b + 1e-6:
            feasible = False
    return d, t, arrivals, feasible


def _finish_route(r: Route, points, dist, tmat, vtypes, opt):
    d, t_end, arr, _ = evaluate_route(r.stops, r.depot, points, dist, tmat, opt)
    v = vtypes[r.vehicle_type]
    r.load = sum(points[c].demand for c in r.stops)
    r.dist_km = round(d, 3)
    start = _tw(points[r.depot], opt)[0]
    r.time_min = round(t_end - start, 2)
    r.arrivals = [round(a, 2) for a in arr]
    r.cost = round(v.cost_km * d + v.fixed_cost, 4)
    return r


# --------------------------------------------------------------------------- #
# Heuristica de Clarke & Wright (savings, paralela)
# --------------------------------------------------------------------------- #
def clarke_wright(points, vtypes, dist, tmat, opt: Options):
    depots, customers = validate(points, vtypes, opt)
    t0 = time.perf_counter()
    active_depots = sorted({v.depot for v in vtypes})
    # Cada cliente vai para o deposito (com frota) mais proximo.
    groups: dict[int, list[int]] = {d: [] for d in active_depots}
    for c in customers:
        best = min(active_depots, key=lambda d: dist[d][c] + dist[c][d])
        groups[best].append(c)

    routes: list[Route] = []
    feasible = True
    for dep, custs in groups.items():
        if not custs:
            continue
        cap = max(v.capacity for v in vtypes if v.depot == dep)
        back = (lambda i: dist[i][dep]) if opt.return_to_depot else (lambda i: 0.0)
        rts = {c: [c] for c in custs}          # id da rota -> sequencia
        where = {c: c for c in custs}          # cliente -> id da rota
        load = {c: points[c].demand for c in custs}
        savings = []
        for i in custs:
            for j in custs:
                if i != j:
                    s = back(i) + dist[dep][j] - dist[i][j]
                    savings.append((s, i, j))
        savings.sort(key=lambda x: -x[0])
        for s, i, j in savings:
            if s <= 0:
                break
            ri, rj = where[i], where[j]
            if ri == rj:
                continue
            A, B = rts[ri], rts[rj]
            if A[-1] != i or B[0] != j:  # i precisa fechar A e j abrir B (sentido importa)
                continue
            if load[ri] + load[rj] > cap:
                continue
            merged = A + B
            if opt.use_time_windows:
                *_, ok = evaluate_route(merged, dep, points, dist, tmat, opt)
                if not ok:
                    continue
            rts[ri] = merged
            load[ri] += load[rj]
            for c in B:
                where[c] = ri
            del rts[rj], load[rj]

        # Atribui rotas a veiculos: maiores cargas primeiro, veiculo viavel mais barato.
        avail = {k: v.qty for k, v in enumerate(vtypes) if v.depot == dep}
        for rid in sorted(rts, key=lambda r: -load[r]):
            seq = rts[rid]
            d, *_ = evaluate_route(seq, dep, points, dist, tmat, opt)
            options = [k for k, q in avail.items() if q > 0 and vtypes[k].capacity >= load[rid]]
            if not options:
                feasible = False
                options = [max((k for k in avail), key=lambda k: vtypes[k].capacity)]
            k = min(options, key=lambda k: vtypes[k].cost_km * d + vtypes[k].fixed_cost)
            avail[k] -= 1
            routes.append(_finish_route(Route(k, dep, seq), points, dist, tmat, vtypes, opt))
        if opt.use_time_windows:
            for r in routes:
                if r.depot == dep and not evaluate_route(r.stops, dep, points, dist, tmat, opt)[3]:
                    feasible = False

    total = sum(r.cost for r in routes)
    return {
        "routes": routes,
        "cost": round(total, 4),
        "feasible": feasible,
        "time_s": round(time.perf_counter() - t0, 4),
    }


# --------------------------------------------------------------------------- #
# Metodo exato com VRPSolverEasy
# --------------------------------------------------------------------------- #
STATUS_TXT = {
    0: ("otimo", "Solução ótima encontrada e provada."),
    1: ("viavel", "Melhor solução encontrada no limite de tempo (otimalidade não provada)."),
    2: ("otimo", "Não existe solução melhor que a da heurística (ela já era ótima)."),
    3: ("sem_solucao", "Nenhuma solução encontrada dentro do limite de tempo."),
    -1: ("erro", "O solver foi interrompido por erro."),
    -2: ("inviavel", "Problema inviável com a frota informada."),
}


def solve_exact(points, vtypes, dist, tmat, opt: Options, upper_bound: float | None = None):
    depots, customers = validate(points, vtypes, opt)
    t0 = time.perf_counter()
    m = vrpse.Model()
    vid = lambda i: i + 1  # ids do VRPSolverEasy (clientes precisam de id >= 1)

    for d in depots:
        a, b = (0.0, opt.horizon_min) if opt.use_time_windows else (0.0, BIG_HORIZON)
        m.add_depot(id=vid(d), name=points[d].name[:60] or f"Deposito {d}", tw_begin=a, tw_end=b)
    for c in customers:
        a, b = _tw(points[c], opt)
        m.add_customer(id=vid(c), name=points[c].name[:60] or f"Cliente {c}",
                       demand=int(points[c].demand),
                       service_time=float(points[c].service_min), tw_begin=a, tw_end=b)
    for k, v in enumerate(vtypes):
        a, b = (0.0, opt.horizon_min) if opt.use_time_windows else (0.0, BIG_HORIZON)
        m.add_vehicle_type(id=k + 1, name=v.name[:40] or f"Veiculo {k+1}",
                           start_point_id=vid(v.depot), end_point_id=vid(v.depot),
                           capacity=int(v.capacity), max_number=int(v.qty),
                           var_cost_dist=float(v.cost_km), fixed_cost=float(v.fixed_cost),
                           tw_begin=a, tw_end=b)

    nodes = depots + customers
    for i in nodes:
        for j in nodes:
            if i == j or (i in depots and j in depots):
                continue
            dij, tij = dist[i][j], tmat[i][j]
            if not opt.return_to_depot and j in depots:
                dij, tij = 0.0, 0.0  # rota aberta: "voltar" ao deposito nao custa nada
            m.add_link(start_point_id=vid(i), end_point_id=vid(j), is_directed=True,
                       distance=round(dij, 3), time=round(tij, 3))

    params = dict(time_limit=float(opt.time_limit), solver_name="CLP", print_level=-2)
    if upper_bound is not None:
        params["upper_bound"] = upper_bound
    m.set_parameters(**params)
    m.solve()

    code = m.status
    kind, msg = STATUS_TXT.get(code, ("erro", m.message))
    routes = []
    if m.solution.is_defined():
        for r in m.solution.routes:
            k = r.vehicle_type_id - 1
            seq = [pid - 1 for pid in r.point_ids]
            stops = [i for i in seq if not points[i].is_depot]
            routes.append(_finish_route(Route(k, vtypes[k].depot, stops),
                                        points, dist, tmat, vtypes, opt))
    stats = {}
    st = getattr(m, "statistics", None)
    if st is not None:
        stats = {"solver_time_s": st.solution_time, "root_lb": st.root_lb,
                 "best_lb": st.best_lb, "bb_nodes": st.nb_branch_and_bound_nodes}
    return {
        "routes": routes,
        "cost": round(sum(r.cost for r in routes), 4) if routes else None,
        "status_code": code,
        "status": kind,
        "message": msg,
        "stats": stats,
        "time_s": round(time.perf_counter() - t0, 3),
    }


def solve(points, vtypes, dist, tmat, opt: Options):
    """Roda Clarke-Wright, usa como limite superior e resolve de forma exata."""
    heur = clarke_wright(points, vtypes, dist, tmat, opt)
    ub = heur["cost"] * (1 + 1e-6) + 1e-3 if heur["feasible"] else None
    exact = solve_exact(points, vtypes, dist, tmat, opt, upper_bound=ub)
    if exact["status_code"] == 2 and not exact["routes"]:
        # O solver provou que nada supera a heuristica: a solucao de C&W e otima.
        exact.update(routes=heur["routes"], cost=heur["cost"], status="otimo",
                     message="Solução ótima (o solver provou que a heurística já era ótima).")
    elif exact["status_code"] in (1, 3) and heur["feasible"] and (
            exact["cost"] is None or heur["cost"] < exact["cost"]):
        exact.update(routes=heur["routes"], cost=heur["cost"])
    return exact, heur
