"""勤務区分のデータ化（T1〜T6）のテスト。"""
from __future__ import annotations

import json
import textwrap
from pathlib import Path

import pytest
from pydantic import ValidationError

from bench import cases, check as bench_check, convert, dropped_summary
from care.ai import planintent as pi, translate as tr
from care.dsl import DEFAULT_SHIFT_TYPES, Facility, ShiftType, StaffMember
from care.inline_rank import RankIn, rank as rank_inline
from care.inline_replan import InlineReplanIn, replan_inline
from care.inline_solve import InlineSolveIn, solve_inline
from care.inline_verify import check_cells


THREE_SHIFTS = cases.THREE_SHIFT_TYPES


def _mk_staff(n: int, shifts: list[str], *, leader_shifts: list[str] | None = None) -> list[dict]:
    out = []
    for i in range(n):
        sh = leader_shifts if (i == 0 and leader_shifts is not None) else shifts
        out.append({
            "staff_id": f"S{i + 1:03d}",
            "role": "主任" if i == 0 else "看護師",
            "employment": "常勤",
            "skills": ["medical"],
            "shifts": list(sh),
            "is_leader": i == 0,
        })
    return out


# ---------------------------------------------------------------- T1 / T2: 基本・検証・互換性


def test_default_shift_types_explicit_matches_omitted():
    staff = _mk_staff(16, ["早番", "日勤", "遅番", "夜勤"], leader_shifts=["早番", "日勤", "遅番"])
    base = {
        "month": "2026-11",
        "days": 30,
        "first_weekday": 0,
        "staff": staff,
        "need_per_shift": {"早番": 2, "日勤": 2, "遅番": 2, "夜勤": 1},
        "time_limit": 8,
    }
    explicit = {
        **base,
        "shift_types": [st.model_dump() for st in DEFAULT_SHIFT_TYPES],
    }
    r0 = solve_inline(InlineSolveIn.model_validate(base))
    r1 = solve_inline(InlineSolveIn.model_validate(explicit))
    assert r0["status"] in ("OPTIMAL", "FEASIBLE")
    assert r1["status"] in ("OPTIMAL", "FEASIBLE")
    c0 = bench_check.check(base, r0)
    c1 = bench_check.check(explicit, r1)
    assert c0["hard"] == {} and c1["hard"] == {}
    assert c0["labor"] == {} and c1["labor"] == {}


def test_validation_rejects_unknown_shift_id_and_over_12():
    staff = _mk_staff(6, ["日", "準", "深"])
    # 区分にない id を need_per_shift に使う -> ValidationError (422)
    with pytest.raises(ValidationError, match="need_per_shift"):
        InlineSolveIn.model_validate({
            "month": "2026-11",
            "shift_types": THREE_SHIFTS,
            "staff": staff,
            "need_per_shift": {"夜勤": 1},
        })
    # 区分にない id を staff[].shifts に使う -> ValidationError
    with pytest.raises(ValidationError, match="勤務区分が不正"):
        InlineSolveIn.model_validate({
            "month": "2026-11",
            "shift_types": THREE_SHIFTS,
            "staff": [{**staff[0], "shifts": ["未知"]}],
            "need_per_shift": {"日": 1},
        })
    # 区分にない id を fixed に使う -> ValidationError
    with pytest.raises(ValidationError, match="fixed"):
        InlineSolveIn.model_validate({
            "month": "2026-11",
            "shift_types": THREE_SHIFTS,
            "staff": staff,
            "need_per_shift": {"日": 1},
            "fixed": {"S001": {1: "未知"}},
        })
    # 区分が 12 を超える -> ValidationError
    thirteen = [
        {"id": f"K{i}", "name": f"区分{i}", "short": f"{i}", "start": "08:00", "end": "16:00", "group": "日勤系"}
        for i in range(13)
    ]
    with pytest.raises(ValidationError):
        InlineSolveIn.model_validate({
            "month": "2026-11",
            "shift_types": thirteen,
            "staff": _mk_staff(4, ["K0"]),
            "need_per_shift": {"K0": 1},
        })
    # 予約語 id ("休") -> ValidationError
    with pytest.raises(ValidationError, match="予約語"):
        ShiftType(id="休", start="08:00", end="16:00")


