"""Testa o parsing das respostas da Google Routes API com respostas simuladas."""
import json

import httpx

from app import geo


def fake_matrix_handler(request: httpx.Request):
    body = json.loads(request.content)
    assert request.headers["X-Goog-Api-Key"] == "k"
    no, nd = len(body["origins"]), len(body["destinations"])
    assert no * nd <= 625
    out = []
    for i in range(no):
        for j in range(nd):
            el = {"originIndex": i, "destinationIndex": j, "condition": "ROUTE_EXISTS", "duration": f"{60 * (i + j + 1)}s"}
            if i != j:
                el["distanceMeters"] = 1000 * (i + 1) + j
            out.append(el)
    return httpx.Response(200, json=out)


def test_matriz_google_em_blocos(monkeypatch):
    monkeypatch.setattr(geo, "GOOGLE_KEY", "k")
    real_client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(fake_matrix_handler)))
    coords = [(-22.9 + i * 0.001, -43.1) for i in range(30)]  # 30 pontos -> 4 blocos
    m = geo._matrix_google(coords)
    assert m.source == "google"
    assert m.dist_km[0][1] == 1.001          # 1000*(0+1)+1 metros
    assert m.dist_km[26][27] == 2.002        # bloco (25..29): indices locais 1 e 2
    assert m.dist_km[5][5] == 0.0
    assert m.time_min[0][1] == 2.0           # 120 s


def test_polyline_google(monkeypatch):
    monkeypatch.setattr(geo, "GOOGLE_KEY", "k")
    calls = []

    def fake_post(url, json=None, headers=None, timeout=None):
        calls.append(len(json["intermediates"]))
        assert "routes.polyline.encodedPolyline" in headers["X-Goog-FieldMask"]
        return httpx.Response(200, json={"routes": [{"polyline": {"encodedPolyline": "abc"}}]},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    seq = [(-22.9, -43.1 + i * 0.001) for i in range(40)]  # 38 intermediarios -> 2 trechos
    polys = geo.route_geometry(seq, "google")
    assert polys == ["abc", "abc"]
    assert all(c <= geo.MAX_INTERMEDIATES for c in calls)


def test_sem_geometria_no_modo_estimado():
    assert geo.route_geometry([(0, 0), (1, 1)], "haversine") == []


PHOTON = {"features": [
    {"geometry": {"coordinates": [-43.1225, -22.8942]},
     "properties": {"countrycode": "BR", "street": "Rua da Conceição", "housenumber": "100",
                    "district": "Centro", "city": "Niterói", "state": "Rio de Janeiro"}},
    {"geometry": {"coordinates": [-8.6, 41.1]},
     "properties": {"countrycode": "PT", "street": "Rua da Conceição", "city": "Porto"}},
    {"geometry": {"coordinates": [-43.10, -22.90]},
     "properties": {"countrycode": "BR", "name": "Campo de São Bento", "city": "Niterói", "state": "Rio de Janeiro"}},
]}


def test_sugestoes_photon_gratuitas(monkeypatch):
    geo._suggest_cache.clear()
    seen = {}

    def fake_get(url, params=None, headers=None, timeout=None):
        seen["url"], seen["params"] = url, params
        return httpx.Response(200, json=PHOTON, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", fake_get)
    items = geo.suggest("rua da conceicao", -22.9, -43.1)
    assert "photon" in seen["url"] and seen["params"]["lat"] == -22.9
    assert len(items) == 2  # resultado de Portugal descartado
    assert items[0]["main"] == "Rua da Conceição, 100"
    assert items[0]["sec"] == "Centro, Niterói - RJ"
    assert items[0]["lat"] == -22.8942 and items[0]["lng"] == -43.1225
    assert items[1]["main"] == "Campo de São Bento"


def test_endereco_do_clique(monkeypatch):
    monkeypatch.setattr(geo, "GOOGLE_KEY", "")

    def fake_get(url, params=None, headers=None, timeout=None):
        return httpx.Response(200, json={"features": PHOTON["features"][:1]}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", fake_get)
    assert geo.reverse(-22.8942, -43.1225) == "Rua da Conceição, 100, Centro, Niterói - RJ"


def test_osrm_respeita_limite_e_repete_em_429(monkeypatch):
    calls = []

    def fake_get(url, params=None, headers=None, timeout=None):
        calls.append(url)
        code = 429 if len(calls) == 1 else 200
        return httpx.Response(code, json={"routes": [{"geometry": "xyz"}]}, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx, "get", fake_get)
    monkeypatch.setattr(geo.time, "sleep", lambda s: None)
    assert geo.route_geometry([(-22.9, -43.1), (-22.91, -43.11)], "osrm") == ["xyz"]
    assert len(calls) == 2
