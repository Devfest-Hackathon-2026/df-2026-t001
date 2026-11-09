"""POST /api/v1/rank-candidates：画面の職員を、学習済みの応諾予測で並べる（状態なし・GCP なし）。"""
import json

import pytest
from fastapi.testclient import TestClient

from care import guard, inline_rank, server
from care.learn import scoring, train
from care.learn.store import MemoryModelStore
from care.service import Svc
from care.store import MemoryRepo


@pytest.fixture(scope="module")
def champ(synth):
    rows = [json.loads(line) for line in open(synth / "fact_offers.ndjson", encoding="utf-8")]
    a = train.train_facility("fac-sakura", [r for r in rows if r["facility_id"] == "fac-sakura"], version="t1")["artifact"]
    return scoring.load(json.dumps(a))


@pytest.fixture()
def client(synth, champ, monkeypatch):
    monkeypatch.delenv("MODEL_ROOT", raising=False)
    monkeypatch.delenv("RANK_PRIOR_FACILITY", raising=False)
    guard.reset()
    server.set_service(Svc(MemoryRepo.from_synth(synth), models=MemoryModelStore({"fac-sakura": champ})))
    yield TestClient(server.app)
    server.set_service(None)


def staff(i, **kw):
    return {"id": f"EMP-{i:03d}", "role": "介護職員", "employment": "常勤", "skills": ["night", "bath"], "shifts": ["早番", "日勤", "遅番", "夜勤"],
            "home_unit": "U1", "years": 5, **kw}


def body(**kw):
    b = {"date": "2026-11-20", "shift": "夜勤", "unit_id": "U1", "absent_staff_id": "EMP-001", "need_skills": ["night"],
         "discovered_at": "2026-11-10 14:00",
         "staff": [staff(1), staff(2), staff(3, home_unit="U2", employment="パート", years=1), staff(4, skills=["bath"]), staff(5),
                   staff(6, shifts=["日勤"]), staff(7, years=20)],
         "assignments": [{"staff_id": "EMP-001", "date": "2026-11-20", "shift": "夜勤", "status": "absent"},
                         {"staff_id": "EMP-005", "date": "2026-11-20", "shift": "日勤", "status": "assigned"},
                         *[{"staff_id": "EMP-002", "date": f"2026-11-{d}", "shift": "夜勤", "status": "assigned"} for d in (13, 15, 17)],
                         *[{"staff_id": "EMP-007", "date": f"2026-11-{d}", "shift": "日勤", "status": "assigned"} for d in (16, 17, 18, 19)]],
         "avail": [{"staff_id": "EMP-003", "date": "2026-11-20", "shifts": ["夜勤"]}]}
    b.update(kw)
    return b


def test_ranks_with_champion_and_excludes_clear_conflicts(client):
    r = client.post("/api/v1/rank-candidates", json=body())
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["model"] == "champion"
    ids = [c["staff_id"] for c in j["candidates"]]
    assert set(ids) == {"EMP-002", "EMP-003", "EMP-007"}
    ex = {e["staff_id"]: e["reason"] for e in j["excluded"]}
    assert ex == {"EMP-001": "欠勤した本人", "EMP-004": "必要な資格がない", "EMP-005": "当日は別の勤務あり", "EMP-006": "夜勤は不可"}
    ps = [c["accept_probability"] for c in j["candidates"]]
    assert all(isinstance(p, float) and 0 < p < 1 for p in ps)
    assert ps == sorted(ps, reverse=True)
    assert [c["rank_score"] for c in j["candidates"]] == sorted((c["rank_score"] for c in j["candidates"]), reverse=True)
    c3 = next(c for c in j["candidates"] if c["staff_id"] == "EMP-003")
    assert "入れる日に登録済み" in c3["reasons"] and c3["reasons"][0].startswith("応諾の見込み")
    assert "name" not in json.dumps(j)