def test_counts_false_not_counted_in_staffing_but_counted_in_work_days():
    sts = [
        {"id": "日", "name": "日勤", "short": "日", "start": "08:30", "end": "17:15", "group": "日勤系", "counts": True, "next_day": "なし"},
        {"id": "研", "name": "研修", "short": "研", "start": "09:00", "end": "17:00", "group": "日勤系", "counts": False, "next_day": "なし"},
    ]
    staff = _mk_staff(6, ["日", "研"])
    # S001 は 1日〜5日に研修固定（counts=False）。1日の日勤は依然として 2人必要
    req = {
        "month": "2026-11",
        "days": 30,
        "first_weekday": 0,
        "shift_types": sts,
        "staff": staff,
        "need_per_shift": {"日": 2},
        "need_by_group": {"日勤系": 2},
        "fixed": {"S001": {1: "研", 2: "研", 3: "研", 4: "研", 5: "研"}},
        "time_limit": 8,
    }
    res = solve_inline(InlineSolveIn.model_validate(req))
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    cells = res["cells"]
    # S001 の 1〜5日は研修固定、かつ 5連勤したので 6日目は必ず休み（勤務日として数えられている）
    assert cells["S001"][:5] == ["研"] * 5
    assert cells["S001"][5] == ""
    # 1〜5日目の日勤人数は研修を除外して 2人以上いること（need_by_group 指定時は下限）
    for d in range(5):
        assert sum(1 for row in cells.values() if row[d] == "日") >= 2
    chk = bench_check.check(req, res)
    assert chk["hard"] == {}

    # need_by_group を外して need_per_shift のみにした場合は ちょうど 2人（研修は数えない）
    req_exact = {k: v for k, v in req.items() if k != "need_by_group"}
    res_exact = solve_inline(InlineSolveIn.model_validate(req_exact))
    assert res_exact["status"] in ("OPTIMAL", "FEASIBLE")
    assert res_exact["cells"]["S001"][:5] == ["研"] * 5
    for d in range(5):
        assert sum(1 for row in res_exact["cells"].values() if row[d] == "日") == 2
    assert bench_check.check(req_exact, res_exact)["hard"] == {}


def test_inline_replan_verify_rank_and_ai_with_three_shifts():
    inst = cases.three_shift_cases()[0]
    req = inst["request"]
    res = solve_inline(InlineSolveIn.model_validate(req))
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    cells = res["cells"]

    # inline_verify.check_cells with shift_types
    st_objs = [ShiftType.model_validate(s) for s in req["shift_types"]]
    check_cells(cells, "2026-12-10", st_objs)

    # Find someone working 日 on day 10 and replan
    absent = next(sid for sid, row in cells.items() if row[9] == "日")
    rep = replan_inline(InlineReplanIn.model_validate({
        "month": req["month"],
        "days": req["days"],
        "first_weekday": req["first_weekday"],
        "shift_types": req["shift_types"],
        "staff": req["staff"],
        "need_per_shift": req["need_per_shift"],
        "cells": cells,
        "date": 10,
        "vacancy": {"shift": "日", "absent_staff_id": absent},
        "carry_in": req["carry_in"],
        "night_max": req["night_max"],
    }))
    assert rep["status"] in ("OPTIMAL", "FEASIBLE")
    assert len(rep["filled_by"]) >= 1
    assert absent not in rep["filled_by"]

    # inline_rank with shift_types
    ranked = rank_inline(RankIn.model_validate({
        "date": "2026-12-10",
        "shift": "日",
        "shift_types": req["shift_types"],
        "absent_staff_id": absent,
        "staff": [{"id": s["staff_id"], "role": s["role"], "employment": s["employment"],
                   "skills": s["skills"], "shifts": s["shifts"]} for s in req["staff"]],
        "cells": cells,
        "month_days": req["days"],
        "first_weekday": req["first_weekday"],
        "carry_in": req["carry_in"],
    }), None)
    assert "candidates" in ranked

    # planintent & translate with custom shift types
    prompt = pi.build_prompt("12/5に準夜を入れて", "2026-12", "2026-12-01", [{"id": "N001", "name": "A"}], [], shifts=["日", "準", "深"])
    assert "日, 準, 深" in prompt
    intent_ok = pi.sanitize(pi.PlanIntent(intent="assign", staff_ids=["N001"], date="2026-12-05", shift="準"), "2026-12", {"N001"}, set(), shifts=["日", "準", "深"])
    assert intent_ok.intent == "assign" and intent_ok.shift == "準"
    intent_bad = pi.sanitize(pi.PlanIntent(intent="assign", staff_ids=["N001"], date="2026-12-05", shift="夜勤"), "2026-12", {"N001"}, set(), shifts=["日", "準", "深"])
    assert intent_bad.intent == "unknown" and intent_bad.shift is None

    fac3 = Facility(
        facility_id="f3",
        name="3交代テスト",
        shift_types=[ShiftType.model_validate(s) for s in THREE_SHIFTS],
        staff=[StaffMember(staff_id="N001", name="A", role="看護師", employment="常勤", shifts=["日", "準", "深"])],
    )
    assert tr.validate(tr.RuleDraft(type="request", shift_ids=["準"], want=False), fac3) == []
    assert tr.validate(tr.RuleDraft(type="request", shift_ids=["夜勤"], want=False), fac3) != []


