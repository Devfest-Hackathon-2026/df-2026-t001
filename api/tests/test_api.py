import os

os.environ.setdefault("REQUIRE_AUTH", "0")
import pytest
from fastapi.testclient import TestClient

from app import config, events, guard, main
from app.main import app

c = TestClient(app)
RESET = {config.RESET_HEADER: config.RESET_HEADER_VALUE}


def S(**kw) -> dict:
    """現行UI（store.ts State）の最小形。"""
    base = {"v": 8, "today": "2026-11-18", "now": "2026-11-18 14:00", "assignments": [], "vacancies": [], "health": [], "messages": []}
    base.update(kw)
    return base


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr(config, "RESET_COOLDOWN_SEC", 0)
    monkeypatch.setattr(config, "RESET_PER_IP_PER_HOUR", 1000)
    guard._reset_hits.clear()
    guard._write_hits.clear()
    guard._req_hits.clear()
    main._hits.clear()
    c.post("/api/state/reset", headers=RESET)
    events.clear_local()
    yield


def ver() -> int:
    return c.get("/api/state").json()["version"]


def put(app_state, base=None):
    return c.put("/api/state", json={"base": ver() if base is None else base, "app": app_state})


def test_health():
    assert c.get("/api/healthz").json()["ok"] is True


def test_put_get_version_and_304():
    v0 = ver()
    r = put(S(messages=[{"id": "M1", "text": "a < b"}]))
    assert r.status_code == 200 and r.json()["version"] == v0 + 1
    got = c.get("/api/state").json()
    assert got["version"] == v0 + 1 and got["data"]["app"]["messages"][0]["text"] == "a < b"
    assert c.get(f"/api/state?since={got['version']}").status_code == 304


def test_stale_base_is_rejected_with_current_state():
    v0 = ver()
    assert put(S(messages=[{"id": "M1", "text": "leader"}]), base=v0).status_code == 200
    r = put(S(health=[{"id": "H1", "staffId": "E1"}]), base=v0)  # 同じ基準からの2台目の更新
    assert r.status_code == 409
    body = r.json()
    assert body["version"] == v0 + 1 and body["data"]["app"]["messages"][0]["text"] == "leader"
    # 保存済みの状態は上書きされていない（先の更新が消えない）
    assert c.get("/api/state").json()["data"]["app"]["messages"][0]["text"] == "leader"
    # マージ後に最新の基準で再送すると通る
    assert put(S(messages=[{"id": "M1", "text": "leader"}], health=[{"id": "H1", "staffId": "E1"}]), base=body["version"]).status_code == 200


def test_put_requires_base():
    assert c.put("/api/state", json={"app": S()}).status_code == 422
    assert c.put("/api/state", json={"patch": {"app": S()}}).status_code == 422


def test_reset_is_single_version_bump_and_requires_header():
    v0 = ver()
    assert c.post("/api/state/reset").status_code == 403
    r = c.post("/api/state/reset", headers=RESET)
    assert r.status_code == 200 and r.json()["version"] == v0 + 1 == ver()
    assert c.get("/api/state").json()["data"] == {}


def test_reset_cooldown_and_ip_limit(monkeypatch):
    monkeypatch.setattr(config, "RESET_COOLDOWN_SEC", 60)
    guard._last_reset[0] = 0
    assert c.post("/api/state/reset", headers=RESET).status_code == 200
    assert c.post("/api/state/reset", headers=RESET).status_code == 429
    monkeypatch.setattr(config, "RESET_COOLDOWN_SEC", 0)
    monkeypatch.setattr(config, "RESET_PER_IP_PER_HOUR", 1)
    guard._reset_hits.clear()
    assert c.post("/api/state/reset", headers=RESET).status_code == 200
    assert c.post("/api/state/reset", headers=RESET).status_code == 429


def test_write_limit_per_ip(monkeypatch):
    monkeypatch.setattr(config, "WRITE_PER_IP_PER_MIN", 2)
    assert put(S()).status_code == 200
    assert put(S()).status_code == 200
    assert put(S()).status_code == 429


def test_events_only_for_new_transitions():
    put(S(vacancies=[{"id": "VAC-1", "state": "open"}]))
    assert events.local_events() == []  # 初回登録はイベントにしない
    put(S(vacancies=[{"id": "VAC-1", "state": "offering"}]))
    put(S(vacancies=[{"id": "VAC-1", "state": "filled"}, {"id": "VAC-2", "state": "open"}]))
    put(S(vacancies=[{"id": "VAC-1", "state": "filled"}, {"id": "VAC-2", "state": "open"}]))  # 変化なし
    ev = [(e["event_type"], e["vacancy_id"]) for e in events.local_events()]
    assert ev == [("vacancy_status_changed", "VAC-1"), ("vacancy_status_changed", "VAC-1"), ("vacancy_created", "VAC-2")]


