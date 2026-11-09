import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.service import Svc
from care.store import MemoryRepo

F = "fac-hidamari"
BASE = f"/api/v1/facilities/{F}"


@pytest.fixture()
def client(synth):
    guard.reset()
    server.set_service(Svc(MemoryRepo.from_synth(synth)))
    yield TestClient(server.app)
    server.set_service(None)


def _working(client, month="2026-11", shift="日勤", day=12):
    cur = client.get(f"{BASE}/rosters/{month}").json()["current"]
    return next(sid for sid, row in cur.items() if row[day - 1] == shift)


def test_health_and_read_endpoints(client):
    assert client.get("/api/healthz").json()["ok"] is True
    fs = client.get("/api/v1/facilities").json()["facilities"]
    assert {f["id"] for f in fs} == {"fac-sakura", "fac-midori", "fac-hidamari"}
    f = client.get(BASE).json()
    assert f["name"] == "ひだまりの家" and len(f["staff"]) == 16 and f["templates"]
    assert client.get("/api/v1/facilities/nope").status_code == 404
    r = client.get(f"{BASE}/rosters/2026-11").json()
    assert r["days"] == 30 and r["proposal_id"] is None and len(r["current"]) == 16


def test_solve_creates_immutable_proposals_and_verifies(client):
    a = client.post(f"{BASE}/rosters/2026-11/solve", json={"time_limit": 10}).json()
    assert a["status"] == "OPTIMAL" and a["unmet_total"] == 0 and a["proposal_id"].startswith("P-2026-11-")
    assert a["explanation"] == ["すべてのルールを満たす勤務表を作れました。"]
    b = client.post(f"{BASE}/rosters/2026-11/solve", json={"time_limit": 10, "daily": False}).json()
    assert b["proposal_id"] != a["proposal_id"]                           # 上書きではなく新しい提案
    r = client.get(f"{BASE}/rosters/2026-11").json()
    assert r["proposal_id"] == b["proposal_id"]
    v = client.get(f"{BASE}/rosters/2026-11/verify").json()
    assert v["ok"] is True and v["broken"] == []


def test_no_overwrite_endpoints_exist(client):
    for m in ("put", "patch", "delete"):
        assert getattr(client, m)(f"{BASE}/rosters/2026-11").status_code == 405
        assert getattr(client, m)(f"{BASE}/rosters/2026-11/edits").status_code == 405


def test_edits_are_appended_and_checked(client):
    sid = _working(client, shift="夜勤")
    e = client.post(f"{BASE}/rosters/2026-11/edits", json={"staff_id": sid, "day": 12, "to": "休", "reason": "本人の希望"})
    assert e.status_code == 201
    body = e.json()
    assert body["edit"]["from_shift"] == "夜勤" and body["edit"]["to_shift"] == ""
    assert body["after"]["ok"] is False                                   # 夜勤の人数が足りなくなる → 破れを即返す
    assert any(b["rule_id"] == "r-staff-夜勤" for b in body["after"]["broken"])
    assert client.get(f"{BASE}/rosters/2026-11").json()["current"][sid][11] == ""
    assert client.get(f"{BASE}/rosters/2026-11").json()["base"][sid][11] == "夜勤"      # 提案は不変
    again = client.post(f"{BASE}/rosters/2026-11/edits", json={"staff_id": sid, "day": 12, "to": "休"})
    assert again.status_code == 409                                       # 変更なし
    assert client.post(f"{BASE}/rosters/2026-11/edits", json={"staff_id": sid, "day": 12, "to": "徹夜"}).status_code == 422
    assert client.post(f"{BASE}/rosters/2026-11/edits", json={"staff_id": "X", "day": 12, "to": "日勤"}).status_code == 404


def test_daily_schedule(client):
    d = client.get(f"{BASE}/daily/2026-11-12").json()
    assert d["status"] == "OPTIMAL" and d["unmet"] == []
    assert d["staff"] and all(s["items"] is not None for s in d["staff"])
    assert any(i["kind"] == "break" for s in d["staff"] for i in s["items"])
    assert client.get(f"{BASE}/daily/2026-11-31").status_code == 400


