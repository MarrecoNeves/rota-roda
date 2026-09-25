"""Integracoes opcionais com APIs gratuitas que exigem cadastro (chave grátis).

Cada recurso so fica ativo se a variavel de ambiente correspondente existir:
  GRAPHHOPPER_API_KEY -> comparacao com o otimizador comercial GraphHopper
  ORS_API_KEY         -> OpenRouteService: perfil caminhao (driving-hgv) e isocronas
  TOMTOM_API_KEY      -> TomTom: camada de transito e tempo das rotas com transito agora
"""
from __future__ import annotations

import os
import time

import httpx

TIMEOUT = httpx.Timeout(40.0, connect=8.0)


def _key(name: str) -> str:
    return os.getenv(name, "").strip()


def features() -> dict:
    return {
        "graphhopper": bool(_key("GRAPHHOPPER_API_KEY")),
        "ors": bool(_key("ORS_API_KEY")),
        "tomtom": bool(_key("TOMTOM_API_KEY")),
    }


class ExtraError(RuntimeError):
    """Falha amigavel de uma API externa (mensagem pronta para o usuario)."""


# --------------------------------------------------------------------------- #
# GraphHopper Route Optimization (heuristica comercial para comparacao)
# --------------------------------------------------------------------------- #
def graphhopper_vrp(points, vtypes, opt, profile: str = "car") -> list[dict]:
    """Resolve no GraphHopper e devolve rotas como [{'vehicle_type': k, 'depot': d, 'stops': [...]}]."""
    key = _key("GRAPHHOPPER_API_KEY")
    if not key:
        raise ExtraError("GraphHopper sem chave configurada.")
    customers = [i for i, p in enumerate(points) if not p.is_depot]
    vehicles, types = [], []
    for k, v in enumerate(vtypes):
        types.append({
            "type_id": f"t{k}", "profile": profile, "capacity": [int(v.capacity)],
            "cost_per_meter": float(v.cost_km) / 1000.0, "cost_per_second": 0.0,
            "cost_per_activation": float(v.fixed_cost),
        })
        dep = points[v.depot]
        for n in range(int(v.qty)):
            veh = {
                "vehicle_id": f"v{k}_{n}", "type_id": f"t{k}",
                "start_address": {"location_id": f"p{v.depot}", "lon": dep.lng, "lat": dep.lat},
                "return_to_depot": bool(opt.return_to_depot),
            }
            if opt.use_time_windows:
                veh.update(earliest_start=0, latest_end=int(opt.horizon_min * 60))
            vehicles.append(veh)
    services = []
    for c in customers:
        p = points[c]
        s = {"id": f"s{c}", "address": {"location_id": f"p{c}", "lon": p.lng, "lat": p.lat},
             "size": [int(p.demand)], "duration": int(p.service_min * 60)}
        if opt.use_time_windows:
            a = 0 if p.tw_start is None else p.tw_start
            b = opt.horizon_min if p.tw_end is None else p.tw_end
            s["time_windows"] = [{"earliest": int(a * 60), "latest": int(b * 60)}]
        services.append(s)
    body = {"vehicles": vehicles, "vehicle_types": types, "services": services,
            "configuration": {"routing": {"calc_points": False}}}
    r = httpx.post("https://graphhopper.com/api/1/vrp", params={"key": key}, json=body, timeout=TIMEOUT)
    if r.status_code != 200:
        msg = r.json().get("message", r.text[:200]) if r.headers.get("content-type", "").startswith("application/json") else r.text[:200]
        raise ExtraError(f"GraphHopper recusou o problema: {msg}")
    sol = r.json().get("solution", {})
    unassigned = (sol.get("unassigned") or {}).get("services") or []
    if unassigned:
        raise ExtraError(f"GraphHopper deixou {len(unassigned)} cliente(s) sem atender.")
    out = []
    for rt in sol.get("routes", []):
        k = int(rt["vehicle_id"][1:].split("_")[0])
        stops = [int(a["id"][1:]) for a in rt.get("activities", []) if a.get("type") == "service"]
        if stops:
            out.append({"vehicle_type": k, "depot": vtypes[k].depot, "stops": stops})
    return out