def test_features_match_offer_time_definition():
    b = inline_rank.RankIn(**body())
    work = {"EMP-007": {f"2026-11-{d}": "日勤" for d in (16, 17, 18, 19)}, "EMP-002": {"2026-11-13": "夜勤", "2026-11-15": "夜勤"}}
    f7 = inline_rank.features(b, inline_rank.StaffIn(**staff(7, years=20)), work)
    assert f7["consec_before"] == 4 and f7["month_hours_before"] == 32.0 and f7["nights_last30"] == 0
    assert f7["weekday"] == 5 and f7["shift"] == "夜勤" and f7["same_unit"] and f7["skill_match"]
    assert f7["lead_hours"] == pytest.approx(24 * 10 + 2.5)                    # 11/10 14:00 JST → 11/20 16:30 JST
    assert f7["staff_id"].startswith("app:")                                  # 学習データの人ごとの統計と混ざらない
    f2 = inline_rank.features(b, inline_rank.StaffIn(**staff(2, month_hours_before=100, nights_last30=6, offers_last14=2)), work)
    assert f2["month_hours_before"] == 100 and f2["nights_last30"] == 6 and f2["offers_last14"] == 2 and f2["consec_before"] == 0
    assert inline_rank.features(inline_rank.RankIn(**body(discovered_at="2026-11-20T07:00:00Z")), inline_rank.StaffIn(**staff(2)), {})["lead_hours"] == 0.5


def test_unknown_facility_or_missing_model_returns_none_not_error(client, synth, monkeypatch):
    monkeypatch.setenv("RANK_PRIOR_FACILITY", "fac-nowhere")
    j = client.post("/api/v1/rank-candidates", json=body()).json()
    assert j["model"] == "none" and j["candidates"]
    assert all(c["accept_probability"] is None for c in j["candidates"])
    assert all(not r.startswith("応諾の見込み") for c in j["candidates"] for r in c["reasons"])
    server.set_service(Svc(MemoryRepo.from_synth(synth)))                     # モデル置き場なし
    assert client.post("/api/v1/rank-candidates", json=body()).json()["model"] == "none"


def test_no_service_and_no_model_root_still_answers(synth, monkeypatch):
    monkeypatch.delenv("MODEL_ROOT", raising=False)
    guard.reset()
    server.set_service(None)
    try:
        j = TestClient(server.app).post("/api/v1/rank-candidates", json=body()).json()
        assert j["model"] == "none" and len(j["candidates"]) == 3
    finally:
        server.set_service(None)


def test_broken_model_falls_back(client, synth, champ):
    bad = {**champ, "kind": "logistic", "intercept": None, "coef": None}
    server.set_service(Svc(MemoryRepo.from_synth(synth), models=MemoryModelStore({"fac-sakura": bad})))
    r = client.post("/api/v1/rank-candidates", json=body())
    assert r.status_code == 200
    j = r.json()
    assert j["model"] == "none" and len(j["candidates"]) == 3 and all(c["accept_probability"] is None for c in j["candidates"])


def test_model_store_raising_falls_back(client, synth):
    class Boom:
        def champion(self, fid):
            raise RuntimeError("gcs down")
    server.set_service(Svc(MemoryRepo.from_synth(synth), models=Boom()))
    j = client.post("/api/v1/rank-candidates", json=body()).json()
    assert j["model"] == "none" and len(j["candidates"]) == 3


@pytest.mark.parametrize("patch", [
    {"shift": "残業"}, {"date": "11/20"}, {"staff": [{"id": "山田 太郎"}]}, {"discovered_at": "yesterday"},
    {"staff": [staff(i) for i in range(121)]}, {"assignments": [{"staff_id": "EMP-001", "date": "2026-11-20", "shift": "休"}]},
])
def test_rejects_bad_shapes(client, patch):
    assert client.post("/api/v1/rank-candidates", json=body(**patch)).status_code == 422


def test_missing_staff_is_422_and_empty_staff_is_empty(client):
    b = body()
    del b["staff"]
    assert client.post("/api/v1/rank-candidates", json=b).status_code == 422
    j = client.post("/api/v1/rank-candidates", json=body(staff=[])).json()
    assert j["candidates"] == [] and j["excluded"] == []


def test_route_is_rate_limited_as_light_not_heavy():
    assert not guard.is_heavy("POST", "/api/v1/rank-candidates") and not guard.is_ai("POST", "/api/v1/rank-candidates")
