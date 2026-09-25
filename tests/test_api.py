"""Testes da API HTTP do Rota Roda (sem chave do Google: usa a estimativa por linha reta)."""
from fastapi.testclient import TestClient

from app import geo
from app.main import app

client = TestClient(app)

BODY = {
    "points": [
        {"name": "Deposito", "lat": -22.9056, "lng": -43.1331, "is_depot": True},
        {"name": "A", "lat": -22.9048, "lng": -43.1106, "demand": 100},
        {"name": "B", "lat": -22.8942, "lng": -43.1225, "demand": 80},
        {"name": "C", "lat": -22.8772, "lng": -43.1025, "demand": 60},
    ],
    "vehicles": [{"name": "Van", "capacity": 150, "qty": 2, "cost_km": 1.0, "depot": 0}],
    "options": {"time_limit": 10},
}


def setup_module():
    # Garante execucao offline e deterministica
    geo.GOOGLE_KEY = ""
    geo._matrix_osrm = lambda coords: (_ for _ in ()).throw(RuntimeError("offline"))


def test_config_e_front():
    assert client.get("/api/health").json() == {"ok": True}
    assert "max_points" in client.get("/api/config").json()
    assert "Rota Roda" in client.get("/").text


def test_solve_ok():
    r = client.post("/api/solve", json=BODY)
    assert r.status_code == 200
    d = r.json()
    assert d["exact"]["status"] == "otimo"
    assert sorted(s for rt in d["exact"]["routes"] for s in rt["stops"]) == [1, 2, 3]
    assert d["matrix"]["source"] == "haversine"
    assert d["gap_pct"] is not None and d["gap_pct"] >= 0


def test_solve_erro_amigavel():
    body = {**BODY, "vehicles": [{"name": "Moto", "capacity": 50, "qty": 9, "depot": 0}]}
    r = client.post("/api/solve", json=body)
    assert r.status_code == 422
    assert "maior que a capacidade" in r.json()["error"]


def test_limite_de_pontos():
    body = {**BODY, "points": BODY["points"] * 30}
    assert client.post("/api/solve", json=body).status_code == 400
