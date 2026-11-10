"""POST /api/v1/rank-candidates の cells 指定: 候補が引き受けるとソルバーの絶対ルールを破るなら除外する（inline_verify）。"""
import time

import pytest
from fastapi.testclient import TestClient

from care import guard, inline_rank, inline_verify, server

N = 30   # 2026-11


def staff(i, **kw):
    return {"id": f"EMP-{i:03d}", "role": "介護職員", "employment": "常勤", "skills": ["night"], "shifts": ["早番", "日勤", "遅番", "夜勤"],
            "home_unit": "U1", "years": 5, **kw}


def row(**days):
    r = [""] * N
    for d, k in days.items():
        r[int(d[1:]) - 1] = k
    return r


def at(ds, k):
    return {f"d{d}": k for d in ds}


def cells():
    return {
        "EMP-002": row(d19="夜勤"),                                                     # 前日が夜勤 → 夜勤明け
        "EMP-003": row(d3="日勤", d10="早番"),                                          # 問題なし
        "EMP-005": row(**at(range(15, 20), "日勤")),                                    # 15〜19 の5連勤 → 6連勤になる
        "EMP-006": row(**at([d for d in range(1, 31) if d not in (4, 8, 12, 15, 19, 20, 21, 25)], "日勤")),   # 公休ちょうど8日
        "EMP-007": row(**at(range(1, 7), "日勤")),                                      # 月初に6連勤（もとから破れ）。20日とは無関係
        "EMP-008": row(**at(range(1, 16, 2), "夜勤")),                                  # 夜勤8回（上限）
    }


def body(**kw):
    b = {"date": "2026-11-20", "shift": "夜勤", "unit_id": "U1", "absent_staff_id": "EMP-001", "need_skills": ["night"],
         "discovered_at": "2026-11-10 14:00",
         "staff": [staff(1), staff(2), staff(3), staff(5), staff(6), staff(7), staff(8, employment="パート")],
         "assignments": [{"staff_id": "EMP-001", "date": "2026-11-20", "shift": "夜勤", "status": "absent"}],
         "cells": cells(), "month_days": N, "first_weekday": 0}
    b.update(kw)
    return b


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.delenv("MODEL_ROOT", raising=False)
    guard.reset()
    server.set_service(None)
    yield TestClient(server.app)
    server.set_service(None)


def test_excludes_candidates_that_break_hard_rules_with_rule_label(client):
    r = client.post("/api/v1/rank-candidates", json=body())
    assert r.status_code == 200, r.text
    j = r.json()
    assert {c["staff_id"] for c in j["candidates"]} == {"EMP-003", "EMP-007"}
    ex = {e["staff_id"]: e for e in j["excluded"]}
    assert ex["EMP-001"] == {"staff_id": "EMP-001", "reason": "欠勤した本人"}                  # 従来の除外はそのまま（rule_id なし）
    assert ex["EMP-002"]["rule_id"] == "r-ake" and ex["EMP-002"]["reason"].startswith("夜勤のあとは翌日を休みにする")
    assert ex["EMP-005"]["rule_id"] == "r-run" and "夜勤明けも勤務日に数える" in ex["EMP-005"]["reason"]
    assert ex["EMP-006"]["rule_id"] == "app-min-off" and "公休は月8日以上" in ex["EMP-006"]["reason"]
    assert ex["EMP-008"]["rule_id"] == "r-night-cap" and ex["EMP-008"]["reason"].startswith("夜勤は月8回まで")


def test_without_cells_behaviour_is_unchanged(client):
    b = body()
    for k in ("cells", "month_days", "first_weekday"):
        del b[k]
    j = client.post("/api/v1/rank-candidates", json=b).json()
    assert {c["staff_id"] for c in j["candidates"]} == {"EMP-002", "EMP-003", "EMP-005", "EMP-006", "EMP-007", "EMP-008"}
    assert j["excluded"] == [{"staff_id": "EMP-001", "reason": "欠勤した本人"}]


def test_ake_counts_in_run_like_the_app():
    # 15日勤・16夜勤・17明け・18〜19日勤 + 20 → 明けを数えると6連勤（明けを数えなければ3連勤）
    c = {"EMP-002": row(d15="日勤", d16="夜勤", d18="日勤", d19="日勤")}
    j = inline_rank.rank(inline_rank.RankIn(**body(shift="日勤", staff=[staff(2)], cells=c)), None)
    assert j["excluded"] and j["excluded"][0]["rule_id"] == "r-run"


def test_interval_and_carry_in():
    c = {"EMP-002": row(d20="遅番")}
    j = inline_rank.rank(inline_rank.RankIn(**body(date="2026-11-21", shift="早番", staff=[staff(2)], cells=c)), None)
    assert j["excluded"][0]["rule_id"] == "r-interval" and j["excluded"][0]["reason"].startswith("遅番のあとに早番を置かない")
    j = inline_rank.rank(inline_rank.RankIn(**body(date="2026-11-01", shift="日勤", staff=[staff(2)], cells={}, carry_in={"EMP-002": "夜勤"})), None)
    assert j["excluded"][0]["rule_id"] == "carry-in"
    j = inline_rank.rank(inline_rank.RankIn(**body(date="2026-11-02", shift="日勤", staff=[staff(2)], cells={}, carry_in={"EMP-002": "夜勤"})), None)
    assert j["candidates"] and not j["excluded"]


@pytest.mark.parametrize("patch", [
    {"cells": {"EMP-002": [""] * 29}},                       # 日数が合わない
    {"cells": {"EMP-002": ["残業"] + [""] * 29}},            # 勤務区分が不正
    {"cells": {"EMP-002": "夜勤"}},                          # 形が違う
    {"cells": [["夜勤"]]},
    {"month_days": 40},
])
def test_malformed_cells_are_422(client, patch):
    assert client.post("/api/v1/rank-candidates", json=body(**patch)).status_code == 422


def test_calendar_mismatch_or_unknown_staff_is_ignored_safely(client):
    j = client.post("/api/v1/rank-candidates", json=body(first_weekday=3)).json()     # 2026-11-01 は日曜（0）
    assert len(j["candidates"]) == 6
    j = client.post("/api/v1/rank-candidates", json=body(cells={"EMP-999": [""] * N, "EMP-003": ["休"] * N})).json()
    assert len(j["candidates"]) == 6                                                  # 送られていない人は全休として扱う


def test_fast_enough_for_34_staff():
    cs = [inline_rank.StaffIn(**staff(i)) for i in range(1, 35)]
    c = {s.id: row(**at(range(1 + i % 3, 31, 3), "日勤")) for i, s in enumerate(cs)}
    t0 = time.perf_counter()
    kept, out = inline_verify.exclude_hard("2026-11-20", "夜勤", cs, c, month_days=N, first_weekday=0)
    assert time.perf_counter() - t0 < 0.3
    assert len(kept) + len(out) == 34
