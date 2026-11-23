"""POST /api/v1/solve-inline: 画面の職員データ（src/core/facility.ts の34名）をそのまま送って月次を解く。保存しない。

入力の職員は scripts/export_app_staff.mjs で facility.ts から書き出した tests/fixtures/app_staff.json。
"""
import calendar
import json
from collections import Counter
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.dsl import Facility, Month, ShiftSel, StaffMember, Succession
from care.inline_solve import MAX_KEYS, InlineSolveIn, solve_inline
from care.solver.monthly import _Build, solve_monthly

STAFF = json.loads((Path(__file__).parent / "fixtures" / "app_staff.json").read_text())
SHIFTS = ("早番", "日勤", "遅番", "夜勤")
URL = "/api/v1/solve-inline"


@pytest.fixture()
def client():
    guard.reset()
    server.set_service(None)          # Firestore もメモリ上の施設も使わない
    yield TestClient(server.app)
    guard.reset()


def _weekend(month: str) -> list[int]:
    y, m = map(int, month.split("-"))
    return [d for d in range(1, calendar.monthrange(y, m)[1] + 1) if date(y, m, d).isoweekday() % 7 in (0, 6)]


def _body(month="2026-11", **kw):
    b = {"month": month, "staff": STAFF, "need_per_shift": {k: 4 for k in SHIFTS},
         "unavailable": {"EMP-001": _weekend(month)},
         "day_off": {"EMP-002": [3, 4], "EMP-017": [10, 11], "EMP-009": [24]},
         "keep_free": {"EMP-026": [20]},
         "carry_in": {"EMP-005": "夜勤", "EMP-007": "遅番"},
         "extra": {f"{month}-27": {"日勤": 2}}, "time_limit": 12}
    b.update(kw)
    return b


def _check(cells, month, night_max=9):
    y, m = map(int, month.split("-"))
    n = calendar.monthrange(y, m)[1]
    allowed = {s["staff_id"]: set(s["shifts"]) for s in STAFF}
    assert set(cells) == set(allowed)
    for sid, row in cells.items():
        assert len(row) == n
        assert all(k == "" or k in allowed[sid] for k in row), sid              # 入れない勤務区分に入れない
        run = 0
        for d, k in enumerate(row):
            if k == "夜勤" and d + 1 < n:
                assert row[d + 1] == "", f"{sid} {d + 1}日 夜勤明けに勤務"
            if k == "遅番" and d + 1 < n:
                assert row[d + 1] != "早番", f"{sid} {d + 1}日 遅番→早番"
            run = run + 1 if k else 0
            assert run <= 5, f"{sid} {d + 1}日 6連勤"
        assert row.count("夜勤") <= night_max
    for d in range(n):
        c = Counter(row[d] for row in cells.values() if row[d])
        for k in SHIFTS:
            assert c[k] >= 4, f"{d + 1}日 {k} {c[k]}人"
    return n


def test_real_app_staff_is_feasible_for_2026_11(client):
    assert len(STAFF) == 34
    r = client.post(URL, json=_body())
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE") and j["wall_ms"] < 15000
    cells = j["cells"]
    _check(cells, "2026-11")
    # 希望休・主任の土日・前月末の夜勤明け・遅番明けの早番禁止
    assert cells["EMP-002"][2:4] == ["", ""] and cells["EMP-017"][9:11] == ["", ""] and cells["EMP-009"][23] == ""
    assert all(cells["EMP-001"][d - 1] == "" for d in _weekend("2026-11"))
    assert cells["EMP-005"][0] == "" and cells["EMP-007"][0] != "早番"
    # 行事の日は日勤が +2
    assert sum(1 for row in cells.values() if row[26] == "日勤") == 6
    # 夜勤の回数をそろえる（夜勤に入れる人どうしで差2以内）
    nights = [cells[s["staff_id"]].count("夜勤") for s in STAFF if "夜勤" in s["shifts"]]
    assert max(nights) - min(nights) <= 2
    # 夜勤には医療的ケアの人が毎晩2人以上（1フロア1人を画面で割り当てられる）
    med = {s["staff_id"] for s in STAFF if "medical" in s["skills"]}
    for d in range(30):
        assert sum(1 for sid, row in cells.items() if row[d] == "夜勤" and sid in med) >= 2
    assert j["explanation"]
    # 画面の労務チェック（labor.ts）と同じ数え方: 夜勤明けも連勤に数えて5日まで、常勤は公休（勤務も明けもない日）8日以上、夜勤8回まで
    assert j["app_labor_rules"] is True
    carry = _body()["carry_in"]
    for s in STAFF:
        row = cells[s["staff_id"]]
        cov = [bool(row[d]) or (row[d - 1] == "夜勤" if d else carry.get(s["staff_id"]) == "夜勤") for d in range(30)]
        run = 0
        for c in cov:
            run = run + 1 if c else 0
            assert run <= 5, s["staff_id"]
        if s["employment"] == "常勤" and not s["is_leader"] and s["shifts"]:
            assert 30 - sum(cov) >= 8, s["staff_id"]
        assert row.count("夜勤") <= 8


