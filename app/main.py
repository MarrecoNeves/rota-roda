"""API do Rota Roda (roteirizador VRP) (FastAPI) + servidor do front-end estatico."""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse, Response  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from . import extras, geo  # noqa: E402
from .solver import (Options, Point, ProblemError, Route, VehicleType,  # noqa: E402
                     _finish_route, evaluate_route, solve)

STATIC = Path(__file__).resolve().parent / "static"
MAX_POINTS = int(os.getenv("MAX_POINTS", "80"))
MAX_TIME_LIMIT = float(os.getenv("MAX_TIME_LIMIT", "120"))

app = FastAPI(title="Rota Roda - Roteirizador VRP (UFF)", version="1.0")
_solver_lock = threading.Lock()  # a biblioteca nativa do BaPCod nao e reentrante


# --------------------------------------------------------------------------- #
# Protecao simples contra abuso (a chave do Google e paga por uso)
# --------------------------------------------------------------------------- #
_hits: dict[tuple[str, str], deque] = defaultdict(deque)


def _rate_limit(request: Request, bucket: str, limit: int, window_s: int = 600, cost: int = 1):
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?")
    ip = ip.split(",")[0].strip()
    q = _hits[(ip, bucket)]
    now = time.time()
    while q and now - q[0] > window_s:
        q.popleft()
    if len(q) + cost > limit:
        raise HTTPException(429, "Muitas requisições. Aguarde alguns minutos e tente de novo.")
    q.extend([now] * cost)


# --------------------------------------------------------------------------- #
# Modelos de entrada
# --------------------------------------------------------------------------- #
class PointIn(BaseModel):
    name: str = ""
    address: str = ""
    lat: float
    lng: float
    demand: float = 0
    is_depot: bool = False
    service_min: float = Field(0, ge=0)
    tw_start: float | None = None
    tw_end: float | None = None


class VehicleIn(BaseModel):
    name: str = "Veiculo"
    capacity: float = Field(gt=0)
    qty: int = Field(ge=1, le=100)
    cost_km: float = Field(1.0, ge=0)
    fixed_cost: float = Field(0.0, ge=0)
    depot: int = 0


class OptionsIn(BaseModel):
    return_to_depot: bool = True
    use_time_windows: bool = False
    time_limit: float = Field(30, gt=0)
    horizon_min: float = Field(600, gt=0)
    vehicle_profile: str = "car"        # "car" | "truck" (caminhao exige OpenRouteService)
    compare_commercial: bool = True     # comparar com GraphHopper (se houver chave)
    traffic: bool = True                # tempo com transito agora (se houver chave TomTom)


class SolveIn(BaseModel):
    points: list[PointIn]
    vehicles: list[VehicleIn]
    options: OptionsIn = OptionsIn()


class GeocodeIn(BaseModel):
    addresses: list[str]
    region_hint: str = ""


# --------------------------------------------------------------------------- #
# Rotas da API
# --------------------------------------------------------------------------- #
@app.get("/api/config")
def config():
    return {
        "browser_key": os.getenv("GOOGLE_MAPS_BROWSER_KEY", "").strip(),
        "map_id": os.getenv("GOOGLE_MAPS_MAP_ID", "").strip() or "DEMO_MAP_ID",
        # "google" quando ha chave do navegador; senao mapa gratuito do OpenStreetMap
        "map_provider": "google" if os.getenv("GOOGLE_MAPS_BROWSER_KEY", "").strip() else "osm",
        "server_key": bool(geo.GOOGLE_KEY),
        "max_points": MAX_POINTS,
        "features": extras.features(),
    }


@app.get("/api/suggest")
def suggest(q: str, request: Request, lat: float | None = None, lng: float | None = None):
    _rate_limit(request, "suggest", limit=600)
    return {"items": geo.suggest(q[:120], lat, lng)}


@app.get("/api/reverse")
def reverse(lat: float, lng: float, request: Request):
    _rate_limit(request, "reverse", limit=200)
    return {"address": geo.reverse(lat, lng)}


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/geocode")
def geocode(body: GeocodeIn, request: Request):
    if len(body.addresses) > MAX_POINTS:
        raise HTTPException(400, f"Máximo de {MAX_POINTS} endereços por vez.")
    _rate_limit(request, "geocode", limit=300, cost=max(1, len(body.addresses)))
    out = []
    for a in body.addresses:
        r = geo.geocode(a, body.region_hint) if a.strip() else None
        out.append({"address": a, "result": r})
    return {"results": out}


def _route_json(r, vtypes):
    v = vtypes[r.vehicle_type]
    return {
        "vehicle_type": r.vehicle_type,
        "vehicle_name": v.name,
        "capacity": v.capacity,
        "depot": r.depot,
        "stops": r.stops,
        "arrivals": r.arrivals,
        "load": r.load,
        "dist_km": r.dist_km,
        "time_min": r.time_min,
        "cost": round(r.cost, 2),
    }


