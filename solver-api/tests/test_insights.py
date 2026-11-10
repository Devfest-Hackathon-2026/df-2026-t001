"""分析タブ（care/insights.py）。BigQuery はフェイクで置き換える。"""
import pytest
from fastapi.testclient import TestClient

from care import guard, insights, server
from care.insights import SECTIONS, FakeSource, Insights, kpis

F = "fac-sakura"

DATA = {
    "vacancy_slots": [
        {"weekday_num": 2, "weekday_label": "月", "shift": "日勤", "vacancies": 6, "filled": 6, "avg_minutes_to_fill": 30.0},
        {"weekday_num": 7, "weekday_label": "土", "shift": "夜勤", "vacancies": 4, "filled": 3, "avg_minutes_to_fill": 130.0},
    ],
    "acceptance": [{"month": "2026-09", "employment": "常勤", "tenure_band": "1:3年未満", "offers": 10, "accepted": 4},
                   {"month": "2026-10", "employment": "パート", "tenure_band": "2:3〜9年", "offers": 10, "accepted": 6}],
    "model_runs": [{"run_at": "2026-11-01T00:00:00Z", "auc": 0.70, "promoted": True}, {"run_at": "2026-11-08T00:00:00Z", "auc": 0.77, "promoted": True}],
    "forecast": [{"week_start": "2026-10-25", "series": "実績", "vacancies": 6.0}] +
                [{"week_start": f"2026-11-{d:02d}", "series": "予測", "vacancies": 2.5, "lower_80": 1.0, "upper_80": 4.0} for d in (1, 8, 15, 22, 29)],
    "solver_runs": [{"wall_ms": 1000}, {"wall_ms": 3000}],
    "ai_usage": [{"feature": "chat", "calls": 3, "total_tokens": 900}, {"feature": "explain", "calls": 2, "total_tokens": 100}],
}


@pytest.fixture()
def client(monkeypatch):
    guard.reset()
    monkeypatch.setenv("INSIGHTS_ENABLED", "1")
    src = FakeSource(DATA)
    insights.set_insights(Insights(src, ttl=60))
    yield TestClient(server.app), src
    insights.set_insights(None)


def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("INSIGHTS_ENABLED", raising=False)
    c = TestClient(server.app)
    r = c.get(f"/api/v1/facilities/{F}/insights")
    assert r.status_code == 404 and "有効" in r.json()["error"]
    assert c.get(f"/api/v1/facilities/{F}/insights/forecast").status_code == 404


def test_overview_has_all_sections_and_kpis(client):
    c, src = client
    r = c.get(f"/api/v1/facilities/{F}/insights")
    assert r.status_code == 200
    j = r.json()
    assert j["available"] is True and set(j["sections"]) == set(SECTIONS)
    k = j["kpis"]
    assert k["vacancies"] == 10 and k["fill_rate"] == 0.9
    assert k["avg_minutes_to_fill"] == round((30 * 6 + 130 * 3) / 9, 1)
    assert k["peak_slot"] == {"weekday": "月", "shift": "日勤", "vacancies": 6}
    assert k["accept_rate"] == 0.5 and k["offers"] == 20
    assert k["model_auc"] == 0.77 and k["model_promoted"] is True
    assert k["forecast_next4w"] == 10.0                     # 予測の先頭 4 週だけ（実績は数えない）
    assert k["solver_avg_ms"] == 2000 and k["ai_calls_30d"] == 5 and k["ai_tokens_30d"] == 1000
    assert all(fid == F for name, fid in src.calls)


def test_cache_within_ttl(client):
    c, src = client
    c.get(f"/api/v1/facilities/{F}/insights")
    n = len(src.calls)
    j = c.get(f"/api/v1/facilities/{F}/insights").json()
    assert len(src.calls) == n and all(s["cached"] for s in j["sections"].values())
    # AI の利用は全体の集計なので、別の施設でもキャッシュを共有する
    c.get("/api/v1/facilities/fac-midori/insights")
    assert ("ai_usage", "fac-midori") not in src.calls and ("forecast", "fac-midori") in src.calls


def test_cache_expires():
    t = [0.0]
    src = FakeSource(DATA)
    i = Insights(src, ttl=10, clock=lambda: t[0])
    i.section(F, "forecast")
    i.section(F, "forecast")
    assert src.calls.count(("forecast", F)) == 1
    t[0] = 11
    i.section(F, "forecast")
    assert src.calls.count(("forecast", F)) == 2


def test_bigquery_failure_is_safe(client):
    _, _ = client
    src = FakeSource(DATA, fail={"forecast", "ai_usage"})
    insights.set_insights(Insights(src, ttl=60))
    c = TestClient(server.app)
    j = c.get(f"/api/v1/facilities/{F}/insights").json()
    assert j["available"] is True
    assert j["sections"]["forecast"] == {"title": SECTIONS["forecast"][0], "ok": False, "cached": False, "rows": []}
    assert j["kpis"]["forecast_next4w"] is None
    # 失敗はキャッシュしない
    c.get(f"/api/v1/facilities/{F}/insights")
    assert src.calls.count(("forecast", F)) == 2


def test_all_failing_returns_unavailable(client):
    insights.set_insights(Insights(FakeSource(fail=set(SECTIONS)), ttl=60))
    j = TestClient(server.app).get(f"/api/v1/facilities/{F}/insights").json()
    assert j["available"] is False and "準備中" in j["note"]
    assert all(v is None for v in j["kpis"].values())


def test_section_endpoint(client):
    c, _ = client
    j = c.get(f"/api/v1/facilities/{F}/insights/forecast").json()
    assert j["section"] == "forecast" and j["ok"] and len(j["rows"]) == 6
    assert c.get(f"/api/v1/facilities/{F}/insights/nope").status_code == 404
    assert c.get("/api/v1/facilities/bad%20id/insights").status_code == 404


def test_kpis_empty():
    assert all(v is None for v in kpis({}).values())


def test_sql_is_fixed_and_parameterized():
    for name, (_, sql, by_fac) in SECTIONS.items():
        assert "{p}" in sql and sql.lstrip().upper().startswith("SELECT")
        assert ("@f" in sql) == by_fac, name
