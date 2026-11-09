from fastapi.testclient import TestClient

from app import events, rules
from app.main import app

c = TestClient(app)


def test_health():
    assert c.get("/api/healthz").json()["ok"] is True


def test_state_patch_merge_and_version_and_304():
    c.post("/api/state/reset")
    r = c.put("/api/state", json={"patch": {"flow": {"vacancy": {"id": "VAC-1", "status": "登録"}}}})
    v1 = r.json()["version"]
    c.put("/api/state", json={"patch": {"flow": {"vacancy": {"status": "打診中"}}}})
    got = c.get("/api/state").json()
    assert got["data"]["flow"]["vacancy"] == {"id": "VAC-1", "status": "打診中"}  # deep merge
    assert got["version"] == v1 + 1
    assert c.get(f"/api/state?since={got['version']}").status_code == 304


def test_vacancy_status_event_emitted():
    c.post("/api/state/reset")
    c.put("/api/state", json={"patch": {"flow": {"vacancy": {"id": "VAC-2", "status": "登録"}}}})
    c.put("/api/state", json={"patch": {"flow": {"vacancy": {"status": "充足"}}}})
    types = [e["event_type"] for e in events.local_events()]
    assert types.count("vacancy_status_changed") == 2
    assert c.get("/api/analytics/stats").json()["events_total"] >= 2


def test_candidates_exclude_absent_and_non_night():
    cands = rules.rank_candidates(absent_emp_id="EMP-017")
    ids = [x["empId"] for x in cands]
    assert "EMP-017" not in ids
    assert cands[0]["score"] >= cands[-1]["score"]
    body = c.post("/api/ai/candidates", json={"absentEmpId": "EMP-017"}).json()
    assert body["source"] == "fallback" and body["fallbackReason"]  # AI未接続を隠さない
    assert "本人の承諾ではありません" in body["note"]


def test_monthly_plan_fallback_is_valid():
    body = c.post("/api/ai/monthly-plan", json={"year": 2026, "month": 11}).json()
    assert body["source"] == "fallback"
    assert body["problems"] == []
    assert len(body["plan"]) == 30


def test_validator_catches_violations():
    plan = rules.greedy_night_plan(2026, 11)
    plan["2026-11-02"] = plan["2026-11-01"]  # 連続夜勤
    assert any("連続夜勤" in p for p in rules.validate_night_plan(plan, 2026, 11))


def test_health_insight_never_treats_unsubmitted_as_healthy():
    body = c.post("/api/ai/health-insight", json={"checks": [{"status": "consult"}, {"status": "normal"}]}).json()
    assert body["counts"]["consult"] == 1 and body["unsubmittedIsNotHealthy"] is True
    assert "診断" in body["disclaimer"]


def test_chat_validation_and_fallback():
    assert c.post("/api/ai/chat", json={"message": ""}).status_code == 422
    assert c.post("/api/ai/chat", json={"message": "今夜の欠員は?"}).json()["source"] == "fallback"


def test_seed_ids_unique():
    ids = [e["id"] for e in rules.load_seed("employees")]
    assert len(ids) == len(set(ids))


def test_state_rejects_markup_and_proto_keys_and_unknown_top():
    assert c.put("/api/state", json={"patch": {"flow": {"memo": "<img src=x onerror=alert(1)>"}}}).status_code == 422
    assert c.put("/api/state", json={"patch": {"flow": {"__proto__": {"x": 1}}}}).status_code == 422
    assert c.put("/api/state", json={"patch": {"admin": {"x": 1}}}).status_code == 422
    assert c.put("/api/state", json={"patch": {"flow": {"memo": "x" * 400000}}}).status_code in (413, 422)


def test_auth_required_when_enabled(monkeypatch):
    from app import config

    monkeypatch.setattr(config, "REQUIRE_AUTH", True)
    assert c.get("/api/state").status_code == 401
    assert c.get("/api/state", headers={"Authorization": "Bearer bogus"}).status_code == 401
    assert c.get("/api/healthz").status_code == 200  # ヘルスのみ未認証


