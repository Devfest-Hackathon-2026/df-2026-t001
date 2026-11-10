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


# ---------------------------------------------------------------- 欠員の状態・打診の検査・ルールの検証（修正の回帰テスト）

def _vac(client, day=12, shift="日勤"):
    sid = _working(client, shift=shift, day=day)
    j = client.post(f"{BASE}/vacancies", json={"date": f"2026-11-{day:02d}", "shift": shift, "absent_staff_id": sid}).json()
    return sid, j["vacancy"]["vacancy_id"], j


def test_offer_rejects_absent_working_and_accept_rechecks(client):
    absent, vid, j = _vac(client)
    assert client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": absent}).status_code == 409       # 欠勤した本人
    busy = _working(client, shift="早番", day=12)
    r = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": busy})
    assert r.status_code == 409 and "すでに" in r.json()["error"]                                            # 当日すでに勤務
    c = j["candidates"][0]["staff_id"]
    o = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": c}).json()
    # 打診のあとで、その人に同じ日の早番が入った → 受諾は 409 で、早番は上書きされない
    assert client.post(f"{BASE}/rosters/2026-11/edits", json={"staff_id": c, "day": 12, "to": "早番"}).status_code == 201
    r = client.post(f"{BASE}/vacancies/{vid}/offers/{o['offer_id']}/respond", json={"status": "accepted"})
    assert r.status_code == 409 and "早番" in r.json()["error"]
    assert client.get(f"{BASE}/rosters/2026-11").json()["current"][c][11] == "早番"
    assert server.svc().repo.vacancy(F, vid)["state"] == "offering"


def test_hard_rule_breaker_cannot_be_offered(client):
    _, vid, j = _vac(client)
    hard = [x for x in j["excluded"] if "破る" in x["reason"]]
    if not hard:
        pytest.skip("この日は絶対のルールで外れる人がいない")
    r = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": hard[0]["staff_id"]})
    assert r.status_code == 409 and "破る" in r.json()["error"]


def test_only_one_accept_wins_and_terminal_states(client):
    _, vid, j = _vac(client)
    a, b = j["candidates"][0]["staff_id"], j["candidates"][1]["staff_id"]
    oa = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": a}).json()
    ob = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": b}).json()
    assert oa["offer_id"] != ob["offer_id"]
    assert client.post(f"{BASE}/vacancies/{vid}/offers/{oa['offer_id']}/respond", json={"status": "accepted"}).status_code == 200
    assert client.post(f"{BASE}/vacancies/{vid}/offers/{ob['offer_id']}/respond", json={"status": "accepted"}).status_code == 409
    cur = client.get(f"{BASE}/rosters/2026-11").json()["current"]
    assert cur[a][11] == "日勤" and cur[b][11] == ""                                                        # 二重に埋まらない
    assert client.post(f"{BASE}/vacancies/{vid}/replan", json={"apply": True}).status_code == 409           # 充足済みは組み直さない
    # 断るのは受け付ける（打診が終わるだけ）
    assert client.post(f"{BASE}/vacancies/{vid}/offers/{ob['offer_id']}/respond", json={"status": "declined"}).status_code == 200


def test_replanned_vacancy_cannot_be_offered(client):
    _, vid, j = _vac(client)
    assert client.post(f"{BASE}/vacancies/{vid}/replan", json={"apply": True}).json()["applied"] is True
    assert client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": j["candidates"][0]["staff_id"]}).status_code == 409