def test_night_max_override_and_december(client):
    j = client.post(URL, json=_body("2026-12", night_max=6)).json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert _check(j["cells"], "2026-12", night_max=6) == 31


def test_no_names_needed_and_nothing_saved(client):
    assert all("name" not in s for s in STAFF)
    j = client.post(URL, json=_body(time_limit=5)).json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE") and "proposal_id" not in j


def test_infeasible_returns_status_not_500(client):
    few = [s for s in STAFF if "夜勤" in s["shifts"]][:5]
    j = client.post(URL, json=_body(staff=few, time_limit=3)).json()
    assert j["status"] == "INFEASIBLE" and j["cells"] == {} and j["relaxation"]


def test_validation(client):
    assert client.post(URL, json={**_body(), "month": "2026-13"}).status_code == 400
    assert client.post(URL, json=_body(days=31)).status_code == 400                       # 11月は30日
    bad = [dict(STAFF[0], shifts=["朝勤"])]
    assert client.post(URL, json=_body(staff=bad)).status_code == 422
    assert client.post(URL, json=_body(staff=[STAFF[1], STAFF[1]])).status_code == 400   # 重複
    assert client.post(URL, json=_body(time_limit=60)).status_code == 422


def test_is_rate_limited_as_heavy(client):
    assert guard.is_heavy("POST", URL)
    for _ in range(guard.HEAVY_LIMIT):
        guard.allow("testclient", "heavy")
    r = client.post(URL, json=_body(time_limit=1))
    assert r.status_code == 429


def test_bad_extra_dates_and_oversized_maps_are_422_not_500(client):
    assert client.post(URL, json=_body(extra={"2026-11-ab": {"日勤": 1}})).status_code == 422
    assert client.post(URL, json=_body(extra={"2026-02-30": {"日勤": 1}})).status_code == 422
    assert client.post(URL, json=_body(day_off={f"S{i}": [1] for i in range(500)})).status_code == 422
    assert client.post(URL, json=_body(unavailable={"EMP-001": list(range(1, 200))})).status_code == 422
    assert client.post(URL, json=_body(carry_in={f"S{i}": "夜勤" for i in range(500)})).status_code == 422


def test_zero_need_shift_has_no_assignments(client):
    need = {"早番": 0, "日勤": 4, "遅番": 4, "夜勤": 4}
    j = client.post(URL, json=_body(need_per_shift=need, extra={})).json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    for d in range(30):
        assert sum(1 for row in j["cells"].values() if row[d] == "早番") == 0


def test_zero_need_shift_respects_event_extra(client):
    need = {"早番": 4, "日勤": 0, "遅番": 4, "夜勤": 4}
    j = client.post(URL, json=_body(need_per_shift=need, extra={"2026-11-10": {"日勤": 3}})).json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    for d in range(30):
        cnt = sum(1 for row in j["cells"].values() if row[d] == "日勤")
        assert cnt == (3 if d == 9 else 0), f"{d + 1}日 日勤={cnt}"


def test_all_zero_need_succeeds_with_all_off(client):
    need = {k: 0 for k in SHIFTS}
    j = client.post(URL, json=_body(need_per_shift=need, extra={})).json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert all(k == "" for row in j["cells"].values() for k in row)
    assert any("作れました" in line for line in j["explanation"])


