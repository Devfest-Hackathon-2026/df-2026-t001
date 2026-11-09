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