# ---------------------------------------------------------------- T3: 3交代


def test_three_shift_no_ake_interval_and_night_group():
    # 準 (16:30-01:15) -> 準 (16:30) は 15.25h で可（明けにならない）
    # 日 (08:30-17:15) -> 深 (00:30) は 7.25h -> min_interval_h=11 で禁止、7 で許可
    staff = _mk_staff(12, ["日", "準", "深"])
    base = {
        "month": "2026-11",
        "days": 30,
        "first_weekday": 0,
        "shift_types": THREE_SHIFTS,
        "staff": staff,
        "need_per_shift": {"日": 2, "準": 1, "深": 1},
        "night_max": 8,
        "time_limit": 8,
    }
    # 準→準 を固定しても 11h ルール・明けなし で解ける
    r_jun_jun = solve_inline(InlineSolveIn.model_validate({**base, "min_interval_h": 11.0, "fixed": {"S002": {1: "準", 2: "準"}}}))
    assert r_jun_jun["status"] in ("OPTIMAL", "FEASIBLE")
    assert r_jun_jun["cells"]["S002"][0] == "準" and r_jun_jun["cells"]["S002"][1] == "準"

    # 日→深 を固定: 11h では INFEASIBLE、7h に緩めると FEASIBLE/OPTIMAL
    r_11 = solve_inline(InlineSolveIn.model_validate({**base, "min_interval_h": 11.0, "fixed": {"S002": {1: "日", 2: "深"}}}))
    assert r_11["status"] == "INFEASIBLE"
    r_7 = solve_inline(InlineSolveIn.model_validate({**base, "min_interval_h": 7.0, "fixed": {"S002": {1: "日", 2: "深"}}}))
    assert r_7["status"] in ("OPTIMAL", "FEASIBLE")

    # 準→日 を固定: 11h では INFEASIBLE (7.25h)
    r_jun_hi = solve_inline(InlineSolveIn.model_validate({**base, "min_interval_h": 11.0, "fixed": {"S002": {1: "準", 2: "日"}}}))
    assert r_jun_hi["status"] == "INFEASIBLE"

    # 夜勤上限が 準+深 の合計で効くこと & need_mode="min" で準・深はちょうど、日勤は下限以上
    r_min = solve_inline(InlineSolveIn.model_validate({
        **base,
        "need_mode": "min",
        "night_max": 6,
        "min_interval_h": 11.0,
    }))
    assert r_min["status"] in ("OPTIMAL", "FEASIBLE")
    cells = r_min["cells"]
    for row in cells.values():
        assert sum(1 for x in row if x in ("準", "深")) <= 6
    for d in range(30):
        assert sum(1 for row in cells.values() if row[d] == "準") == 1
        assert sum(1 for row in cells.values() if row[d] == "深") == 1
        assert sum(1 for row in cells.values() if row[d] == "日") >= 2

    # 任意の禁止並びを rules で足せる（例: 深→日 を禁止）
    r_custom = solve_inline(InlineSolveIn.model_validate({
        **base,
        "min_interval_h": 11.0,
        "rules": [{
            "type": "succession",
            "id": "r-no-shin-hi",
            "label": "深夜の翌日に日勤を置かない",
            "strength": "絶対",
            "pattern": [{"ids": ["深"]}, {"ids": ["日"]}],
            "forbid": True,
        }],
    }))
    assert r_custom["status"] in ("OPTIMAL", "FEASIBLE")
    for row in r_custom["cells"].values():
        assert all(not (row[i] == "深" and row[i + 1] == "日") for i in range(29))


# ---------------------------------------------------------------- T4: .ros --keep-shift-types


