"""Servicos geograficos: geocodificacao, matriz de distancias/tempos e geometria das rotas.

Por padrao tudo e GRATUITO e sem chave (OpenStreetMap: Photon, Nominatim e OSRM).
Se houver GOOGLE_MAPS_SERVER_KEY, o Google e usado primeiro. Ordem de preferencia:
  1. Google Maps Platform (Geocoding API + Routes API) -> opcional, precisa de chave
  2. OpenStreetMap (Photon/Nominatim + OSRM publico)   -> gratuito, sem chave
  3. Distancia em linha reta (Haversine) x fator de desvio -> ultimo recurso, sempre funciona
"""
from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass

import httpx

GOOGLE_KEY = os.getenv("GOOGLE_MAPS_SERVER_KEY", "").strip()
USER_AGENT = "rota-roda-uff/1.0 (trabalho academico)"
TIMEOUT = httpx.Timeout(20.0, connect=8.0)

# Fator de desvio usado no ultimo recurso: ruas nao sao linha reta.
DETOUR_FACTOR = 1.35
FALLBACK_SPEED_KMH = 25.0  # velocidade media urbana assumida sem dados reais

# Limites da Routes API (computeRouteMatrix: ate 625 elementos por chamada sem transito;
# computeRoutes: ate 25 pontos intermediarios).
MATRIX_BLOCK = 25
MAX_INTERMEDIATES = 25

_matrix_cache: dict[tuple, "Matrix"] = {}


@dataclass
class Matrix:
    dist_km: list[list[float]]
    time_min: list[list[float]]
    source: str  # "google" | "osrm" | "haversine"


# --------------------------------------------------------------------------- #
# Geocodificacao
# --------------------------------------------------------------------------- #
def geocode(address: str, region_hint: str = "") -> dict | None:
    """Converte endereco em coordenadas. Retorna {lat, lng, formatted, source} ou None."""
    query = address.strip()
    if region_hint and region_hint.lower() not in query.lower():
        query = f"{query}, {region_hint}"
    if GOOGLE_KEY:
        try:
            r = httpx.get(
                "https://maps.googleapis.com/maps/api/geocode/json",
                params={"address": query, "key": GOOGLE_KEY, "region": "br",
                        "language": "pt-BR", "components": "country:BR"},
                timeout=TIMEOUT,
            )
            data = r.json()
            if data.get("status") == "OK" and data.get("results"):
                res = data["results"][0]
                loc = res["geometry"]["location"]
                return {"lat": loc["lat"], "lng": loc["lng"],
                        "formatted": res.get("formatted_address", query),
                        "partial": bool(res.get("partial_match")), "source": "google"}
        except Exception:
            pass
    try:
        r = httpx.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "json", "limit": 1, "countrycodes": "br"},
            headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT,
        )
        time.sleep(1.0)  # politica de uso do Nominatim: 1 requisicao/s
        items = r.json()
        if items:
            it = items[0]
            return {"lat": float(it["lat"]), "lng": float(it["lon"]),
                    "formatted": it.get("display_name", query), "partial": False,
                    "source": "osm"}
    except Exception:
        pass
    return None


# --------------------------------------------------------------------------- #
# Busca de enderecos enquanto digita (modo gratuito) e endereco de um clique
# --------------------------------------------------------------------------- #
_suggest_cache: dict[tuple, list] = {}


def _photon_label(pr: dict) -> tuple[str, str, str]:
    """Monta (principal, secundario, completo) a partir das propriedades do Photon."""
    street = pr.get("street") or ""
    num = pr.get("housenumber") or ""
    name = pr.get("name") or ""
    main = f"{street}, {num}" if street and num else (street or name)
    if name and street and name not in (street, main):
        main = f"{name} · {main}"
    area = pr.get("district") or pr.get("locality") or pr.get("suburb") or ""
    city = pr.get("city") or pr.get("county") or ""
    state = pr.get("state") or ""
    uf = STATE_UF.get(state, state)
    sec = " - ".join(x for x in [", ".join(y for y in [area, city] if y), uf] if x)
    full = ", ".join(x for x in [main, sec] if x)
    return main or sec, sec, full


STATE_UF = {
    "Rio de Janeiro": "RJ", "São Paulo": "SP", "Minas Gerais": "MG", "Espírito Santo": "ES",
    "Paraná": "PR", "Santa Catarina": "SC", "Rio Grande do Sul": "RS", "Bahia": "BA",
    "Distrito Federal": "DF", "Goiás": "GO", "Pernambuco": "PE", "Ceará": "CE",
}