def test_ai_daily_and_per_user_limits(monkeypatch):
    from app import config, guard

    monkeypatch.setattr(config, "AI_PER_UID_PER_MIN", 2)
    guard._uid_hits.clear()
    assert c.post("/api/ai/health-insight", json={"checks": []}).status_code == 200
    assert c.post("/api/ai/health-insight", json={"checks": []}).status_code == 200
    assert c.post("/api/ai/health-insight", json={"checks": []}).status_code == 429
    guard._uid_hits.clear()
    monkeypatch.setattr(config, "AI_PER_UID_PER_MIN", 100)
    monkeypatch.setattr(config, "AI_DAILY_LIMIT", 1)
    guard._mem_daily.clear()
    assert c.post("/api/ai/health-insight", json={"checks": []}).status_code == 200
    assert c.post("/api/ai/health-insight", json={"checks": []}).status_code == 429


def test_docs_disabled():
    assert c.get("/api/docs").status_code in (404, 405) or c.get("/api/openapi.json").status_code == 404


def test_per_user_request_limit(monkeypatch):
    from app import config, guard

    monkeypatch.setattr(config, "REQ_PER_UID_PER_MIN", 2)
    guard._req_hits.clear()
    guard.consume_request("u1")
    guard.consume_request("u1")
    import pytest
    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        guard.consume_request("u1")
    guard.consume_request("u2")  # 別ユーザーは影響を受けない


def test_app_state_replace_and_markup_allowed_in_app_only():
    c.post("/api/state/reset")
    assert c.put("/api/state", json={"patch": {"app": {"v": 7, "messages": [{"text": "a < b > c"}], "x": {"keep": 1}}}}).status_code == 200
    assert c.put("/api/state", json={"patch": {"app": {"v": 7, "messages": []}}}).status_code == 200
    got = c.get("/api/state").json()["data"]["app"]
    assert got == {"v": 7, "messages": []}  # 丸ごと置換（削除されたキーも反映）
    assert c.put("/api/state", json={"patch": {"flow": {"m": "<b>"}}}).status_code == 422  # 旧UIは従来どおり拒否
    assert c.put("/api/state", json={"patch": {"app": {"__proto__": {}}}}).status_code == 422


def test_app_vacancy_events():
    events.clear_local()
    c.post("/api/state/reset")
    c.put("/api/state", json={"patch": {"app": {"vacancies": [{"id": "VAC-1", "state": "open"}]}}})
    c.put("/api/state", json={"patch": {"app": {"vacancies": [{"id": "VAC-1", "state": "filled"}]}}})
    ev = [e for e in events.local_events() if e["event_type"] == "vacancy_status_changed"]
    assert len(ev) == 1


def test_explain_candidates_and_plan_review_fallback():
    body = {"vacancy": {"date": "2026-11-25", "shift": "夜勤"}, "candidates": [{"id": "EMP-005", "name": "渡辺", "score": 90, "reasons": ["当日の勤務なし（空き）"]}]}
    r = c.post("/api/ai/explain-candidates", json=body).json()
    assert r["source"] == "fallback" and r["candidates"][0]["id"] == "EMP-005" and "承諾" in r["note"]
    assert c.post("/api/ai/explain-candidates", json={"vacancy": {"x": "y" * 20000}, "candidates": []}).status_code == 413
    assert c.post("/api/ai/plan-review", json={"plan": {"notes": ["夜勤が偏っています"]}}).json()["checks"] == ["夜勤が偏っています"]


def test_health_insight_new_ui_format():
    r = c.post("/api/ai/health-insight", json={"checks": [{"staffId": "E1", "temp": 37.4, "symptoms": ["咳"], "sleep": "十分", "consult": True}, {"staffId": "E2", "temp": 36.4, "symptoms": [], "sleep": "十分", "consult": False}]}).json()
    assert r["counts"]["consult"] == 1 and r["counts"]["normal"] == 1
