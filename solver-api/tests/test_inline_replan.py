"""POST /api/v1/replan-inline: 欠員の日だけを、変わる勤務を最小にして組み直す（ほかの日は固定・保存しない）。"""
import itertools
import json
from collections import Counter
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from care import guard, server

STAFF = json.loads((Path(__file__).parent / "fixtures" / "app_staff.json").read_text())
SHIFTS = ("早番", "日勤", "遅番", "夜勤")
URL = "/api/v1/replan-inline"
N = 30   # 2026-11


@pytest.fixture()
def client():
    guard.reset()
    server.set_service(None)
    yield TestClient(server.app)
    guard.reset()


def _st(sid, shifts, employment="常勤", **kw):
    return {"staff_id": sid, "shifts": shifts, "employment": employment, **kw}


def _row(day_vals: dict[int, str], default=""):
    return [day_vals.get(d, default) for d in range(1, N + 1)]


def _small(cells, staff, d, shift="遅番", absent="L1", **kw):
    b = {"month": "2026-11", "staff": staff, "need_per_shift": {"日勤": 1, "遅番": 1}, "cells": cells, "date": d,
         "vacancy": {"shift": shift, "absent_staff_id": absent}, "fixed_other_days": True, "time_limit": 5}
    b.update(kw)
    return b


def _apply(cells, changes, d):
    out = {k: list(v) for k, v in cells.items()}
    for c in changes:
        assert out[c["staff_id"]][d - 1] == c["from"]
        out[c["staff_id"]][d - 1] = c["to"]
    return out


def _labor_ok(row, carry=""):
    """画面の数え方（夜勤明けも勤務日）で、6日の窓に5日まで・夜勤明け・遅番→早番"""
    cov = [(1 if k else 0) + (1 if (row[i - 1] if i else carry) == "夜勤" else 0) for i, k in enumerate(row)]
    for i, k in enumerate(row[:-1]):
        if k == "夜勤" and row[i + 1]:
            return False
        if k == "遅番" and row[i + 1] == "早番":
            return False
    return all(sum(cov[i:i + 6]) <= 5 for i in range(len(row) - 5))


# ------------------------------------------------------------------ 画面の34名（solve-inline で作った表）

@pytest.fixture(scope="module")
def app_roster():
    guard.reset()
    server.set_service(None)
    c = TestClient(server.app)
    body = {"month": "2026-11", "staff": STAFF, "need_per_shift": {k: 4 for k in SHIFTS}, "time_limit": 12}
    r = c.post("/api/v1/solve-inline", json=body)
    assert r.status_code == 200 and r.json()["status"] in ("OPTIMAL", "FEASIBLE")
    guard.reset()
    return body, r.json()["cells"]


@pytest.mark.parametrize("day,shift", [(22, "遅番"), (20, "夜勤"), (1, "早番"), (30, "日勤")])
def test_app_staff_only_vacancy_day_changes_and_minimal(client, app_roster, day, shift):
    body, cells = app_roster
    absent = next(s for s, row in cells.items() if row[day - 1] == shift)
    r = client.post(URL, json={**body, "cells": cells, "date": day, "vacancy": {"shift": shift, "absent_staff_id": absent}, "time_limit": 5})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] == "OPTIMAL" and j["minimal"] is True and j["wall_ms"] < 5000
    # ふつうは休みの人が1人入る1件。欠けた人が医療的ケアの夜勤などで、入れ替えが要るときも数件まで。ほかの日は1つも変わらない
    assert 1 <= j["changed_cells"] == len(j["changes"]) <= 3 and len(j["filled_by"]) == 1
    allowed = {s["staff_id"]: set(s["shifts"]) for s in STAFF}
    assert absent not in {c["staff_id"] for c in j["changes"]}
    for c in j["changes"]:
        assert c["to"] == "" or c["to"] in allowed[c["staff_id"]]
    if j["changed_cells"] == 1:
        assert j["changes"][0]["from"] == "" and j["changes"][0]["to"] == shift
    base = {k: list(v) for k, v in cells.items()}
    base[absent][day - 1] = ""
    after = _apply(base, j["changes"], day)
    assert all(after[s][i] == cells[s][i] for s in cells for i in range(N) if i != day - 1)
    assert Counter(row[day - 1] for row in after.values())[shift] == Counter(row[day - 1] for row in cells.values())[shift]
    for c in j["changes"]:
        assert _labor_ok(after[c["staff_id"]]) and after[c["staff_id"]].count("夜勤") <= 8
    assert j["explanation"] and f"{j['changed_cells']}件" in j["explanation"][0]    # 入れ替えが要る表（解は実行ごとに変わりうる）では2件以上


# ------------------------------------------------------------------ 小さな施設で、最小・硬制約・解けないとき