def test_labor_relaxed_explanation_mentions_relaxation(client):
    tight_staff = [
        {"staff_id": f"T{i}", "role": "介護職員", "employment": "常勤", "years": 3, "skills": [], "shifts": ["日勤", "夜勤"]}
        for i in range(1, 4)
    ]
    body = {
        "month": "2026-11",
        "staff": tight_staff,
        "need_per_shift": {"早番": 0, "日勤": 1, "遅番": 0, "夜勤": 1},
        "night_max": 12,
        "time_limit": 5,
    }
    r = client.post(URL, json=body)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert j["app_labor_rules"] is False
    assert "外して作りました" in j["explanation"][0]
    assert all("すべてのルールを満たす勤務表を作れました" not in line for line in j["explanation"])


def test_p1_accepts_new_fields_and_returns_200_without_effect(client):
    base = _body()
    staff_with_limits = [dict(s) for s in STAFF]
    staff_with_limits[1]["limits"] = [
        {"shifts": ["夜勤"], "at_least": 2, "at_most": 6},
        {"shifts": None, "at_most": 20},
        {"shifts": None, "unit": "時間", "at_most": 160},
    ]
    with_all_new = _body(
        staff=staff_with_limits,
        need_by_weekday={"日勤": [3, 4, 4, 4, 4, 4, 3]},
        holidays=[3, 23],
        shift_wish={"EMP-002": {5: "日勤", 6: "勤務"}},
        shift_avoid={"EMP-003": {7: ["夜勤", "遅番"]}},
        fixed={"EMP-004": {8: "日勤", 9: "休"}},
        history={"EMP-005": ["", "日勤", "日勤", "遅番", "", "日勤", "夜勤"]},
    )

    r = client.post(URL, json=with_all_new)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")

    # P5: 新項目を空・既定で渡した場合は省略時と完全一致する
    with_empty_new = _body(
        need_by_weekday={},
        holidays=[],
        shift_wish={},
        shift_avoid={},
        fixed={},
        history={},
    )
    res_base = solve_inline(InlineSolveIn.model_validate(base), workers=1)
    res_empty = solve_inline(InlineSolveIn.model_validate(with_empty_new), workers=1)
    assert res_empty["status"] == res_base["status"]
    assert res_empty["cells"] == res_base["cells"]
    assert res_empty["soft_broken"] == res_base["soft_broken"]


def test_p1_validation_rejects_invalid_new_fields(client):
    def _post(patch):
        guard.reset()
        return client.post(URL, json=_body(**patch))

    def _has_ja(res):
        txt = res.text
        return any("\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff" for ch in txt)

    # need_by_weekday
    for bad in (
        {"日勤": [4, 4, 4]},
        {"朝勤": [4] * 7},
        {"日勤": [4, 4, -1, 4, 4, 4, 4]},
        {"日勤": [4, 4, 21, 4, 4, 4, 4]},
    ):
        r = _post({"need_by_weekday": bad})
        assert r.status_code == 422, bad
        assert _has_ja(r), r.text

    # holidays (2026-11 は 30 日まで)
    for bad in ([0], [31]):
        r = _post({"holidays": bad})
        assert r.status_code == 422, bad
        assert _has_ja(r), r.text

    # staff[].limits
    for bad_limit in (
        {"shifts": ["夜勤"], "at_least": 5, "at_most": 3},
        {"shifts": ["夜勤"]},
        {"shifts": [], "at_most": 5},
        {"shifts": ["休"], "at_most": 5},
        {"shifts": ["勤務"], "at_most": 5},
        {"shifts": ["夜勤"], "unit": "回", "at_most": 32},
        {"shifts": None, "unit": "回", "at_least": 32},
        {"shifts": None, "unit": "時間", "at_most": 745},
    ):
        bad_staff = [dict(STAFF[0], limits=[bad_limit]), *STAFF[1:]]
        r = _post({"staff": bad_staff})
        assert r.status_code == 422, bad_limit
        assert _has_ja(r), r.text

    bad_unit_staff = [dict(STAFF[0], limits=[{"shifts": None, "unit": "日", "at_most": 10}]), *STAFF[1:]]
    assert _post({"staff": bad_unit_staff}).status_code == 422

    # shift_wish
    for bad in (
        {"EMP-002": {5: "休"}},
        {"EMP-002": {5: "朝勤"}},
        {"EMP-002": {0: "日勤"}},
        {"EMP-002": {31: "日勤"}},
    ):
        r = _post({"shift_wish": bad})
        assert r.status_code == 422, bad
        assert _has_ja(r), r.text
    assert _post({"shift_wish": {f"S{i}": {1: "日勤"} for i in range(MAX_KEYS + 1)}}).status_code == 422

    # shift_avoid
    for bad in (
        {"EMP-003": {7: ["休"]}},
        {"EMP-003": {7: ["勤務"]}},
        {"EMP-003": {31: ["夜勤"]}},
        {"EMP-003": {7: ["早番", "日勤", "遅番", "夜勤", "早番"]}},
    ):
        r = _post({"shift_avoid": bad})
        assert r.status_code == 422, bad
        assert _has_ja(r), r.text

    # fixed
    for bad in (
        {"EMP-004": {8: "勤務"}},
        {"EMP-004": {8: ""}},
        {"EMP-004": {0: "日勤"}},
        {"EMP-004": {31: "休"}},
    ):
        r = _post({"fixed": bad})
        assert r.status_code == 422, bad
        assert _has_ja(r), r.text
    assert _post({"fixed": {f"S{i}": {1: "休"} for i in range(MAX_KEYS + 1)}}).status_code == 422

    # history
    for bad in (
        {"EMP-005": [""] * 8},
        {"EMP-005": ["休"]},
        {"EMP-005": ["勤務"]},
    ):
        r = _post({"history": bad})
        assert r.status_code == 422, bad
        assert _has_ja(r), r.text
    assert _post({"history": {f"S{i}": ["日勤"] for i in range(MAX_KEYS + 1)}}).status_code == 422