def test_convert_ros_keep_shift_types_preserves_shifts_and_counts_false(tmp_path: Path):
    xml = textwrap.dedent("""\
        <?xml version="1.0" encoding="UTF-8"?>
        <SchedulingPeriod ID="Mini3Shift">
          <StartDate>2026-11-01</StartDate>
          <EndDate>2026-11-30</EndDate>
          <ShiftTypes>
            <Shift ID="N"><Label>N</Label><Name>Night</Name><StartTime>18:00:00</StartTime><EndTime>06:00:00</EndTime></Shift>
            <Shift ID="E"><Label>E</Label><Name>Evening</Name><StartTime>12:00:00</StartTime><EndTime>20:00:00</EndTime></Shift>
            <Shift ID="D"><Label>D</Label><Name>Day</Name><StartTime>06:00:00</StartTime><EndTime>16:00:00</EndTime></Shift>
            <Shift ID="O"><Label>O</Label><Name>Other</Name><StartTime>06:00:00</StartTime><EndTime>18:00:00</EndTime><AutoAllocate>false</AutoAllocate></Shift>
          </ShiftTypes>
          <ShiftGroups><ShiftGroup ID="On"><Shift>N</Shift><Shift>E</Shift><Shift>D</Shift><Shift>O</Shift></ShiftGroup></ShiftGroups>
          <Contracts>
            <Contract ID="C1">
              <Patterns>
                <Match><Max><Count>0</Count></Max><Pattern><Shift>N</Shift><Shift>N</Shift><Shift>N</Shift></Pattern></Match>
                <Match><Max><Count>0</Count></Max><Pattern><Shift>E</Shift><Shift>D</Shift></Pattern></Match>
              </Patterns>
            </Contract>
          </Contracts>
          <Employees>
            <Employee ID="E1"><ContractID>C1</ContractID></Employee>
            <Employee ID="E2"><ContractID>C1</ContractID></Employee>
            <Employee ID="E3"><ContractID>C1</ContractID></Employee>
            <Employee ID="E4"><ContractID>C1</ContractID></Employee>
            <Employee ID="E5"><ContractID>C1</ContractID></Employee>
            <Employee ID="E6"><ContractID>C1</ContractID></Employee>
            <Employee ID="E7"><ContractID>C1</ContractID></Employee>
            <Employee ID="E8"><ContractID>C1</ContractID></Employee>
          </Employees>
          <CoverRequirements>
            <DayOfWeekCover><Day>Monday</Day><Cover><Shift>D</Shift><Min>2</Min><Max>3</Max></Cover><Cover><Shift>E</Shift><Min>1</Min><Max>1</Max></Cover><Cover><Shift>N</Shift><Min>1</Min><Max>1</Max></Cover></DayOfWeekCover>
            <DayOfWeekCover><Day>Tuesday</Day><Cover><Shift>D</Shift><Min>2</Min><Max>3</Max></Cover><Cover><Shift>E</Shift><Min>1</Min><Max>1</Max></Cover><Cover><Shift>N</Shift><Min>1</Min><Max>1</Max></Cover></DayOfWeekCover>
            <DayOfWeekCover><Day>Wednesday</Day><Cover><Shift>D</Shift><Min>2</Min><Max>3</Max></Cover><Cover><Shift>E</Shift><Min>1</Min><Max>1</Max></Cover><Cover><Shift>N</Shift><Min>1</Min><Max>1</Max></Cover></DayOfWeekCover>
            <DayOfWeekCover><Day>Thursday</Day><Cover><Shift>D</Shift><Min>2</Min><Max>3</Max></Cover><Cover><Shift>E</Shift><Min>1</Min><Max>1</Max></Cover><Cover><Shift>N</Shift><Min>1</Min><Max>1</Max></Cover></DayOfWeekCover>
            <DayOfWeekCover><Day>Friday</Day><Cover><Shift>D</Shift><Min>2</Min><Max>3</Max></Cover><Cover><Shift>E</Shift><Min>1</Min><Max>1</Max></Cover><Cover><Shift>N</Shift><Min>1</Min><Max>1</Max></Cover></DayOfWeekCover>
            <DayOfWeekCover><Day>Saturday</Day><Cover><Shift>D</Shift><Min>2</Min><Max>3</Max></Cover><Cover><Shift>E</Shift><Min>1</Min><Max>1</Max></Cover><Cover><Shift>N</Shift><Min>1</Min><Max>1</Max></Cover></DayOfWeekCover>
            <DayOfWeekCover><Day>Sunday</Day><Cover><Shift>D</Shift><Min>2</Min><Max>3</Max></Cover><Cover><Shift>E</Shift><Min>1</Min><Max>1</Max></Cover><Cover><Shift>N</Shift><Min>1</Min><Max>1</Max></Cover></DayOfWeekCover>
          </CoverRequirements>
          <FixedAssignments>
            <Employee><EmployeeID>E1</EmployeeID><Assign><Shift>O</Shift><Date>2026-11-10</Date></Assign></Employee>
          </FixedAssignments>
        </SchedulingPeriod>
    """)
    ros_file = tmp_path / "Mini3Shift.ros"
    ros_file.write_text(xml)
    inst = convert.from_ros(ros_file, keep_shift_types=True)
    req = inst["request"]
    st_by = {s["id"]: s for s in req["shift_types"]}
    assert set(st_by) == {"N", "E", "D", "O"}
    assert st_by["O"]["counts"] is False
    assert st_by["N"]["next_day"] == "なし"
    assert req["fixed"]["E1"][10] == "O"
    assert any(r["pattern"] == [{"ids": ["N"]}, {"ids": ["N"]}, {"ids": ["N"]}] for r in req["rules"])

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    (out_dir / "Mini3Shift.json").write_text(json.dumps(inst, ensure_ascii=False))
    summary = dropped_summary.summarize(out_dir)
    assert summary.collapsed_shifts.files == 0

    res = solve_inline(InlineSolveIn.model_validate(req))
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    assert res["cells"]["E1"][9] == "O"
    assert bench_check.check(req, res, inst["meta"])["hard"] == {}