def test_store_transition_is_compare_and_set(client):
    _, vid, _ = _vac(client)
    repo = server.svc().repo
    import threading

    wins = []
    ts = [threading.Thread(target=lambda i=i: wins.append(repo.transition_vacancy(F, vid, {"open", "offering"}, {"state": "filled", "filled_by": i})))
          for i in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sum(1 for w in wins if w is not None) == 1


def test_vacancy_ids_do_not_collide_and_no_orphan_absence(client, monkeypatch):
    s1 = _working(client, shift="日勤", day=12)
    v1 = client.post(f"{BASE}/vacancies", json={"date": "2026-11-12", "shift": "日勤", "absent_staff_id": s1}).json()["vacancy"]["vacancy_id"]
    s2 = _working(client, shift="日勤", day=12)
    v2 = client.post(f"{BASE}/vacancies", json={"date": "2026-11-12", "shift": "日勤", "absent_staff_id": s2}).json()["vacancy"]["vacancy_id"]
    assert v1 != v2 and v1.startswith("VAC-20261112-HID")
    # 欠勤の編集が失敗したら、欠員は取り消し（cancelled）・欠勤は残らない
    s3 = _working(client, shift="夜勤", day=14)
    repo = server.svc().repo

    def boom(*a, **k):
        from care.store import Conflict
        raise Conflict("x")

    monkeypatch.setattr(repo, "add_edit", boom)
    r = client.post(f"{BASE}/vacancies", json={"date": "2026-11-14", "shift": "夜勤", "absent_staff_id": s3})
    assert r.status_code == 409
    monkeypatch.undo()
    assert client.get(f"{BASE}/rosters/2026-11").json()["current"][s3][13] == "夜勤"
    assert [v["state"] for v in repo.vacancies(F, "2026-11") if v["absent_staff_id"] == s3] == ["cancelled"]
    assert client.post(f"{BASE}/vacancies", json={"date": "2026-11-14", "shift": "夜勤", "absent_staff_id": s3}).status_code == 201


def test_bad_dates_are_4xx_not_500(client):
    sid = _working(client, shift="日勤", day=12)
    assert client.post(f"{BASE}/vacancies", json={"date": "2026-02-30", "shift": "日勤", "absent_staff_id": sid}).status_code == 400
    assert client.get(f"{BASE}/daily/2026-11-ab").status_code == 400


def test_rule_values_are_validated_and_locked_rules_cannot_stop(client):
    absurd = {"id": "r-absurd", "type": "staffing", "label": "夜勤100万人", "strength": "絶対", "shifts": {"ids": ["夜勤"]}, "at_least": 10 ** 6}
    assert client.post(f"{BASE}/rules", json=absurd).status_code == 422
    too_many = {**absurd, "at_least": 15}           # 職員16人でも、夜勤に入れる人はそれより少ない
    assert client.post(f"{BASE}/rules", json=too_many).status_code == 422
    for bad in ({"id": "b1", "type": "count", "label": "b", "shifts": {}, "at_most": 999},
                {"id": "b2", "type": "succession", "label": "b", "max_run": 0},
                {"id": "b3", "type": "balance", "label": "b", "shifts": {}, "max_spread": -1},
                {"id": "b4", "type": "count", "label": "b", "shifts": {}, "at_least": 5, "at_most": 2}):
        assert client.post(f"{BASE}/rules", json=bad).status_code == 422, bad
    r = client.post(f"{BASE}/rules/r-ake/stop", json={"reason": "x"})
    assert r.status_code == 409 and "止められません" in r.json()["error"]
    assert "r-ake" in {x["id"] for x in client.get(f"{BASE}/rules").json()["rules"]}


def test_user_rule_cap(client, monkeypatch):
    from care import service

    monkeypatch.setattr(service, "MAX_USER_RULES", 2)
    mk = lambda i: {"id": f"u{i}", "type": "request", "label": "u", "strength": "できれば", "people": {"ids": ["HDM-001"]},  # noqa: E731
                    "days": {"dates": [i + 1]}, "shifts": {"ids": ["休"]}, "want": True}
    assert [client.post(f"{BASE}/rules", json=mk(i)).status_code for i in range(3)] == [201, 201, 409]


def test_task_request_rule_can_be_saved_and_is_used_by_daily(client):
    d0 = client.get(f"{BASE}/daily/2026-11-12").json()
    bathers = sorted({s["staff_id"] for s in d0["staff"] for i in s["items"] if i["task"] == "bath"})
    assert bathers
    who = bathers[0]
    rule = {"id": "r-task-1", "type": "taskRequest", "label": f"{who} は入浴介助に入れない", "strength": "絶対",
            "people": {"ids": [who]}, "task": "bath", "from_hour": 0, "to_hour": 24, "want": False}
    assert client.post(f"{BASE}/rules", json=rule).status_code == 201
    assert "r-task-1" in {x["id"] for x in client.get(f"{BASE}/rules").json()["daily_rules"]}
    d1 = client.get(f"{BASE}/daily/2026-11-12").json()
    assert not any(i["task"] == "bath" for s in d1["staff"] if s["staff_id"] == who for i in s["items"])
    bad = {**rule, "id": "r-task-2", "from_hour": 20, "to_hour": 10}
    assert client.post(f"{BASE}/rules", json=bad).status_code == 422


def test_new_solve_keeps_absences_and_fills(client):
    absent, vid, j = _vac(client)
    c = j["candidates"][0]["staff_id"]
    o = client.post(f"{BASE}/vacancies/{vid}/offers", json={"staff_id": c}).json()
    client.post(f"{BASE}/vacancies/{vid}/offers/{o['offer_id']}/respond", json={"status": "accepted"})
    absent2, vid2, j2 = _vac(client, day=20, shift="夜勤")       # まだ埋まっていない欠員
    o2 = client.post(f"{BASE}/vacancies/{vid2}/offers", json={"staff_id": j2["candidates"][0]["staff_id"]}).json()
    s = client.post(f"{BASE}/rosters/2026-11/solve", json={"time_limit": 10, "daily": False}).json()
    assert s["status"] in ("OPTIMAL", "FEASIBLE") and s["carried_edits"] >= 3
    cur = client.get(f"{BASE}/rosters/2026-11").json()["current"]
    assert cur[absent][11] == "" and cur[c][11] == "日勤" and cur[absent2][19] == ""                      # 新しい提案に引き継がれる
    assert server.svc().repo.vacancy(F, vid)["state"] == "filled"
    assert server.svc().repo.vacancy(F, vid2)["state"] == "replanned"                                     # 新しい提案で埋まった
    r = client.post(f"{BASE}/vacancies/{vid2}/offers/{o2['offer_id']}/respond", json={"status": "accepted"})
    assert r.status_code == 409                                                                           # 古い打診の受諾で人数が過剰にならない