# --------------------------------------------------------------------------- #
# OpenRouteService: matriz/geometria para caminhao e isocronas
# --------------------------------------------------------------------------- #
ORS = "https://api.openrouteservice.org/v2"


def _ors_headers():
    key = _key("ORS_API_KEY")
    if not key:
        raise ExtraError("OpenRouteService sem chave configurada.")
    return {"Authorization": key, "Content-Type": "application/json"}


def ors_matrix(coords, profile: str = "driving-hgv"):
    r = httpx.post(f"{ORS}/matrix/{profile}", headers=_ors_headers(), timeout=TIMEOUT,
                   json={"locations": [[lng, lat] for lat, lng in coords],
                         "metrics": ["distance", "duration"], "units": "km"})
    if r.status_code != 200:
        raise ExtraError(f"OpenRouteService (matriz) respondeu {r.status_code}.")
    d = r.json()
    n = len(coords)
    dist = [[round(d["distances"][i][j] or 0, 3) for j in range(n)] for i in range(n)]
    tmin = [[round((d["durations"][i][j] or 0) / 60, 2) for j in range(n)] for i in range(n)]
    return dist, tmin


def ors_polyline(seq, profile: str = "driving-hgv") -> str:
    r = httpx.post(f"{ORS}/directions/{profile}", headers=_ors_headers(), timeout=TIMEOUT,
                   json={"coordinates": [[lng, lat] for lat, lng in seq]})
    if r.status_code != 200:
        raise ExtraError(f"OpenRouteService (rota) respondeu {r.status_code}.")
    return r.json()["routes"][0]["geometry"]


def ors_isochrones(lat: float, lng: float, minutes: list[int], profile: str = "driving-car") -> dict:
    r = httpx.post(f"{ORS}/isochrones/{profile}", headers=_ors_headers(), timeout=TIMEOUT,
                   json={"locations": [[lng, lat]], "range": [m * 60 for m in minutes], "range_type": "time"})
    if r.status_code != 200:
        raise ExtraError(f"OpenRouteService (isócronas) respondeu {r.status_code}.")
    return r.json()


# --------------------------------------------------------------------------- #
# TomTom: transito
# --------------------------------------------------------------------------- #
_tile_cache: dict[tuple, tuple[float, bytes]] = {}


def tomtom_route_times(seq) -> dict:
    """Tempo da sequencia com e sem transito agora (segundos)."""
    key = _key("TOMTOM_API_KEY")
    if not key:
        raise ExtraError("TomTom sem chave configurada.")
    locs = ":".join(f"{lat},{lng}" for lat, lng in seq)
    r = httpx.get(f"https://api.tomtom.com/routing/1/calculateRoute/{locs}/json",
                  params={"key": key, "traffic": "true", "travelMode": "car",
                          "computeTravelTimeFor": "all", "routeRepresentation": "none"},
                  timeout=TIMEOUT)
    if r.status_code != 200:
        raise ExtraError(f"TomTom respondeu {r.status_code}.")
    s = r.json()["routes"][0]["summary"]
    return {"with_traffic_s": s.get("travelTimeInSeconds"),
            "no_traffic_s": s.get("noTrafficTravelTimeInSeconds", s.get("travelTimeInSeconds")),
            "delay_s": s.get("trafficDelayInSeconds", 0),
            "length_m": s.get("lengthInMeters")}


def tomtom_tile(z: int, x: int, y: int) -> bytes:
    key = _key("TOMTOM_API_KEY")
    if not key:
        raise ExtraError("TomTom sem chave configurada.")
    ck = (z, x, y)
    hit = _tile_cache.get(ck)
    if hit and time.time() - hit[0] < 120:  # transito muda rapido: cache de 2 min
        return hit[1]
    r = httpx.get(f"https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png",
                  params={"key": key}, timeout=TIMEOUT)
    if r.status_code != 200:
        raise ExtraError(f"TomTom respondeu {r.status_code}.")
    if len(_tile_cache) > 3000:
        _tile_cache.clear()
    _tile_cache[ck] = (time.time(), r.content)
    return r.content