def test_vacancy_flow_offer_accept_and_events(client):
    sid = _working(client, shift="日勤", day=12)
    v = client.post(f"{BASE}/vacancies", json={"date": "2026-11-12", "shift": "日勤", "absent_staff_id": sid, "reason": "体調不良"})
    assert v.status_code == 201
    j = v.json()
    vid = j["vacancy"]["vacancy_id"]
    assert vid.startswith("VAC-20261112-HID") and j["vacancy"]["state"] == "open"
    cands = j["candidates"]
    assert cands and all(c["reasons"] for c in cands) and cands == sorted(cands, key=lambda c: -c["score"])
    assert client.get(f"{BASE}/rosters/2026-11").json()["current"][sid][11] == ""     # 欠勤はセルに反映
    # 1人目は辞退、2人目が受諾
    o1 = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": cands[0]["staff_id"]}).json()
    assert client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": cands[0]["staff_id"]}).status_code == 409
    client.post(f"{BASE}/vacancies/{vid}/offers/{o1['offer_id']}/respond", json={"status": "declined"})
    o2 = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": cands[1]["staff_id"]}).json()
    r = client.post(f"{BASE}/vacancies/{vid}/offers/{o2['offer_id']}/respond", json={"status": "accepted"}).json()
    assert r["vacancy"]["state"] == "filled" and r["vacancy"]["filled_by"] == cands[1]["staff_id"]
    assert client.get(f"{BASE}/rosters/2026-11").json()["current"][cands[1]["staff_id"]][11] == "日勤"
    # すでに充足 → 二重受諾は不可
    o3 = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": cands[2]["staff_id"]})
    assert o3.status_code == 409
    assert client.post(f"{BASE}/vacancies/{vid}/offers/{o2['offer_id']}/respond", json={"status": "accepted"}).status_code == 409
    hard = [b for b in client.get(f"{BASE}/rosters/2026-11/verify").json()["broken"] if b["strength"] == "絶対"]
    assert hard == []                                                                   # 絶対のルールは破らずに埋まっている
    types = [e["event_type"] for e in server.svc().events.local]
    for t in ("vacancy_created", "offer_sent", "offer_responded", "vacancy_filled", "roster_edit"):
        assert t in types


def test_vacancy_validation(client):
    sid = _working(client, shift="日勤", day=12)
    bad = client.post(f"{BASE}/vacancies", json={"date": "2026-11-12", "shift": "夜勤", "absent_staff_id": sid})
    assert bad.status_code == 409                                                       # その日その勤務に入っていない
    assert client.post(f"{BASE}/vacancies", json={"date": "2026/11/12", "shift": "日勤", "absent_staff_id": sid}).status_code == 422


def test_replan_is_minimal_and_applies_only_on_request(client):
    # 実際の流れ: 先に solve して最適な表がある → 欠員が出る → 最小変更で組み直す
    assert client.post(f"{BASE}/rosters/2026-11/solve", json={"time_limit": 10, "daily": False}).json()["status"] == "OPTIMAL"
    sid = _working(client, shift="日勤", day=12)
    vid = client.post(f"{BASE}/vacancies", json={"date": "2026-11-12", "shift": "日勤", "absent_staff_id": sid}).json()["vacancy"]["vacancy_id"]
    before = client.get(f"{BASE}/rosters/2026-11").json()["current"]
    p = client.post(f"{BASE}/vacancies/{vid}/replan", json={"apply": False}).json()
    assert p["status"] == "OPTIMAL" and p["applied"] is False and 1 <= p["changed_cells"] <= 15
    assert all(c["day"] >= 12 for c in p["changes"])                                    # 欠員より前は動かさない
    assert client.get(f"{BASE}/rosters/2026-11").json()["current"] == before            # 適用していない
    a = client.post(f"{BASE}/vacancies/{vid}/replan", json={"apply": True}).json()
    assert a["applied"] is True
    after = client.get(f"{BASE}/rosters/2026-11").json()["current"]
    assert after != before
    assert [b for b in client.get(f"{BASE}/rosters/2026-11/verify").json()["broken"] if b["strength"] == "絶対"] == []


def test_rules_add_stop_and_effect_on_solve(client):
    r = client.get(f"{BASE}/rules").json()
    assert {x["id"] for x in r["rules"]} >= {"r-run", "r-ake", "r-night-cap"}
    assert client.post(f"{BASE}/rules", json={"id": "x", "type": "staffing", "label": "x", "shifts": {}}).status_code == 422
    new = {"id": "r-learned-1", "type": "request", "label": "HDM-007 は水曜の遅番に入らない", "strength": "強く",
           "origin": {"kind": "反復検出", "evidence": "過去3か月、毎回外している"}, "people": {"ids": ["HDM-007"]},
           "days": {"weekdays": [3]}, "shifts": {"ids": ["遅番"]}, "want": False}
    assert client.post(f"{BASE}/rules", json=new).status_code == 201
    assert client.post(f"{BASE}/rules", json=new).status_code == 409
    s = client.post(f"{BASE}/rosters/2026-11/solve", json={"time_limit": 10, "daily": False}).json()
    cells = client.get(f"{BASE}/rosters/2026-11").json()["current"]["HDM-007"]
    wed = [i for i in range(30) if (0 + i) % 7 == 3]          # 11/1 は日曜
    assert s["status"] == "OPTIMAL" and all(cells[i] != "遅番" for i in wed)
    assert client.post(f"{BASE}/rules/r-learned-1/stop", json={"reason": "不要になった"}).json()["stopped"] is True
    ids = {x["id"] for x in client.get(f"{BASE}/rules").json()["rules"]}
    assert "r-learned-1" not in ids
    assert client.post(f"{BASE}/rules/nope/stop", json={"reason": "x"}).status_code == 404