@app.post("/api/solve")
def solve_endpoint(body: SolveIn, request: Request):
    if len(body.points) > MAX_POINTS:
        raise HTTPException(400, f"Máximo de {MAX_POINTS} pontos.")
    _rate_limit(request, "solve", limit=40)

    points = [Point(p.name or p.address, p.lat, p.lng, p.demand, p.is_depot,
                    p.service_min, p.tw_start, p.tw_end) for p in body.points]
    vtypes = [VehicleType(v.name, v.capacity, v.qty, v.cost_km, v.fixed_cost, v.depot)
              for v in body.vehicles]
    o = body.options
    opt = Options(o.return_to_depot, o.use_time_windows,
                  min(o.time_limit, MAX_TIME_LIMIT), o.horizon_min)

    t0 = time.perf_counter()
    coords_all = [(p.lat, p.lng) for p in points]
    truck = o.vehicle_profile == "truck" and extras.features()["ors"]
    notes = []
    matrix = None
    if truck:
        try:
            d, tm = extras.ors_matrix(coords_all, "driving-hgv")
            matrix = geo.Matrix(d, tm, "ors-hgv")
        except Exception as e:  # noqa: BLE001
            notes.append("Perfil caminhão indisponível agora (OpenRouteService não respondeu); as rotas usaram o perfil carro."
                         + (f" Detalhe: {e}" if isinstance(e, extras.ExtraError) else ""))
            truck = False
    if matrix is None:
        matrix = geo.distance_matrix(coords_all)
    t_matrix = time.perf_counter() - t0

    try:
        with _solver_lock:
            exact, heur = solve(points, vtypes, matrix.dist_km, matrix.time_min, opt)
    except ProblemError as e:
        return JSONResponse({"error": str(e)}, status_code=422)

    routes = []
    for r in exact["routes"]:
        seq = [r.depot] + r.stops + ([r.depot] if opt.return_to_depot else [])
        coords = [(points[i].lat, points[i].lng) for i in seq]
        rj = _route_json(r, vtypes)
        if truck:
            try:
                rj["polylines"] = [extras.ors_polyline(coords, "driving-hgv")]
            except Exception:  # noqa: BLE001
                rj["polylines"] = geo.route_geometry(coords, "osrm")
        else:
            rj["polylines"] = geo.route_geometry(coords, matrix.source)
        if o.traffic and extras.features()["tomtom"] and len(coords) >= 2:
            try:
                rj["traffic"] = extras.tomtom_route_times(coords)
            except Exception:  # noqa: BLE001
                rj["traffic"] = {"error": "TomTom indisponível agora."}
        routes.append(rj)
    heur_routes = []
    for r in heur["routes"]:
        heur_routes.append(_route_json(r, vtypes))

    gap = None
    if exact["cost"] and heur["feasible"]:
        gap = round((heur["cost"] - exact["cost"]) / exact["cost"] * 100, 2)

    commercial = None
    if o.compare_commercial and extras.features()["graphhopper"]:
        t1 = time.perf_counter()
        try:
            gh = extras.graphhopper_vrp(points, vtypes, opt, "truck" if truck else "car")
            gh_routes = [_finish_route(Route(g["vehicle_type"], g["depot"], g["stops"]),
                                       points, matrix.dist_km, matrix.time_min, vtypes, opt) for g in gh]
            feasible = all(evaluate_route(r.stops, r.depot, points, matrix.dist_km, matrix.time_min, opt)[3]
                           for r in gh_routes)
            cost = round(sum(r.cost for r in gh_routes), 4)
            commercial = {"name": "GraphHopper", "cost": cost, "feasible": feasible,
                          "time_s": round(time.perf_counter() - t1, 2),
                          "gap_pct": round((cost - exact["cost"]) / exact["cost"] * 100, 2) if exact["cost"] else None,
                          "routes": [_route_json(r, vtypes) for r in gh_routes]}
        except Exception as e:  # noqa: BLE001
            commercial = {"name": "GraphHopper", "error": str(e) if isinstance(e, extras.ExtraError)
                          else "serviço indisponível agora (tente recalcular em instantes)."}

    return {
        "notes": notes,
        "profile": "truck" if truck else "car",
        "commercial": commercial,
        "matrix": {"source": matrix.source, "time_s": round(t_matrix, 2)},
        "exact": {k: exact[k] for k in ("cost", "status", "status_code", "message", "stats", "time_s")}
        | {"routes": routes},
        "heuristic": {"cost": heur["cost"], "feasible": heur["feasible"],
                      "time_s": heur["time_s"], "routes": heur_routes},
        "gap_pct": gap,
        "totals": {
            "dist_km": round(sum(r["dist_km"] for r in routes), 2),
            "time_min": round(sum(r["time_min"] for r in routes), 1),
            "vehicles_used": len(routes),
            "load": sum(r["load"] for r in routes),
            "capacity_used": sum(r["capacity"] for r in routes),
        },
    }


# --------------------------------------------------------------------------- #
# Extras com chave gratuita (OpenRouteService / TomTom)
# --------------------------------------------------------------------------- #
class IsoIn(BaseModel):
    lat: float
    lng: float
    minutes: list[int] = [10, 20, 30]
    profile: str = "driving-car"


@app.post("/api/isochrones")
def isochrones(body: IsoIn, request: Request):
    _rate_limit(request, "iso", limit=60)
    mins = [m for m in body.minutes if 1 <= m <= 60][:3] or [10, 20, 30]
    prof = body.profile if body.profile in ("driving-car", "driving-hgv") else "driving-car"
    try:
        return extras.ors_isochrones(body.lat, body.lng, mins, prof)
    except extras.ExtraError as e:
        return JSONResponse({"error": str(e)}, status_code=503)
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "OpenRouteService indisponível agora. Tente de novo em instantes."}, status_code=503)


@app.get("/api/traffic/{z}/{x}/{y}.png")
def traffic_tile(z: int, x: int, y: int):
    if not (0 <= z <= 22):
        raise HTTPException(400, "zoom inválido")
    try:
        png = extras.tomtom_tile(z, x, y)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) if isinstance(e, extras.ExtraError) else "TomTom indisponível agora."}, status_code=503)
    return Response(png, media_type="image/png", headers={"Cache-Control": "public, max-age=120"})


# --------------------------------------------------------------------------- #
# Front-end
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
