"""Testes das integracoes opcionais (GraphHopper, OpenRouteService, TomTom) com respostas simuladas."""
import httpx
import pytest
from fastapi.testclient import TestClient

from app import extras, geo
from app.main import app
from app.solver import Options, Point, VehicleType

POINTS = [
    Point("D", -22.9056, -43.1331, 0, True),
    Point("A", -22.9048, -43.1106, 100),
    Point("B", -22.8942, -43.1225, 80),
    Point("C", -22.8772, -43.1025, 60),
]
VT = [VehicleType("Van", 150, 2, 1.0, 0.0, 0)]


def test_sem_chaves_tudo_inativo(monkeypatch):
    for k in ("GRAPHHOPPER_API_KEY", "ORS_API_KEY", "TOMTOM_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    assert extras.features() == {"graphhopper": False, "ors": False, "tomtom": False}
    with pytest.raises(extras.ExtraError):
        extras.graphhopper_vrp(POINTS, VT, Options())


def test_graphhopper_monta_pedido_e_le_rotas(monkeypatch):
    monkeypatch.setenv("GRAPHHOPPER_API_KEY", "k")
    seen = {}

    def fake_post(url, params=None, json=None, timeout=None, **kw):
        seen["body"] = json
        sol = {"solution": {"routes": [
            {"vehicle_id": "v0_0", "activities": [{"type": "start"}, {"type": "service", "id": "s2"},
                                                   {"type": "service", "id": "s3"}, {"type": "end"}]},
            {"vehicle_id": "v0_1", "activities": [{"type": "start"}, {"type": "service", "id": "s1"}, {"type": "end"}]},
        ], "unassigned": {"services": []}}}
        return httpx.Response(200, json=sol, request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    routes = extras.graphhopper_vrp(POINTS, VT, Options())
    body = seen["body"]
    assert len(body["vehicles"]) == 2 and body["vehicle_types"][0]["capacity"] == [150]
    assert body["vehicle_types"][0]["cost_per_meter"] == pytest.approx(0.001)
    assert {s["id"] for s in body["services"]} == {"s1", "s2", "s3"}
    assert routes == [{"vehicle_type": 0, "depot": 0, "stops": [2, 3]}, {"vehicle_type": 0, "depot": 0, "stops": [1]}]


def test_graphhopper_cliente_sem_atendimento_vira_erro(monkeypatch):
    monkeypatch.setenv("GRAPHHOPPER_API_KEY", "k")
    monkeypatch.setattr(httpx, "post", lambda url, **kw: httpx.Response(
        200, json={"solution": {"routes": [], "unassigned": {"services": ["s1"]}}}, request=httpx.Request("POST", url)))
    with pytest.raises(extras.ExtraError, match="sem atender"):
        extras.graphhopper_vrp(POINTS, VT, Options())


def test_ors_matriz_caminhao(monkeypatch):
    monkeypatch.setenv("ORS_API_KEY", "k")

    def fake_post(url, headers=None, json=None, timeout=None, **kw):
        assert "driving-hgv" in url and headers["Authorization"] == "k"
        n = len(json["locations"])
        return httpx.Response(200, json={"distances": [[0 if i == j else 1.5 for j in range(n)] for i in range(n)],
                                         "durations": [[0 if i == j else 120 for j in range(n)] for i in range(n)]},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx, "post", fake_post)
    d, t = extras.ors_matrix([(p.lat, p.lng) for p in POINTS])
    assert d[0][1] == 1.5 and t[0][1] == 2.0 and d[2][2] == 0


def test_tomtom_tempo_com_transito(monkeypatch):
    monkeypatch.setenv("TOMTOM_API_KEY", "k")
    monkeypatch.setattr(httpx, "get", lambda url, params=None, timeout=None, **kw: httpx.Response(
        200, json={"routes": [{"summary": {"travelTimeInSeconds": 1500, "noTrafficTravelTimeInSeconds": 1200,
                                           "trafficDelayInSeconds": 300, "lengthInMeters": 9000}}]},
        request=httpx.Request("GET", url)))
    t = extras.tomtom_route_times([(-22.9, -43.1), (-22.91, -43.11)])
    assert t["with_traffic_s"] == 1500 and t["delay_s"] == 300


def test_api_compara_com_graphhopper(monkeypatch):
    monkeypatch.setenv("GRAPHHOPPER_API_KEY", "k")
    monkeypatch.delenv("TOMTOM_API_KEY", raising=False)
    monkeypatch.setattr(geo, "GOOGLE_KEY", "")
    monkeypatch.setattr(geo, "_matrix_osrm", lambda c: (_ for _ in ()).throw(RuntimeError("offline")))
    monkeypatch.setattr(extras, "graphhopper_vrp", lambda *a, **k: [
        {"vehicle_type": 0, "depot": 0, "stops": [1, 2]}, {"vehicle_type": 0, "depot": 0, "stops": [3]}])
    client = TestClient(app)
    assert client.get("/api/config").json()["features"]["graphhopper"] is True
    body = {"points": [{"name": p.name, "lat": p.lat, "lng": p.lng, "demand": p.demand, "is_depot": p.is_depot} for p in POINTS],
            "vehicles": [{"name": "Van", "capacity": 200, "qty": 2, "cost_km": 1.0, "depot": 0}]}
    d = client.post("/api/solve", json=body).json()
    com = d["commercial"]
    assert com["name"] == "GraphHopper" and com["feasible"] is True
    assert com["cost"] >= d["exact"]["cost"] - 1e-6  # o exato nunca perde para a heuristica comercial
    assert com["gap_pct"] >= 0


def test_isocronas_sem_chave_responde_503(monkeypatch):
    monkeypatch.delenv("ORS_API_KEY", raising=False)
    r = TestClient(app).post("/api/isochrones", json={"lat": -22.9, "lng": -43.1})
    assert r.status_code == 503 and "chave" in r.json()["error"]