# ---------------------------------------------------------------- T5: 11区分 + counts=False + need_by_group


def test_eleven_shift_types_with_non_counting_and_need_by_group():
    shift_types = [
        {"id": "D", "name": "日勤", "short": "D", "start": "08:00", "end": "16:00", "break_min": 0, "group": "日勤系", "counts": True, "next_day": "なし"},
        {"id": "D+", "name": "日勤リーダー", "short": "D+", "start": "08:00", "end": "16:00", "break_min": 0, "group": "日勤系", "counts": True, "next_day": "なし"},
        {"id": "E", "name": "準夜", "short": "E", "start": "16:00", "end": "24:00", "break_min": 0, "group": "その他", "counts": True, "next_day": "なし"},
        {"id": "E+", "name": "準夜リーダー", "short": "E+", "start": "16:00", "end": "24:00", "break_min": 0, "group": "その他", "counts": True, "next_day": "なし"},
        {"id": "N", "name": "深夜", "short": "N", "start": "00:00", "end": "08:00", "break_min": 0, "group": "夜勤系", "counts": True, "next_day": "なし"},
        {"id": "N+", "name": "深夜リーダー", "short": "N+", "start": "00:00", "end": "08:00", "break_min": 0, "group": "夜勤系", "counts": True, "next_day": "なし"},
        {"id": "A", "name": "管理", "short": "A", "start": "08:00", "end": "16:00", "break_min": 0, "group": "その他", "counts": False, "next_day": "なし"},
        {"id": "D~", "name": "日勤新人", "short": "D~", "start": "08:00", "end": "16:00", "break_min": 0, "group": "日勤系", "counts": False, "next_day": "なし"},
        {"id": "E~", "name": "準夜新人", "short": "E~", "start": "16:00", "end": "24:00", "break_min": 0, "group": "その他", "counts": False, "next_day": "なし"},
        {"id": "N~", "name": "深夜新人", "short": "N~", "start": "00:00", "end": "08:00", "break_min": 0, "group": "夜勤系", "counts": False, "next_day": "なし"},
        {"id": "K", "name": "研修", "short": "K", "start": "08:00", "end": "16:00", "break_min": 0, "group": "日勤系", "counts": False, "next_day": "なし"},
    ]
    staff = []
    # Day 6人 (うち Senior 2人), Evening 6人 (うち Senior 2人), Student 2人
    for i in range(6):
        sh = ["D", "D+"] if i < 2 else ["D"]
        if i == 0:
            sh.append("K")
        staff.append({"staff_id": f"D{i + 1}", "role": "看護師", "employment": "常勤", "skills": ["medical"], "shifts": sh})
    for i in range(6):
        sh = ["E", "E+"] if i < 2 else ["E"]
        staff.append({"staff_id": f"E{i + 1}", "role": "看護師", "employment": "常勤", "skills": ["medical"], "shifts": sh})
    staff.append({"staff_id": "ST1", "role": "学生", "employment": "常勤", "skills": ["medical"], "shifts": ["D~"]})
    staff.append({"staff_id": "ST2", "role": "学生", "employment": "常勤", "skills": ["medical"], "shifts": ["E~"]})

    req = {
        "month": "2026-11",
        "days": 30,
        "first_weekday": 0,
        "shift_types": shift_types,
        "staff": staff,
        "need_per_shift": {"D+": 1, "E+": 1},
        "need_by_group": {"日勤系": 3, "その他": 3},
        "need_mode": "min",
        "fixed": {"D1": {5: "K"}, "ST1": {5: "D~"}},
        "time_limit": 8,
    }
    res = solve_inline(InlineSolveIn.model_validate(req))
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    cells = res["cells"]
    # 5日目は D1=K, ST1=D~（両方 counts=False）でも、D + D+ が 3人以上いること
    assert cells["D1"][4] == "K" and cells["ST1"][4] == "D~"
    assert sum(1 for row in cells.values() if row[4] in ("D", "D+")) >= 3
    assert bench_check.check(req, res)["hard"] == {}