def test_p2_need_by_weekday_weekend_vs_weekday(client):
    guard.reset()
    r = client.post(
        URL,
        json=_body(
            need_by_weekday={"日勤": [3, 5, 5, 5, 5, 5, 3]},
            extra={},
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    cells = j["cells"]
    for d in range(1, 31):
        wd = date(2026, 11, d).isoweekday() % 7
        expected = 3 if wd in (0, 6) else 5
        cnt = sum(1 for row in cells.values() if row[d - 1] == "日勤")
        assert cnt == expected, f"{d}日(wd={wd}) 日勤={cnt} != {expected}"


def test_p2_holidays_use_sunday_need(client):
    guard.reset()
    # 2026-11-03(火)・2026-11-23(月)を祝日に指定 -> 日曜の値(3)になり、土曜は4、他の平日は5
    r = client.post(
        URL,
        json=_body(
            need_by_weekday={"日勤": [3, 5, 5, 5, 5, 5, 4]},
            holidays=[3, 23],
            extra={},
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    cells = j["cells"]
    for d in range(1, 31):
        wd = date(2026, 11, d).isoweekday() % 7
        expected = 3 if (d in (3, 23) or wd == 0) else (4 if wd == 6 else 5)
        cnt = sum(1 for row in cells.values() if row[d - 1] == "日勤")
        assert cnt == expected, f"{d}日 日勤={cnt} != {expected}"


def test_p2_need_by_weekday_zero_on_weekend(client):
    guard.reset()
    r = client.post(
        URL,
        json=_body(
            need_by_weekday={"早番": [0, 3, 3, 3, 3, 3, 0]},
            extra={},
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    cells = j["cells"]
    for d in range(1, 31):
        wd = date(2026, 11, d).isoweekday() % 7
        expected = 0 if wd in (0, 6) else 3
        cnt = sum(1 for row in cells.values() if row[d - 1] == "早番")
        assert cnt == expected, f"{d}日 早番={cnt} != {expected}"


def test_p2_need_by_weekday_extra_and_night_medical(client):
    guard.reset()
    # 2026-11-01 は日曜。日曜の日勤3に extra +2 で 5人、夜勤は土日2・平日1
    r = client.post(
        URL,
        json=_body(
            need_by_weekday={
                "日勤": [3, 5, 5, 5, 5, 5, 3],
                "夜勤": [2, 1, 1, 1, 1, 1, 2],
            },
            extra={"2026-11-01": {"日勤": 2}},
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    cells = j["cells"]
    med = {s["staff_id"] for s in STAFF if "medical" in s["skills"]}
    assert sum(1 for row in cells.values() if row[0] == "日勤") == 5
    for d in range(1, 31):
        wd = date(2026, 11, d).isoweekday() % 7
        n_night = sum(1 for row in cells.values() if row[d - 1] == "夜勤")
        assert n_night == (2 if wd in (0, 6) else 1)
        if wd in (0, 6):
            n_med = sum(1 for sid, row in cells.items() if row[d - 1] == "夜勤" and sid in med)
            assert n_med >= 2, f"{d}日 夜勤医療的ケア={n_med}"
    assert all(x["rule_id"] != "r-night-medical" for x in j["soft_broken"])


def test_p3_part_time_days_limit(client):
    guard.reset()
    staff = [dict(s) for s in STAFF]
    # EMP-021(index 20, パート), EMP-025(index 24, パート)
    staff[20]["limits"] = [{"shifts": None, "at_most": 10}]
    staff[24]["limits"] = [{"shifts": None, "at_least": 16, "at_most": 18}]
    r = client.post(URL, json=_body(staff=staff))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    c21 = sum(1 for x in j["cells"]["EMP-021"] if x)
    c25 = sum(1 for x in j["cells"]["EMP-025"] if x)
    assert c21 <= 10
    assert 16 <= c25 <= 18


def test_p3_night_dedicated_staff_limits(client):
    guard.reset()
    night_staff = [dict(s) for s in STAFF if "夜勤" in s["shifts"]][:17]
    day_staff = [dict(s) for s in STAFF if "夜勤" not in s["shifts"]]
    staff = night_staff + day_staff
    # EMP-003 に夜勤月8〜10回・日勤0回（共通 night_max=7 より緩い個人上限）
    for s in staff:
        if s["staff_id"] == "EMP-003":
            s["limits"] = [
                {"shifts": ["夜勤"], "at_least": 8, "at_most": 10},
                {"shifts": ["日勤"], "at_most": 0},
            ]
    r = client.post(
        URL,
        json=_body(
            staff=staff,
            need_per_shift={"早番": 0, "日勤": 2, "遅番": 0, "夜勤": 4},
            day_off={},
            unavailable={},
            keep_free={},
            carry_in={},
            extra={},
            night_max=7,
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    row = j["cells"]["EMP-003"]
    assert 8 <= row.count("夜勤") <= 10
    assert row.count("日勤") == 0


def test_p3_full_time_days_override_common_cap(client):
    guard.reset()
    staff = [dict(s) for s in STAFF]
    # EMP-004(index 3, 常勤, 夜勤なし) に 23〜24日勤務（2026-11 の N-8=22 を超える）
    staff[3]["limits"] = [{"shifts": None, "at_least": 23, "at_most": 24}]
    r = client.post(URL, json=_body(staff=staff, extra={}))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert j["app_labor_rules"] is True
    worked = sum(1 for x in j["cells"]["EMP-004"] if x)
    assert 23 <= worked <= 24


def test_p3_unmet_lower_limit_succeeds_and_explains(client):
    guard.reset()
    staff = [dict(s) for s in STAFF]
    # EMP-002 は 2026-11 に希望休2日・連勤5日までなので 28 日勤務は物理的に不可 -> 下限だけ破れて作れる
    staff[1]["limits"] = [{"shifts": None, "at_least": 28}]
    r = client.post(URL, json=_body(staff=staff, extra={}))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert any("EMP-002さんの勤務日数（月28日以上）」が1件" in line for line in j["explanation"])


def test_p3_unit_hours_limit(client):
    guard.reset()
    staff = [dict(s) for s in STAFF]
    staff[3]["limits"] = [{"shifts": None, "unit": "時間", "at_most": 80}]
    r = client.post(URL, json=_body(staff=staff, extra={}))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    hours_map = {"早番": 8, "日勤": 8, "遅番": 8, "夜勤": 13}
    hours = sum(hours_map[x] for x in j["cells"]["EMP-004"] if x)
    assert hours <= 80


def test_p4_fixed_assignment_is_respected(client):
    guard.reset()
    r = client.post(
        URL,
        json=_body(
            fixed={"EMP-002": {10: "日勤", 12: "休"}},
            day_off={"EMP-002": [10]},  # 固定は day_off より強く絶対
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert j["cells"]["EMP-002"][9] == "日勤"
    assert j["cells"]["EMP-002"][11] == ""


def test_p4_fixed_conflicts_return_422_japanese(client):
    def _post(patch):
        guard.reset()
        return client.post(URL, json=_body(**patch))

    def _has_ja(txt):
        return any("\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff" for ch in txt)

    # ① 入れない勤務帯を固定（EMP-004 は夜勤不可）
    r1 = _post({"fixed": {"EMP-004": {5: "夜勤"}}})
    assert r1.status_code == 422
    assert _has_ja(r1.json()["error"])

    # ② 入れない日に勤務を固定（EMP-001 は土日不可、2026-11-01 は日曜）
    r2 = _post({"fixed": {"EMP-001": {1: "日勤"}}})
    assert r2.status_code == 422
    assert _has_ja(r2.json()["error"])
    assert _post({"fixed": {"EMP-001": {1: "休"}}}).status_code == 200

    # ③ 夜勤の翌日に勤務を固定（当月連なり）
    r3 = _post({"fixed": {"EMP-002": {5: "夜勤", 6: "日勤"}}})
    assert r3.status_code == 422
    assert _has_ja(r3.json()["error"])

    # ③ 夜勤の翌日に勤務を固定（前月末の引き継ぎ）
    r4 = _post({"fixed": {"EMP-005": {1: "日勤"}}})  # _body は EMP-005 carry_in="夜勤"
    assert r4.status_code == 422
    assert _has_ja(r4.json()["error"])
    assert _post({"fixed": {"EMP-005": {1: "休"}}}).status_code == 200


def test_p4_fixed_infeasible_with_staffing_explains_fixed(client):
    guard.reset()
    # 10日に日勤を5人固定（必要人数はちょうど4人、行事なし -> 両立しない）
    r = client.post(
        URL,
        json=_body(
            extra={},
            fixed={
                "EMP-002": {10: "日勤"},
                "EMP-003": {10: "日勤"},
                "EMP-004": {10: "日勤"},
                "EMP-006": {10: "日勤"},
                "EMP-007": {10: "日勤"},
            },
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] == "INFEASIBLE"
    assert j["explanation"][0].startswith("固定した5件が、")
    assert "両立しません" in j["explanation"][0]


def test_p4_shift_wish_and_shift_avoid(client):
    guard.reset()
    r = client.post(
        URL,
        json=_body(
            shift_wish={
                "EMP-002": {14: "遅番", 15: "勤務"},
                "EMP-001": {1: "日勤"},  # EMP-001 は日曜(1日)不可なので希望は外れても 200 で作れる
            },
            shift_avoid={"EMP-003": {16: ["夜勤", "遅番"]}},
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert j["cells"]["EMP-002"][13] == "遅番"
    assert j["cells"]["EMP-002"][14] != ""
    assert j["cells"]["EMP-003"][15] not in ("夜勤", "遅番")
    assert any("EMP-001" in x["label"] for x in j["soft_broken"])


def test_p5_history_four_day_run_forces_rest_by_day_2(client):
    guard.reset()
    r = client.post(
        URL,
        json=_body(
            history={"EMP-002": ["日勤", "日勤", "日勤", "日勤"]},
            fixed={"EMP-002": {1: "日勤"}},
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert j["cells"]["EMP-002"][0] == "日勤"
    assert j["cells"]["EMP-002"][1] == ""


def test_p5_history_night_then_off_allows_day_1_and_night_last_forbids_day_1(client):
    # 前月末が「夜勤・明け("")」かつ carry_in が夜勤でも history が優先され、1日目に勤務できる
    guard.reset()
    r_ok = client.post(
        URL,
        json=_body(
            carry_in={"EMP-002": "夜勤", "EMP-005": "夜勤", "EMP-007": "遅番"},
            history={"EMP-002": ["夜勤", ""]},
            fixed={"EMP-002": {1: "日勤"}},
        ),
    )
    assert r_ok.status_code == 200, r_ok.text
    j_ok = r_ok.json()
    assert j_ok["status"] in ("OPTIMAL", "FEASIBLE")
    assert j_ok["cells"]["EMP-002"][0] == "日勤"

    # history の最終日が夜勤 -> 1日目は必ず休み、かつ 1日目勤務の固定は 422
    guard.reset()
    r_off = client.post(URL, json=_body(history={"EMP-002": ["日勤", "夜勤"]}))
    assert r_off.status_code == 200, r_off.text
    assert r_off.json()["cells"]["EMP-002"][0] == ""

    guard.reset()
    r_422 = client.post(
        URL,
        json=_body(
            carry_in={"EMP-007": "遅番"},
            history={"EMP-002": ["日勤", "夜勤"]},
            fixed={"EMP-002": {1: "日勤"}},
        ),
    )
    assert r_422.status_code == 422
    assert any("\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff" for ch in r_422.json()["error"])

    # history の最終日が遅番 -> 1日目に早番が入らない（希望を出しても避けられる）
    guard.reset()
    r_late = client.post(
        URL,
        json=_body(
            history={"EMP-002": ["", "遅番"]},
            shift_wish={"EMP-002": {1: "早番"}},
        ),
    )
    assert r_late.status_code == 200, r_late.text
    assert r_late.json()["cells"]["EMP-002"][0] != "早番"


def test_p5_history_app_labor_counts_pre_month_ake_in_run(client):
    guard.reset()
    # 日勤・日勤・夜勤・明け("") で pre_cov=[1,1,1,1] -> 1日目日勤は可、2日目は明け含め6連続になるため休み
    r = client.post(
        URL,
        json=_body(
            history={"EMP-002": ["日勤", "日勤", "夜勤", ""]},
            fixed={"EMP-002": {1: "日勤"}},
        ),
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["status"] in ("OPTIMAL", "FEASIBLE")
    assert j["app_labor_rules"] is True
    assert j["cells"]["EMP-002"][0] == "日勤"
    assert j["cells"]["EMP-002"][1] == ""


def test_p5_carry_in_only_unchanged():
    # carry_in のみの入力では前月を連勤窓に数えず、1〜5日目の5連勤も従来どおり許容される
    body = _body(
        carry_in={"EMP-003": "遅番", "EMP-005": "夜勤", "EMP-007": "遅番"},
        fixed={"EMP-003": {1: "日勤", 2: "日勤", 3: "日勤", 4: "日勤", 5: "日勤"}},
    )
    res = solve_inline(InlineSolveIn.model_validate(body), workers=1)
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    assert res["cells"]["EMP-003"][:5] == ["日勤"] * 5
    assert res["cells"]["EMP-005"][0] == ""
    assert res["cells"]["EMP-007"][0] != "早番"


def test_p5_solve_monthly_history_pattern_and_no_extra_vars():
    staff = [StaffMember(staff_id="S1", name="S1", role="介護職員", employment="常勤", shifts=["日勤", "夜勤"])]
    fac = Facility(facility_id="F1", name="F1", staff=staff)
    mo = Month(month="2026-11", days=28, first_weekday=0)
    forbid_nn = Succession(
        id="r-no-n-off-n",
        label="夜勤・休・夜勤を禁止",
        strength="絶対",
        pattern=[ShiftSel(ids=["夜勤"]), ShiftSel(ids=["休"]), ShiftSel(ids=["夜勤"])],
        forbid=True,
    )
    # 変数数は history の有無で変わらない（前月は定数扱い）
    b_no = _Build(fac, mo, [forbid_nn], fixed=None, carry_in=None, relax=False, boost=None, baseline=None, use_coverage=False)
    b_hi = _Build(
        fac, mo, [forbid_nn], fixed=None, carry_in=None, relax=False, boost=None, baseline=None, use_coverage=False,
        history={"S1": ["夜勤", ""]},
    )
    assert len(b_hi.x) == len(b_no.x)

    # history=["夜勤", ""] のときに 1日目に夜勤を固定すると、3日並びルールで INFEASIBLE
    res1 = solve_monthly(fac, mo, [forbid_nn], fixed={"S1": {1: "夜勤"}}, history={"S1": ["夜勤", ""]}, use_coverage=False, workers=1)
    assert res1.status == "INFEASIBLE"

    # history=["日勤", "夜勤"] のときに 1日=休・2日=夜勤にすると 2日目も夜勤・休・夜勤 で INFEASIBLE
    res2 = solve_monthly(fac, mo, [forbid_nn], fixed={"S1": {1: "休", 2: "夜勤"}}, history={"S1": ["日勤", "夜勤"]}, use_coverage=False, workers=1)
    assert res2.status == "INFEASIBLE"

    # history 無しなら 2日目夜勤は許容される
    res_ok = solve_monthly(fac, mo, [forbid_nn], fixed={"S1": {1: "休", 2: "夜勤"}}, use_coverage=False, workers=1)
    assert res_ok.status in ("OPTIMAL", "FEASIBLE")