def test_minimal_two_changes_when_nobody_free_can_take_the_shift(client):
    # 遅番に入れるのは L1（欠勤）と A（日勤中）だけ。B は休みで日勤だけ入れる → A:日勤→遅番, B:休→日勤 の2件が最小
    staff = [_st("L1", ["遅番"]), _st("A", ["日勤", "遅番"]), _st("B", ["日勤"])]
    cells = {"L1": _row({}, "遅番"), "A": _row({}, "日勤"), "B": _row({})}
    j = client.post(URL, json=_small(cells, staff, 10)).json()
    assert j["status"] == "OPTIMAL" and j["changed_cells"] == 2
    assert sorted((c["staff_id"], c["from"], c["to"]) for c in j["changes"]) == [("A", "日勤", "遅番"), ("B", "", "日勤")]
    assert j["filled_by"] == ["A"]


def test_one_change_preferred_and_brute_force_minimal(client):
    staff = [_st("L1", ["遅番"]), _st("A", ["日勤", "遅番"]), _st("B", ["日勤"]), _st("C", ["遅番", "日勤"], "パート")]
    cells = {"L1": _row({d: "遅番" for d in range(1, N + 1) if d % 2}), "A": _row({d: "日勤" for d in range(1, N + 1) if d % 2}),
             "B": _row({}), "C": _row({})}
    j = client.post(URL, json=_small(cells, staff, 11)).json()
    assert j["status"] == "OPTIMAL" and j["changes"] == [{"staff_id": "C", "from": "", "to": "遅番"}]
    # 総当たりで「1件より少ない（0件）では埋まらない」ことと、1件の解が C だけであることを確かめる
    opts = {s["staff_id"]: ["", *s["shifts"]] for s in staff if s["staff_id"] != "L1"}
    best = None
    for combo in itertools.product(*opts.values()):
        day = dict(zip(opts, combo))
        if Counter(day.values())["遅番"] < 1 or Counter(day.values())["日勤"] < 1:
            continue
        n = sum(day[s] != cells[s][10] for s in opts)
        best = n if best is None else min(best, n)
    assert best == j["changed_cells"] == 1


def test_day_off_request_outweighs_one_extra_change(client):
    # C は11日に希望休 → C を呼ぶ1件より、A と B を動かす2件を選ぶ
    staff = [_st("L1", ["遅番"]), _st("A", ["日勤", "遅番"]), _st("B", ["日勤"]), _st("C", ["遅番"], "パート")]
    cells = {"L1": _row({11: "遅番"}), "A": _row({11: "日勤"}), "B": _row({}), "C": _row({})}
    j = client.post(URL, json=_small(cells, staff, 11, day_off={"C": [11]})).json()
    assert j["status"] == "OPTIMAL" and j["changed_cells"] == 2 and "C" not in j["filled_by"]


def test_hard_rules_respected_ake_interval_run_unavailable(client):
    # 遅番に入れる休みの人は4人いるが、どれも硬制約で入れない。E だけが入れる
    staff = [_st("L1", ["遅番"]), _st("A", ["日勤"]),
             _st("N1", ["夜勤", "遅番"]),          # 前日が夜勤 → 明け
             _st("X1", ["遅番", "早番"]),          # 翌日が早番 → 遅番→早番になる
             _st("R1", ["遅番", "日勤"]),          # 前5日連続勤務 → 6連勤になる
             _st("U1", ["遅番"]),                  # 入れない日
             _st("E", ["遅番"], "パート")]
    d = 15
    cells = {"L1": _row({d: "遅番"}), "A": _row({d: "日勤"}), "N1": _row({d - 1: "夜勤"}), "X1": _row({d + 1: "早番"}),
             "R1": _row({i: "日勤" for i in range(d - 5, d)}), "U1": _row({}), "E": _row({})}
    j = client.post(URL, json=_small(cells, staff, d, unavailable={"U1": [d]}, need_per_shift={"日勤": 1, "遅番": 1, "夜勤": 0})).json()
    assert j["status"] == "OPTIMAL" and j["changes"] == [{"staff_id": "E", "from": "", "to": "遅番"}]
    # E もいなければ解けない → 状態と破れ量（500 ではない）
    staff2 = [s for s in staff if s["staff_id"] != "E"]
    cells2 = {k: v for k, v in cells.items() if k != "E"}
    r = client.post(URL, json=_small(cells2, staff2, d, unavailable={"U1": [d]}, need_per_shift={"日勤": 1, "遅番": 1, "夜勤": 0}))
    assert r.status_code == 200
    j2 = r.json()
    assert j2["status"] == "INFEASIBLE" and j2["changes"] == [] and j2["filled_by"] == []
    assert len(j2["relaxation"]) == 1 and j2["relaxation"][0]["count"] == 1
    assert j2["relaxation"][0]["rule_id"] in ("r-ake", "r-interval", "r-run", "na-U1")
    assert "埋まりません" in j2["explanation"][0]


