"""Q1〜Q2b（公休の数え方・Count.target・need_mode・off_target・need_max・max_run・min_interval_h）のテスト。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bench.check import check as bench_check
from care import guard, server
from care.dsl import (
    OFF,
    PUBLIC_OFF,
    Balance,
    Count,
    Facility,
    Month,
    PeopleSel,
    Request,
    ShiftSel,
    Staffing,
    StaffMember,
    DaySel,
)
from care.inline_solve import DEFAULT_SHIFT_TIMES, InlineSolveIn, build, solve_inline
from care.solver.explain import explain_monthly
from care.solver.monthly import solve_monthly
from care.verify import verify_monthly

URL = "/api/v1/solve-inline"
FIXTURE = Path(__file__).parent / "fixtures" / "app_staff.json"


@pytest.fixture
def client():
    guard.reset()
    return TestClient(server.app)


def _staff_12(all_shifts=None):
    sh = all_shifts or ["早番", "日勤", "遅番", "夜勤"]
    out = []
    for i in range(1, 13):
        out.append({
            "staff_id": f"S{i:02d}",
            "role": "介護福祉士" if i > 1 else "主任",
            "employment": "常勤",
            "skills": ["medical"] if i % 2 == 0 else [],
            "shifts": ["早番", "日勤", "遅番"] if i == 1 else list(sh),
            "is_leader": i == 1,
        })
    return out


# ---------------------------------------------------------------- Q1: 公休・Count.target

def test_q1_public_off_excludes_ake_and_prev_month_night():
    fac = Facility(
        facility_id="f1",
        name="f1",
        staff=[StaffMember(staff_id="S1", name="S1", role="介護職員", employment="常勤", shifts=["日勤", "夜勤"])],
    )
    mo = Month(month="2026-11", days=30, first_weekday=0)
    # 2日目に夜勤 → 3日目は明け（休みだが公休に数えない）
    # 10日目は普通の休み（公休に数える）
    row = [""] * 30
    row[1] = "夜勤"  # 2日
    row[3] = "日勤"  # 4日
    for d in range(4, 30):
        row[d] = "日勤"
    # 1日目も休み、前月最終日が夜勤なら1日目は明け扱い
    rule = Count(
        id="c-pub",
        label="公休チェック",
        strength="強く",
        shifts=ShiftSel(ids=[PUBLIC_OFF]),
        at_least=1,
    )
    # 前月末が夜勤でない: 1日目=公休, 3日目=明け(非公休) → 公休=1日 (達成)
    assert verify_monthly(fac, mo, {"S1": row}, [rule], carry_in={}) == {}
    # 前月末が夜勤 (carry_in): 1日目=明け, 3日目=明け → 公休=0日 (1件不足)
    assert verify_monthly(fac, mo, {"S1": row}, [rule], carry_in={"S1": "夜勤"}) == {"c-pub": 1}
    # 前月末が夜勤 (history): 同様に 1日目は公休に数えない
    assert verify_monthly(fac, mo, {"S1": row}, [rule], history={"S1": ["日勤", "夜勤"]}) == {"c-pub": 1}

    # ソルバー上でも前月最終日=夜勤のとき1日目は公休に数えないことを確かめる
    fac2 = Facility(
        facility_id="f2",
        name="f2",
        staff=[
            StaffMember(staff_id="S1", name="S1", role="介護職員", employment="常勤", shifts=["日勤"]),
        ],
    )
    mo2 = Month(month="2026-11", days=28, first_weekday=0)
    # 28日すべて日勤にすると公休0。1日目に夜勤明け(carry_in夜勤)なら1日目は休んでも公休0、2日目を休めば公休1。
    pub_goal = Count(
        id="c-goal",
        label="公休目標1日",
        strength="強く",
        shifts=ShiftSel(ids=[PUBLIC_OFF]),
        target=1,
    )
    res = solve_monthly(fac2, mo2, [pub_goal], carry_in={"S1": "夜勤"}, use_coverage=False, workers=1)
    assert res.status in ("OPTIMAL", "FEASIBLE")
    assert res.soft_broken == []
    # 1日目だけでは公休1にならないので、2〜28日のどこかに必ず休みが1日入る
    assert any(res.cells["S1"][d] == "" for d in range(1, 28))


def test_q1_count_target_minimizes_total_deviation_and_validates():
    fac = Facility(
        facility_id="f",
        name="f",
        staff=[
            StaffMember(staff_id="S1", name="S1", role="介護職員", employment="常勤", shifts=["日勤"]),
            StaffMember(staff_id="S2", name="S2", role="介護職員", employment="常勤", shifts=["日勤"]),
        ],
    )
    mo = Month(month="2026-11", days=10, first_weekday=0)
    # 毎日1人日勤(計10勤務 = 2人×5日勤務 → 公休は各5日)。target=5 ならずれ0
    r_staff = Staffing(id="st", label="日勤1", strength="絶対", shifts=ShiftSel(ids=["日勤"]), at_least=1, at_most=1)
    r_tgt = Count(id="pub5", label="公休目標5日", strength="強く", shifts=ShiftSel(ids=[PUBLIC_OFF]), target=5)
    res = solve_monthly(fac, mo, [r_staff, r_tgt], use_coverage=False, workers=1)
    assert res.soft_broken == []
    assert res.cells["S1"].count("") == 5 and res.cells["S2"].count("") == 5

    # S1 に 8日希望休(強く=1000) を出すと、公休目標(500/日)とのトレードオフで希望休が通り、S1だけ目標からずれる
    r_wish = Request(
        id="w1", label="S1希望休", strength="強く",
        people=PeopleSel(ids=["S1"]), days=DaySel(dates=list(range(1, 9))), shifts=ShiftSel(ids=[OFF]), want=True,
    )
    res2 = solve_monthly(fac, mo, [r_staff, r_tgt, r_wish], use_coverage=False, workers=1)
    assert res2.status in ("OPTIMAL", "FEASIBLE")
    assert all(res2.cells["S1"][d - 1] == "" for d in range(1, 9))
    assert any(b.rule_id == "pub5" and b.count >= 1 for b in res2.soft_broken)
    txt = "\n".join(explain_monthly(res2))
    assert "外れた人が" in txt and "日ずれ" in txt

    # target + 絶対 / target < at_least / target > at_most / 範囲外は拒否される
    with pytest.raises(ValueError, match="絶対"):
        Count(id="bad1", label="bad", strength="絶対", shifts=ShiftSel(ids=[PUBLIC_OFF]), target=8)
    with pytest.raises(ValueError, match="矛盾"):
        Count(id="bad2", label="bad", strength="強く", shifts=ShiftSel(ids=[PUBLIC_OFF]), at_least=10, target=8)
    with pytest.raises(ValueError, match="矛盾"):
        Count(id="bad3", label="bad", strength="強く", shifts=ShiftSel(ids=[PUBLIC_OFF]), at_most=6, target=8)
    with pytest.raises(ValueError, match="公休"):
        Staffing(id="bad4", label="bad", shifts=ShiftSel(ids=[PUBLIC_OFF]), at_least=1)


# ---------------------------------------------------------------- Q2: need_mode="min" & off_target

def test_q2_need_mode_min_and_off_target(client):
    staff = json.loads(FIXTURE.read_text())[:24]
    base_req = {
        "month": "2026-11",  # 30日、土日=1,7,8,14,15,21,22,28,29 の9日 + 祝日2日(3,23) = 11日
        "staff": staff,
        "need_per_shift": {"早番": 2, "日勤": 2, "遅番": 2, "夜勤": 2},
        "holidays": [3, 23],
        "need_mode": "min",
        "time_limit": 12.0,
    }
    res = solve_inline(InlineSolveIn.model_validate(base_req), workers=1)
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    assert res["explanation"][0].startswith("日勤系は") and "公休は月11日を目標に作りました" in res["explanation"][0]

    chk = bench_check(base_req, res)
    assert chk["hard"] == {}, chk
    # 夜勤は毎日ちょうど 2人
    assert chk["daily_counts"]["夜勤"]["min"] == 2 and chk["daily_counts"]["夜勤"]["max"] == 2
    # 日勤系は下限以上
    for k in ("早番", "日勤", "遅番"):
        assert chk["daily_counts"][k]["min"] >= 2

    # 希望休が目標(off_target=8)を超える人を1人入れて、その人だけが公休目標を破り、希望休が通ることを確認
    req2 = {
        "month": "2026-11",
        "staff": _staff_12(),
        "need_per_shift": {"早番": 1, "日勤": 2, "遅番": 1, "夜勤": 1},
        "need_mode": "min",
        "off_target": 8,
        "day_off": {"S02": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]},  # 12日希望休 > 目標8日
        "time_limit": 12.0,
    }
    res2 = solve_inline(InlineSolveIn.model_validate(req2), workers=1)
    assert res2["status"] in ("OPTIMAL", "FEASIBLE")
    chk2 = bench_check(req2, res2)
    assert chk2["hard"] == {}, chk2
    assert chk2["day_off"][0] == chk2["day_off"][1]  # 希望休が全件通る
    assert any(b["rule_id"] == "r-off-target" for b in res2["soft_broken"])

    # exact と 省略時 は完全一致する
    sakura = json.loads(FIXTURE.read_text())
    r_omit = solve_inline(InlineSolveIn.model_validate({"month": "2026-11", "staff": sakura}), workers=1)
    r_exact = solve_inline(InlineSolveIn.model_validate({"month": "2026-11", "staff": sakura, "need_mode": "exact"}), workers=1)
    assert r_omit["cells"] == r_exact["cells"]
    assert r_omit["soft_broken"] == r_exact["soft_broken"]


# ---------------------------------------------------------------- Q2b: need_max / max_run / shift_times / min_interval_h

def test_q2b_max_run_min_interval_and_need_max(client):
    # 1. max_run=6 なら 6 連勤を固定しても通り、7 連勤は拒否（別解または失敗）
    staff = _staff_12()
    fixed_6 = {"S02": {d: "日勤" for d in range(1, 7)}}
    res_6 = solve_inline(
        InlineSolveIn.model_validate({
            "month": "2026-11",
            "staff": staff,
            "need_per_shift": {"早番": 1, "日勤": 2, "遅番": 1, "夜勤": 1},
            "max_run": 6,
            "fixed": fixed_6,
        }),
        workers=1,
    )
    assert res_6["status"] in ("OPTIMAL", "FEASIBLE")
    assert bench_check({
        "month": "2026-11", "staff": staff,
        "need_per_shift": {"早番": 1, "日勤": 2, "遅番": 1, "夜勤": 1},
        "max_run": 6, "fixed": fixed_6,
    }, res_6)["hard"] == {}
    assert "連続勤務の上限を6日にしています" in res_6["explanation"][0]

    # max_run=6 でも 7 連勤固定は作れない
    fixed_7 = {"S02": {d: "日勤" for d in range(1, 8)}}
    res_7 = solve_inline(
        InlineSolveIn.model_validate({
            "month": "2026-11",
            "staff": staff,
            "need_per_shift": {"早番": 1, "日勤": 2, "遅番": 1, "夜勤": 1},
            "max_run": 6,
            "fixed": fixed_7,
        }),
        workers=1,
    )
    assert res_7["status"] == "INFEASIBLE"

    # 2. さくら苑の時刻 + min_interval_h=11 → 置かない並びは「遅番→早番」だけ（省略時と同じ）
    b_def = InlineSolveIn.model_validate({"month": "2026-11", "staff": staff, "need_per_shift": {"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1}})
    b_iv11 = InlineSolveIn.model_validate({
        "month": "2026-11", "staff": staff,
        "need_per_shift": {"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        "shift_times": DEFAULT_SHIFT_TIMES, "min_interval_h": 11,
    })
    _, _, r_def, _ = build(b_def)
    _, _, r_iv11, _ = build(b_iv11)
    assert [r.pattern for r in r_def if r.id.startswith("r-interval")] == [r.pattern for r in r_iv11 if r.id.startswith("r-interval")]

    # 3. 遅番(21:00)→日勤(09:00)=12時間: min_interval_h=12 では置けるが、13 では置けない
    req_12 = {
        "month": "2026-11", "staff": staff,
        "need_per_shift": {"早番": 1, "日勤": 1, "遅番": 1, "夜勤": 1},
        "shift_times": DEFAULT_SHIFT_TIMES, "min_interval_h": 12,
        "fixed": {"S02": {5: "遅番", 6: "日勤"}},
    }
    res_12 = solve_inline(InlineSolveIn.model_validate(req_12), workers=1)
    assert res_12["status"] in ("OPTIMAL", "FEASIBLE")
    assert bench_check(req_12, res_12)["hard"] == {}

    res_13 = solve_inline(InlineSolveIn.model_validate({**req_12, "min_interval_h": 13}), workers=1)
    assert res_13["status"] == "INFEASIBLE"

    # 4. need_max < daily_need -> 422
    r_bad = client.post(URL, json={
        "month": "2026-11",
        "staff": staff,
        "need_per_shift": {"早番": 2, "日勤": 3, "遅番": 2, "夜勤": 1},
        "need_max": {"日勤": 2},
    })
    assert r_bad.status_code == 422
    assert "必要人数" in r_bad.text