def test_infeasible_is_explained_and_not_saved(client):
    for sid in ["HDM-%03d" % i for i in range(1, 17)]:
        client.post(f"{BASE}/rules", json={"id": f"off-{sid}", "type": "request", "label": f"{sid} は全日休み", "strength": "絶対",
                                           "people": {"ids": [sid]}, "days": {}, "shifts": {"ids": ["休"]}, "want": True})
    s = client.post(f"{BASE}/rosters/2026-11/solve", json={"time_limit": 5, "daily": False}).json()
    assert s["status"] == "INFEASIBLE" and s["relaxation"] and "proposal_id" not in s
    assert client.get(f"{BASE}/rosters/2026-11").json()["proposal_id"] is None


# ---------------------------------------------------------------- 乱用対策

def test_rate_limit_heavy_calls(client, monkeypatch):
    monkeypatch.setattr(guard, "HEAVY_LIMIT", 2)
    codes = [client.get(f"{BASE}/daily/2026-11-12").status_code for _ in range(4)]
    assert codes[:2] == [200, 200] and codes[2:] == [429, 429]
    r = client.get(f"{BASE}/daily/2026-11-12")
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1
    assert client.get("/api/healthz").status_code == 200                 # ヘルスチェックは制限しない
    assert client.get(BASE).status_code == 200                           # 軽い呼び出しは別枠


def test_xff_last_hop_is_used(client, monkeypatch):
    monkeypatch.setattr(guard, "HEAVY_LIMIT", 1)
    h1, h2 = {"x-forwarded-for": "9.9.9.9, 1.1.1.1"}, {"x-forwarded-for": "8.8.8.8, 1.1.1.1"}
    assert client.get(f"{BASE}/daily/2026-11-12", headers=h1).status_code == 200
    assert client.get(f"{BASE}/daily/2026-11-12", headers=h2).status_code == 429     # 先頭を偽装しても同じ末尾なら同一扱い


def test_body_size_limit(client):
    big = {"id": "r-big", "label": "x" * 70000}
    assert client.post(f"{BASE}/rules", json=big).status_code == 413


def test_concurrency_cap_returns_503(client, monkeypatch):
    monkeypatch.setattr(guard, "QUEUE_WAIT", 0.2)
    for _ in range(guard.CONCURRENCY):
        guard.slots.acquire()
    try:
        assert client.get(f"{BASE}/daily/2026-11-12").status_code == 503
    finally:
        for _ in range(guard.CONCURRENCY):
            guard.slots.release()
    assert client.get(f"{BASE}/daily/2026-11-12").status_code == 200


def test_cors_allows_only_our_sites(client):
    ok = ["https://care.yutok.dev", "https://gdgoc-514203.web.app", "https://gdgoc-514203--pr-10-abc123.web.app", "http://localhost:5173"]
    for origin in ok:
        r = client.options(f"{BASE}/rosters/2026-11/solve", headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        assert r.status_code == 200 and r.headers["access-control-allow-origin"] == origin, origin
    for origin in ["https://evil.example.com", "https://gdgoc-514203.web.app.evil.com", "https://other--x.web.app"]:
        r = client.options(f"{BASE}/rosters/2026-11/solve", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
        assert "access-control-allow-origin" not in r.headers, origin
    g = client.get(BASE, headers={"Origin": "https://care.yutok.dev"})
    assert g.headers["access-control-allow-origin"] == "https://care.yutok.dev"
    assert "retry-after" in g.headers.get("access-control-expose-headers", "").lower()


def test_cors_headers_are_present_even_on_429_and_413(client, monkeypatch):
    monkeypatch.setattr(guard, "HEAVY_LIMIT", 1)
    h = {"Origin": "https://care.yutok.dev"}
    assert client.get(f"{BASE}/daily/2026-11-12", headers=h).status_code == 200
    r = client.get(f"{BASE}/daily/2026-11-12", headers=h)
    assert r.status_code == 429 and r.headers["access-control-allow-origin"] == "https://care.yutok.dev" and "retry-after" in r.headers
    big = client.post(f"{BASE}/rules", json={"id": "x", "label": "x" * 70000}, headers=h)
    assert big.status_code == 413 and big.headers["access-control-allow-origin"] == "https://care.yutok.dev"