def test_absent_staff_is_not_put_back_and_carry_in(client):
    staff = [_st("L1", ["遅番"]), _st("A", ["日勤"]), _st("P", ["遅番", "早番"])]
    cells = {"L1": _row({1: "遅番"}), "A": _row({1: "日勤"}), "P": _row({})}
    j = client.post(URL, json=_small(cells, staff, 1, carry_in={"P": "夜勤"})).json()     # P は前月末が夜勤 → 1日は明け
    assert j["status"] == "INFEASIBLE"
    j = client.post(URL, json=_small(cells, staff, 1)).json()
    assert j["changes"] == [{"staff_id": "P", "from": "", "to": "遅番"}]


def test_old_violations_on_fixed_days_do_not_block(client):
    # A は今の表で毎日働いていて（連勤の上限を超えている）、欠員の日も働く。B が入れば足りる。A の古い破れで解けなくならない
    staff = [_st("L1", ["遅番"]), _st("A", ["日勤"]), _st("B", ["遅番"])]
    cells = {"L1": _row({}, "遅番"), "A": _row({}, "日勤"), "B": _row({})}
    j = client.post(URL, json=_small(cells, staff, 20)).json()
    assert j["status"] == "OPTIMAL" and j["changes"] == [{"staff_id": "B", "from": "", "to": "遅番"}]


# ------------------------------------------------------------------ 入力の検査・レート制限

def _ok_small():
    staff = [_st("L1", ["遅番"]), _st("A", ["日勤"]), _st("B", ["遅番"])]
    cells = {"L1": _row({5: "遅番"}), "A": _row({5: "日勤"}), "B": _row({})}
    return _small(cells, staff, 5)


@pytest.mark.parametrize("patch,code", [
    ({"date": 31}, 400),                                                  # 11月は30日まで
    ({"vacancy": {"shift": "遅番", "absent_staff_id": "NOPE"}}, 400),
    ({"vacancy": {"shift": "残業"}}, 422),
    ({"fixed_other_days": False}, 422),
    ({"date": 0}, 422),
    ({"month": "2026-13"}, 400),
])
def test_validation(client, patch, code):
    r = client.post(URL, json={**_ok_small(), **patch})
    assert r.status_code == code, r.text


def test_validation_cells(client):
    b = _ok_small()
    assert client.post(URL, json={**b, "cells": {**b["cells"], "A": _row({}, "残業")}}).status_code == 422
    assert client.post(URL, json={**b, "cells": {**b["cells"], "A": ["日勤"] * 29}}).status_code == 400
    assert client.post(URL, json={**b, "cells": {**b["cells"], "ZZ": _row({})}}).status_code == 400
    b2 = {k: v for k, v in b.items() if k != "cells"}
    assert client.post(URL, json=b2).status_code == 422
    assert client.post(URL, json=b).status_code == 200


def test_rate_limit_is_heavy(client):
    assert guard.is_heavy("POST", URL)
    for _ in range(guard.HEAVY_LIMIT):
        guard.allow("testclient", "heavy")
    r = client.post(URL, json=_ok_small())
    assert r.status_code == 429


def test_does_not_chase_old_soft_shortfalls_but_restores_medical_night(client):
    # 11日は行事で日勤+1人の目安（軟）。欠員の前から足りていない → 組み直しで直しに行かない（変更は欠員の1件だけ）
    staff = [_st("L1", ["遅番"]), _st("A", ["日勤"]), _st("B", ["遅番"]), _st("C", ["日勤"])]
    cells = {"L1": _row({11: "遅番"}), "A": _row({11: "日勤"}), "B": _row({}), "C": _row({})}
    j = client.post(URL, json=_small(cells, staff, 11, extra={"2026-11-11": {"日勤": 1}})).json()
    assert j["status"] == "OPTIMAL" and j["changes"] == [{"staff_id": "B", "from": "", "to": "遅番"}]
    # 夜勤の医療的ケア2人（軟）: 欠けたのが医療的ケアの人なら、医療的ケアのできる人で戻す
    night = [_st(f"N{i}", ["夜勤"], skills=["medical", "night"] if i < 2 else ["night"]) for i in range(5)]
    night.append(_st("M", ["夜勤"], skills=["medical", "night"]))
    cells = {f"N{i}": _row({11: "夜勤"} if i < 3 else {}) for i in range(5)}
    cells["M"] = _row({})
    j = client.post(URL, json=_small(cells, night, 11, shift="夜勤", absent="N0", need_per_shift={"夜勤": 3})).json()
    assert j["status"] == "OPTIMAL" and j["changes"] == [{"staff_id": "M", "from": "", "to": "夜勤"}]


def test_unexpected_errors_are_not_500(client, monkeypatch):
    from care import inline_replan

    def boom(*a, **k):
        raise KeyError("x")

    monkeypatch.setattr(inline_replan, "_model", boom)
    staff = [{"staff_id": "L1", "shifts": ["遅番", "日勤"]}, {"staff_id": "L2", "shifts": ["遅番", "日勤"]}]
    cells = {"L1": _row({}, "遅番"), "L2": _row({}, "日勤")}
    r = client.post(URL, json=_small(cells, staff, 10))
    assert r.status_code == 422