def suggest(q: str, lat: float | None = None, lng: float | None = None, limit: int = 6) -> list[dict]:
    """Sugestoes de endereco (Photon/OpenStreetMap, gratuito). Cada item: main, sec, address, lat, lng."""
    q = q.strip()
    if len(q) < 3:
        return []
    key = (q.lower(), round(lat or 0, 1), round(lng or 0, 1))
    if key in _suggest_cache:
        return _suggest_cache[key]
    items: list[dict] = []
    try:
        params = {"q": q, "limit": limit * 2}
        if lat is not None and lng is not None:
            params.update(lat=lat, lon=lng)
        r = httpx.get("https://photon.komoot.io/api/", params=params,
                      headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
        r.raise_for_status()
        for f in r.json().get("features", []):
            pr = f.get("properties", {})
            if (pr.get("countrycode") or "").upper() not in ("BR", ""):
                continue
            lon_, lat_ = f["geometry"]["coordinates"][:2]
            main, sec, full = _photon_label(pr)
            items.append({"main": main, "sec": sec, "address": full, "lat": lat_, "lng": lon_})
            if len(items) >= limit:
                break
    except Exception:
        items = []
    if not items:
        try:
            r = httpx.get("https://nominatim.openstreetmap.org/search",
                          params={"q": q, "format": "json", "limit": limit, "countrycodes": "br"},
                          headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
            for it in r.json():
                parts = it.get("display_name", "").split(", ")
                items.append({"main": ", ".join(parts[:2]), "sec": ", ".join(parts[2:5]),
                              "address": it.get("display_name", ""),
                              "lat": float(it["lat"]), "lng": float(it["lon"])})
        except Exception:
            pass
    if items:
        if len(_suggest_cache) > 2000:
            _suggest_cache.clear()
        _suggest_cache[key] = items
    return items


def reverse(lat: float, lng: float) -> str | None:
    """Endereco aproximado de uma coordenada (clique no mapa)."""
    if GOOGLE_KEY:
        try:
            r = httpx.get("https://maps.googleapis.com/maps/api/geocode/json",
                          params={"latlng": f"{lat},{lng}", "key": GOOGLE_KEY, "language": "pt-BR"},
                          timeout=TIMEOUT)
            res = r.json().get("results") or []
            if res:
                return res[0]["formatted_address"]
        except Exception:
            pass
    try:
        r = httpx.get("https://photon.komoot.io/reverse", params={"lat": lat, "lon": lng},
                      headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
        feats = r.json().get("features", [])
        if feats:
            return _photon_label(feats[0].get("properties", {}))[2]
    except Exception:
        pass
    try:
        r = httpx.get("https://nominatim.openstreetmap.org/reverse",
                      params={"lat": lat, "lon": lng, "format": "json", "zoom": 18},
                      headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
        return r.json().get("display_name")
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# Matriz de distancias e tempos
# --------------------------------------------------------------------------- #
def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0088 * math.asin(math.sqrt(h))


def _matrix_haversine(coords):
    n = len(coords)
    dist = [[0.0] * n for _ in range(n)]
    tmin = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                d = haversine_km(coords[i], coords[j]) * DETOUR_FACTOR
                dist[i][j] = round(d, 3)
                tmin[i][j] = round(d / FALLBACK_SPEED_KMH * 60, 2)
    return Matrix(dist, tmin, "haversine")


def _waypoint(lat, lng):
    return {"waypoint": {"location": {"latLng": {"latitude": lat, "longitude": lng}}}}


def _parse_duration(s: str | None) -> float:
    return float(s.rstrip("s")) if s else 0.0


def _matrix_google(coords):
    n = len(coords)
    dist = [[0.0] * n for _ in range(n)]
    tmin = [[0.0] * n for _ in range(n)]
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,duration,condition",
    }
    with httpx.Client(timeout=TIMEOUT) as client:
        for oi in range(0, n, MATRIX_BLOCK):
            for di in range(0, n, MATRIX_BLOCK):
                origins = coords[oi:oi + MATRIX_BLOCK]
                dests = coords[di:di + MATRIX_BLOCK]
                body = {
                    "origins": [_waypoint(*c) for c in origins],
                    "destinations": [_waypoint(*c) for c in dests],
                    "travelMode": "DRIVE",
                    "routingPreference": "TRAFFIC_UNAWARE",
                }
                r = client.post(
                    "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
                    json=body, headers=headers)
                r.raise_for_status()
                for el in r.json():
                    i = oi + el.get("originIndex", 0)
                    j = di + el.get("destinationIndex", 0)
                    if i == j:
                        continue
                    if el.get("condition") != "ROUTE_EXISTS":
                        raise RuntimeError(f"Sem rota entre os pontos {i} e {j}")
                    dist[i][j] = round(el.get("distanceMeters", 0) / 1000, 3)
                    tmin[i][j] = round(_parse_duration(el.get("duration")) / 60, 2)
    return Matrix(dist, tmin, "google")


_osrm_last = [0.0]


def _osrm_get(url: str, params: dict) -> httpx.Response:
    """GET no servidor publico do OSRM respeitando a politica de uso (~1 requisicao/s)."""
    for attempt in range(3):
        wait = 1.05 - (time.monotonic() - _osrm_last[0])
        if wait > 0:
            time.sleep(wait)
        _osrm_last[0] = time.monotonic()
        r = httpx.get(url, params=params, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
        if r.status_code != 429:
            r.raise_for_status()
            return r
    r.raise_for_status()
    return r


def _matrix_osrm(coords):
    n = len(coords)
    path = ";".join(f"{lng},{lat}" for lat, lng in coords)
    r = _osrm_get(f"https://router.project-osrm.org/table/v1/driving/{path}",
                  {"annotations": "distance,duration"})
    data = r.json()
    if data.get("code") != "Ok":
        raise RuntimeError(data.get("message", "OSRM falhou"))
    dist = [[round((data["distances"][i][j] or 0) / 1000, 3) for j in range(n)] for i in range(n)]
    tmin = [[round((data["durations"][i][j] or 0) / 60, 2) for j in range(n)] for i in range(n)]
    return Matrix(dist, tmin, "osrm")


def distance_matrix(coords: list[tuple[float, float]]) -> Matrix:
    key = tuple((round(a, 6), round(b, 6)) for a, b in coords)
    if key in _matrix_cache:
        return _matrix_cache[key]
    m = None
    if GOOGLE_KEY:
        try:
            m = _matrix_google(coords)
        except Exception:
            m = None
    if m is None and len(coords) <= 100:
        try:
            m = _matrix_osrm(coords)
        except Exception:
            m = None
    if m is None:
        m = _matrix_haversine(coords)
    if m.source != "haversine":
        _matrix_cache[key] = m
    return m


# --------------------------------------------------------------------------- #
# Geometria das rotas (para desenhar pelas ruas)
# --------------------------------------------------------------------------- #
def _polyline_google(seq):
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_KEY,
        "X-Goog-FieldMask": "routes.polyline.encodedPolyline",
    }
    body = {
        "origin": {"location": {"latLng": {"latitude": seq[0][0], "longitude": seq[0][1]}}},
        "destination": {"location": {"latLng": {"latitude": seq[-1][0], "longitude": seq[-1][1]}}},
        "intermediates": [{"location": {"latLng": {"latitude": a, "longitude": b}}} for a, b in seq[1:-1]],
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_UNAWARE",
        "polylineQuality": "HIGH_QUALITY",
    }
    r = httpx.post("https://routes.googleapis.com/directions/v2:computeRoutes",
                   json=body, headers=headers, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()["routes"][0]["polyline"]["encodedPolyline"]


def _polyline_osrm(seq):
    path = ";".join(f"{lng},{lat}" for lat, lng in seq)
    r = _osrm_get(f"https://router.project-osrm.org/route/v1/driving/{path}",
                  {"overview": "full", "geometries": "polyline"})
    return r.json()["routes"][0]["geometry"]


def route_geometry(seq: list[tuple[float, float]], source: str) -> list[str]:
    """Lista de polylines codificadas (formato Google, precisao 5) cobrindo a sequencia.

    Rotas longas sao quebradas em trechos que respeitam o limite de intermediarios.
    Lista vazia = sem geometria (o front desenha segmentos retos).
    """
    if len(seq) < 2 or source == "haversine":
        return []
    chunks, step = [], MAX_INTERMEDIATES + 1
    for s in range(0, len(seq) - 1, step):
        chunks.append(seq[s:s + step + 1])
    out = []
    for ch in chunks:
        try:
            out.append(_polyline_google(ch) if source == "google" else _polyline_osrm(ch))
        except Exception:
            return []
    return out