# ---------------------------------------------------------------- T6: 72時間ルール


def test_ward_night_avg_72h_over_limit_12_nurse_ward():
    # 12人病棟（師長1人・夜勤可11人）、3交代で準夜2・深夜2を毎日（30日）
    # 準 16:30-01:15 -> 16:00-08:00 重なり 8.75h, 深 00:30-09:15 -> 重なり 7.5h
    # 合計 = (2*8.75 + 2*7.5) * 30 = 975h / 11人 = 88.64h > 72h
    staff = _mk_staff(12, ["日", "準", "深"], leader_shifts=["日"])
    req = {
        "month": "2026-11",
        "days": 30,
        "first_weekday": 0,
        "shift_types": THREE_SHIFTS,
        "staff": staff,
        "need_per_shift": {"日": 2, "準": 2, "深": 2},
        "night_max": 12,
        "ward_night_avg_max": 72,
        "night_window": {"start": "16:00", "hours": 16},
        "night_worker_min_h": 16,
        "time_limit": 10,
    }
    res = solve_inline(InlineSolveIn.model_validate(req))
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    assert any(b["rule_id"] == "r-ward-night-avg" for b in res["soft_broken"])
    assert any("月平均夜勤時間" in line and "72時間" in line for line in res["explanation"])
    chk = bench_check.check(req, res)
    assert chk["hard"] == {}
    stats = chk["night_avg_stats"]
    assert stats is not None
    assert stats["workers"] == 11
    assert abs(stats["total_h"] - 975.0) < 0.01
    assert abs(stats["avg_h"] - (975.0 / 11.0)) < 0.05
    assert stats["excess_h"] > 16.0


def test_ward_night_avg_excludes_under_16h_worker():
    # 準(8.75h)を1回だけ入った職員（8.75h < 16h）は分母にも分子にも入らない
    staff = _mk_staff(10, ["日", "準", "深"])
    # S001 は準を1回だけ（8.75h < 16h）に制限し、他9人で残りを担当
    staff[0]["limits"] = [{"shifts": ["準", "深"], "at_least": 1, "at_most": 1}]
    req = {
        "month": "2026-11",
        "days": 30,
        "first_weekday": 0,
        "shift_types": THREE_SHIFTS,
        "staff": staff,
        "need_per_shift": {"日": 2, "準": 1, "深": 1},
        "night_max": 10,
        "ward_night_avg_max": 72,
        "night_window": {"start": "16:00", "hours": 16},
        "night_worker_min_h": 16,
        "time_limit": 10,
    }
    res = solve_inline(InlineSolveIn.model_validate(req))
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    chk = bench_check.check(req, res)
    stats = chk["night_avg_stats"]
    assert stats is not None
    # S001 の夜勤時間は 7.5h または 8.75h (< 16h) なので分母は 9人以下、分子からも除外される
    s001_h = sum(8.75 if x == "準" else (7.5 if x == "深" else 0.0) for x in res["cells"]["S001"])
    assert 0 < s001_h < 16.0
    total_all = (8.75 + 7.5) * 30
    assert stats["workers"] <= 9
    assert abs(stats["total_h"] - (total_all - s001_h)) < 0.01 or stats["workers"] < 9