def test_stale_repush_emits_nothing():
    v0 = ver()
    put(S(vacancies=[{"id": "VAC-1", "state": "offering"}]), base=v0)
    put(S(vacancies=[{"id": "VAC-1", "state": "filled"}]))
    events.clear_local()
    assert put(S(vacancies=[{"id": "VAC-1", "state": "offering"}]), base=v0 + 1).status_code == 409  # 古い状態の再送
    assert events.local_events() == []
    assert c.get("/api/state").json()["data"]["app"]["vacancies"][0]["state"] == "filled"


def test_health_submitted_from_current_ui():
    put(S())
    put(S(health=[{"id": "H9", "staffId": "E1", "temp": 37.8, "symptoms": [], "consult": False}, {"id": "H1", "staffId": "E2", "temp": 36.4, "symptoms": [], "consult": False}]))
    hs = [e for e in events.local_events() if e["event_type"] == "health_submitted"]
    assert len(hs) == 2 and '"consult"' in hs[0]["payload"] and '"normal"' in hs[1]["payload"]


def test_demo_reset_by_clock_rewind_emits_single_event():
    put(S(now="2026-11-18 15:30", vacancies=[{"id": "VAC-1", "state": "filled"}]))
    put(S(now="2026-11-18 14:00", vacancies=[{"id": "VAC-1", "state": "open"}]))
    assert [e["event_type"] for e in events.local_events()] == ["demo_reset"]


def test_schema_validation():
    assert put({"v": 8}).status_code == 422  # 必須項目なし
    assert put(S(v="8")).status_code == 422
    assert put(S(vacancies={"id": "x"})).status_code == 422
    assert put(S(vacancies=[{"state": "open"}])).status_code == 422  # id なし
    assert put(S(messages=[{"id": "M", "text": "x" * 6000}])).status_code == 422
    assert put(S(messages=[{"id": "M", "x": {"__proto__": 1}}])).status_code == 422
    assert put(S(autopilot=[1])).status_code == 422
    assert put(S(**{f"k{i}": 1 for i in range(60)})).status_code == 422
    assert put(S(text="nul\x00")).status_code == 422
    assert put(S(notices=[{"id": f"N{i}"} for i in range(3001)])).status_code == 422


def test_attachments_are_not_stored():
    put(S(messages=[{"id": "M1", "text": "photo", "attachments": [{"name": "a", "type": "image/png", "url": "data:..."}]}]))
    assert "attachments" not in c.get("/api/state").json()["data"]["app"]["messages"][0]


def test_body_size_limit_content_length_and_chunked(monkeypatch):
    monkeypatch.setattr(config, "MAX_BODY_BYTES", 1000)
    big = '{"base":0,"app":{"pad":"' + "x" * 2000 + '"}}'
    assert c.put("/api/state", content=big, headers={"content-type": "application/json"}).status_code == 413

    def gen():
        for _ in range(10):
            yield b"x" * 300

    r = c.put("/api/state", content=gen(), headers={"content-type": "application/json"})
    assert r.status_code == 413
    assert put(S()).status_code == 200  # 上限内は通る


def test_removed_endpoints():
    for path in ("/api/ai/chat", "/api/ai/monthly-plan", "/api/ai/health-insight"):
        assert c.post(path, json={}).status_code in (404, 405)
    assert c.get("/api/analytics/stats").status_code == 404
    assert c.get("/api/seed/employees").status_code == 404


def test_auth_required_when_enabled(monkeypatch):
    monkeypatch.setattr(config, "REQUIRE_AUTH", True)
    assert c.get("/api/state").status_code == 401
    assert c.get("/api/state", headers={"Authorization": "Bearer bogus"}).status_code == 401
    assert c.get("/api/healthz").status_code == 200  # ヘルスのみ未認証


def test_docs_disabled():
    assert c.get("/api/docs").status_code in (404, 405) or c.get("/api/openapi.json").status_code == 404


def test_per_user_request_limit(monkeypatch):
    from fastapi import HTTPException

    monkeypatch.setattr(config, "REQ_PER_UID_PER_MIN", 2)
    guard._req_hits.clear()
    guard.consume_request("u1")
    guard.consume_request("u1")
    with pytest.raises(HTTPException):
        guard.consume_request("u1")
    guard.consume_request("u2")  # 別ユーザーは影響を受けない
