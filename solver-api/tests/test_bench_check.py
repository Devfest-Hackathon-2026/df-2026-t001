"""bench.check と bench.convert の P2（曜日別必要人数・祝日）テスト。"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from bench.check import check
from bench.convert import from_ros, from_txt


def _req(**kw) -> dict:
    base = {
        "month": "2026-11",  # 2026-11-01 は日曜、30日間
        "staff": [{"staff_id": f"S{i}", "employment": "常勤", "shifts": ["早番", "日勤", "遅番", "夜勤"]} for i in range(1, 11)],
        "need_per_shift": {"早番": 0, "日勤": 4, "遅番": 0, "夜勤": 0},
        "extra": {},
    }
    base.update(kw)
    return base


def _res(counts_by_day: list[int], shift: str = "日勤", staff_n: int = 10) -> dict:
    cells = {f"S{i}": [""] * len(counts_by_day) for i in range(1, staff_n + 1)}
    for d_idx, c in enumerate(counts_by_day):
        offset = 5 if (d_idx // 4) % 2 else 0
        for i in range(c):
            sid = f"S{((offset + i) % staff_n) + 1}"
            cells[sid][d_idx] = shift
    return {"status": "OPTIMAL", "days": len(counts_by_day), "wall_ms": 10, "app_labor_rules": True, "cells": cells}


def test_check_without_weekday_or_holidays() -> None:
    req = _req(extra={"2026-11-02": {"日勤": 2}})
    counts = [4] * 30
    counts[1] = 6  # 2日は +2
    r_ok = check(req, _res(counts))
    assert r_ok["hard"] == {}

    counts_bad = list(counts)
    counts_bad[0] = 3  # 1日は 4 未満
    r_ng = check(req, _res(counts_bad))
    assert r_ng["hard"].get("人数不足（必要人数の下限）") == 1


def test_check_need_by_weekday_and_holidays() -> None:
    # 2026-11-01(日)=0 .. 2026-11-07(土)=6。3日(火)を祝日に指定すると日曜(3人)を使う
    req = _req(
        need_per_shift={"早番": 0, "日勤": 3, "遅番": 0, "夜勤": 0},
        need_by_weekday={"日勤": [3, 5, 5, 5, 5, 5, 3]},
        holidays=[3],
    )
    expected = [
        3 if (d in (3,) or (date(2026, 11, d).isoweekday() % 7) in (0, 6)) else 5
        for d in range(1, 31)
    ]
    assert check(req, _res(expected))["hard"] == {}

    # 平日(2日=月)を3人に減らすと不足
    short_weekday = list(expected)
    short_weekday[1] = 3
    assert check(req, _res(short_weekday))["hard"].get("人数不足（必要人数の下限）") == 1

    # 土曜(7日)を5人に増やすと過剰
    over_sat = list(expected)
    over_sat[6] = 5
    assert check(req, _res(over_sat))["hard"].get("人数過剰（必要人数の上限）") == 1

    # 祝日(3日=火)を平日並み5人にすると過剰
    over_hol = list(expected)
    over_hol[2] = 5
    assert check(req, _res(over_hol))["hard"].get("人数過剰（必要人数の上限）") == 1


def test_check_need_by_weekday_zero_and_extra() -> None:
    req = _req(
        need_per_shift={"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0},
        need_by_weekday={"早番": [0, 2, 2, 2, 2, 2, 0]},
        extra={"2026-11-02": {"早番": 1}},  # 2日(月)は 2〜3 人まで可
    )
    counts = [0 if (date(2026, 11, d).isoweekday() % 7) in (0, 6) else 2 for d in range(1, 31)]
    counts[1] = 3  # extra 上乗せ範囲内
    assert check(req, _res(counts, shift="早番"))["hard"] == {}

    # 土曜(7日)に1人置くと 0 の上限を超過
    bad_sat = list(counts)
    bad_sat[6] = 1
    assert check(req, _res(bad_sat, shift="早番"))["hard"].get("人数過剰（必要人数の上限）") == 1


def _write_ros_with_dow(path: Path, counts_by_name: dict[str, int], start: str = "2026-11-01", end: str = "2026-11-30") -> None:
    dow_xml = "\n".join(
        f"    <DayOfWeekCover><Day>{day}</Day><Cover><Shift>D</Shift><Min>{n}</Min></Cover></DayOfWeekCover>"
        for day, n in counts_by_name.items()
    )
    emp_xml = "\n".join(f'    <Employee ID="E{i}" />' for i in range(1, 11))
    path.write_text(
        f"""<?xml version="1.0" encoding="utf-8"?>
<SchedulingPeriod>
  <StartDate>{start}</StartDate>
  <EndDate>{end}</EndDate>
  <ShiftTypes>
    <Shift ID="D"><StartTime>08:30:00</StartTime><EndTime>17:30:00</EndTime></Shift>
  </ShiftTypes>
  <Employees>
{emp_xml}
  </Employees>
  <CoverRequirements>
{dow_xml}
  </CoverRequirements>
</SchedulingPeriod>
"""
    )


def test_convert_from_ros_emits_need_by_weekday(tmp_path: Path) -> None:
    p = tmp_path / "DowSample.ros"
    _write_ros_with_dow(
        p,
        {"Sunday": 3, "Monday": 5, "Tuesday": 5, "Wednesday": 5, "Thursday": 5, "Friday": 5, "Saturday": 3},
    )
    inst = from_ros(p)
    req = inst["request"]
    assert req["need_by_weekday"] == {"日勤": [3, 5, 5, 5, 5, 5, 3]}
    assert req["extra"] == {}

    # 変換対象月の初日がソース開始日の曜日とずれる場合も、対象月の曜日に合わせて並ぶこと
    p_shift = tmp_path / "ShiftedStart.ros"
    # 2025-01-01(水)〜30日 -> target month 2026-11 (day 1 は日曜)
    _write_ros_with_dow(
        p_shift,
        {"Sunday": 2, "Monday": 4, "Tuesday": 4, "Wednesday": 6, "Thursday": 4, "Friday": 4, "Saturday": 2},
        start="2025-01-01",
        end="2025-01-30",
    )
    inst_shift = from_ros(p_shift)
    req_shift = inst_shift["request"]
    assert req_shift["month"] == "2026-11"
    # 2026-11 の各曜日(0=日..6=土) に対応するソース曜日の値が並んでいること
    src_start = date(2025, 1, 1)
    by_src_wd = {0: 2, 1: 4, 2: 4, 3: 6, 4: 4, 5: 4, 6: 2}
    expected_wd = [
        by_src_wd[(src_start + timedelta(days=d)).isoweekday() % 7]
        for d in range(7)  # 2026-11-01(日)〜07(土)
    ]
    assert req_shift["need_by_weekday"] == {"日勤": expected_wd}
    assert req_shift["extra"] == {}


def test_convert_from_ros_omits_need_by_weekday_when_uniform(tmp_path: Path) -> None:
    p = tmp_path / "Uniform.ros"
    _write_ros_with_dow(
        p,
        {day: 4 for day in ("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")},
    )
    inst = from_ros(p)
    assert "need_by_weekday" not in inst["request"]


def test_check_limits_none_keeps_existing_output_keys() -> None:
    res = check(_req(), _res([4] * 30))
    assert "limit_max_checked" not in res
    assert "limit_min_unmet" not in res


def test_check_limits_hard_max_soft_min_and_common_override() -> None:
    # 30 日間で S1 は 9 回夜勤（個人上限 10 -> 共通 night_max=8 を超えても違反にしない）、
    # S2 は 23 日勤務（常勤・個人上限 24 -> 共通公休 8 日未満にしない）、
    # S3 は上限 2 超過と下限 15 未達
    staff = [
        {"staff_id": "S1", "employment": "常勤", "shifts": ["日勤", "夜勤"], "limits": [{"shifts": ["夜勤"], "at_most": 10}]},
        {"staff_id": "S2", "employment": "常勤", "shifts": ["日勤"], "limits": [{"shifts": None, "at_most": 24}]},
        {"staff_id": "S3", "employment": "パート", "shifts": ["日勤"], "limits": [{"shifts": None, "at_least": 15, "at_most": 2}]},
        {"staff_id": "S4", "employment": "パート", "shifts": ["日勤"], "limits": [{"shifts": None, "unit": "時間", "at_most": 24}]},
    ]
    req = _req(
        staff=staff,
        need_per_shift={"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0},
        night_max=8,
    )
    cells = {s["staff_id"]: [""] * 30 for s in staff}
    # S1: 3日に1回夜勤を 9 回（夜勤+明け+公休 の3日周期で連勤5日以内）
    for d_idx in range(0, 27, 3):
        cells["S1"][d_idx] = "夜勤"
    # S2: 4連勤+1休パターンで 23 日日勤（連続勤務5日以内）
    for d_idx in range(30):
        if d_idx % 5 != 4 and sum(1 for x in cells["S2"] if x) < 23:
            cells["S2"][d_idx] = "日勤"
    # S3: 3日勤務（at_most=2 超過・at_least=15 未達）
    for d_idx in (0, 1, 2):
        cells["S3"][d_idx] = "日勤"
    # S4: 4日勤務 = 32時間（at_most=24時間 超過）
    for d_idx in (0, 1, 2, 3):
        cells["S4"][d_idx] = "日勤"

    res_obj = {"status": "OPTIMAL", "days": 30, "wall_ms": 10, "app_labor_rules": True, "cells": cells}
    out = check(req, res_obj)
    assert out["limit_max_checked"] == 4
    assert out["limit_min_unmet"] == [1, 1]
    assert out["hard"].get("個人の上限を超えた") == 2
    assert "夜勤が上限8回を超えた" not in out["hard"]
    assert "常勤の公休が8日未満" not in out["labor"]

    # 上限内に収まる S1, S2 だけなら hard={}・labor={}
    req_ok = _req(
        staff=staff[:2],
        need_per_shift={"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0},
        extra={f"2026-11-{d:02d}": {"日勤": 1, "夜勤": 1} for d in range(1, 31)},
        night_max=8,
    )
    out_ok = check(req_ok, {"status": "OPTIMAL", "days": 30, "wall_ms": 10, "app_labor_rules": True, "cells": {"S1": cells["S1"], "S2": cells["S2"]}})
    assert out_ok["hard"] == {}
    assert out_ok["labor"] == {}
    assert out_ok["limit_max_checked"] == 2
    assert out_ok["limit_min_unmet"] == [0, 0]


def test_convert_from_txt_extracts_max_shifts_limits(tmp_path: Path) -> None:
    p = tmp_path / "SampleTxt.txt"
    p.write_text(
        """SECTION_HORIZON
14
SECTION_SHIFTS
D1,480,
D2,480,
N,600,
SECTION_STAFF
A,D1=5|D2=4|N=2,4320,3360,5,2,2,1
B,D1=14|D2=14|N=0,4320,3360,5,2,2,1
SECTION_DAYS_OFF
A,0
SECTION_COVER
0,D1,1
"""
    )
    inst = from_txt(p)
    staff = {s["staff_id"]: s for s in inst["request"]["staff"]}
    # H=14 -> N=28 にスケール (x2): D1+D2=9 -> 18, N=2 -> 4
    assert staff["A"]["limits"] == [
        {"shifts": ["日勤"], "at_most": 18},
        {"shifts": ["夜勤"], "at_most": 4},
    ]
    # B は 日勤上限 28 >= N (無制限相当) かつ 夜勤 0 (shifts 自体が不可) なので limits なし
    assert "limits" not in staff["B"]
    assert all("勤務回数" not in msg for msg in inst["meta"]["dropped"])
    assert any("時間" in msg for msg in inst["meta"]["dropped"])


def test_convert_from_ros_extracts_count_contracts(tmp_path: Path) -> None:
    p = tmp_path / "RosCounts.ros"
    p.write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<SchedulingPeriod>
  <StartDate>2026-11-01</StartDate>
  <EndDate>2026-11-30</EndDate>
  <ShiftTypes>
    <Shift ID="D"><StartTime>08:30:00</StartTime><EndTime>17:30:00</EndTime></Shift>
    <Shift ID="N"><StartTime>17:00:00</StartTime><EndTime>09:00:00</EndTime></Shift>
  </ShiftTypes>
  <ShiftGroups>
    <ShiftGroup ID="All"><Shift>D</Shift><Shift>N</Shift></ShiftGroup>
  </ShiftGroups>
  <Contracts>
    <Contract ID="C1">
      <Patterns>
        <Match><Max><Count>20</Count><Weight>100</Weight></Max><Pattern><Shift>$</Shift></Pattern></Match>
        <Match><Min><Count>9</Count><Weight>100</Weight></Min><Max><Count>14</Count><Weight>100</Weight></Max><Pattern><Shift>-</Shift></Pattern></Match>
        <Match><Min><Count>3</Count><Weight>100</Weight></Min><Max><Count>6</Count><Weight>100</Weight></Max><Pattern><Shift>N</Shift></Pattern></Match>
        <Match><Max><Count>12</Count><Weight>100</Weight></Max><Pattern><Shift>D</Shift></Pattern></Match>
      </Patterns>
    </Contract>
  </Contracts>
  <Employees>
    <Employee ID="E1"><ContractID>C1</ContractID></Employee>
  </Employees>
  <CoverRequirements>
    <DayOfWeekCover><Day>Monday</Day><Cover><Shift>D</Shift><Min>1</Min></Cover></DayOfWeekCover>
  </CoverRequirements>
</SchedulingPeriod>
"""
    )
    inst = from_ros(p)
    lims = inst["request"]["staff"][0]["limits"]
    assert {"shifts": None, "at_least": 16, "at_most": 20} in lims
    assert {"shifts": ["夜勤"], "at_least": 3, "at_most": 6} in lims
    assert {"shifts": ["日勤"], "at_most": 12} in lims
    assert all("個人ごとの" not in msg and "契約" not in msg for msg in inst["meta"]["dropped"])

    p_wl = tmp_path / "RosWorkload.ros"
    p_wl.write_text(p.read_text().replace("<Patterns>", "<Workload><TimeUnits><Max><Count>150</Count></Max></TimeUnits></Workload>\n      <Patterns>"))
    inst_wl = from_ros(p_wl)
    assert any("Workload" in msg for msg in inst_wl["meta"]["dropped"])


def test_check_p4_keeps_existing_keys_and_checks_fixed_wish_avoid() -> None:
    base_out = check(_req(), _res([4] * 30))
    assert "fixed_checked" not in base_out
    assert "shift_wish" not in base_out
    assert "shift_avoid" not in base_out

    req = _req(
        need_per_shift={"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0},
        extra={f"2026-11-{d:02d}": {"日勤": 10, "早番": 10} for d in range(1, 31)},
        fixed={"S1": {1: "日勤", "5": "休"}},
        shift_wish={"S2": {1: "早番", 2: "勤務", 3: "日勤"}},
        shift_avoid={"S3": {1: ["日勤", "遅番"], 2: ["日勤"]}},
    )
    cells = {f"S{i}": [""] * 30 for i in range(1, 11)}
    cells["S1"][0] = "日勤"  # 固定どおり
    cells["S1"][4] = ""      # 5日 = 休（固定どおり）
    cells["S2"][0] = "早番"  # wish 達成
    cells["S2"][1] = "日勤"  # wish "勤務" 達成
    cells["S2"][2] = ""      # wish 未達
    cells["S3"][0] = "早番"  # avoid 達成
    cells["S3"][1] = "日勤"  # avoid 未達

    out = check(req, {"status": "OPTIMAL", "days": 30, "wall_ms": 10, "app_labor_rules": True, "cells": cells})
    assert out["hard"] == {}
    assert out["fixed_checked"] == 2
    assert out["shift_wish"] == [2, 3]
    assert out["shift_avoid"] == [1, 2]

    # 固定が破られた場合
    bad_cells = {k: list(v) for k, v in cells.items()}
    bad_cells["S1"][4] = "日勤"
    out_bad = check(req, {"status": "OPTIMAL", "days": 30, "wall_ms": 10, "app_labor_rules": True, "cells": bad_cells})
    assert out_bad["hard"].get("固定の割り当てを守れていない") == 1


def test_convert_from_txt_extracts_shift_wish_and_avoid(tmp_path: Path) -> None:
    p = tmp_path / "TxtWishAvoid.txt"
    p.write_text(
        """SECTION_HORIZON
14
SECTION_SHIFTS
D,480,
N,600,
SECTION_STAFF
A,D=14|N=14,4320,3360,5,2,2,1
SECTION_DAYS_OFF
A,0
SECTION_SHIFT_ON_REQUESTS
A,1,D,2
A,1,N,5
A,3,D,3
SECTION_SHIFT_OFF_REQUESTS
A,2,N,1
A,2,D,1
SECTION_COVER
0,D,1
"""
    )
    inst = from_txt(p)
    req = inst["request"]
    # 14日を繰り返して 28 日になるので 2 日目(index 1) と 16 日目(index 15) に重み最大の 夜勤 が入る
    assert req["shift_wish"]["A"][2] == "夜勤"
    assert req["shift_wish"]["A"][16] == "夜勤"
    assert req["shift_wish"]["A"][4] == "日勤"
    assert sorted(req["shift_avoid"]["A"][3]) == ["夜勤", "日勤"]
    assert all("ShiftOn" not in msg and "ShiftOff" not in msg for msg in inst["meta"]["dropped"])


def test_convert_from_ros_extracts_wish_avoid_and_fixed(tmp_path: Path) -> None:
    p = tmp_path / "RosP4.ros"
    p.write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<SchedulingPeriod>
  <StartDate>2026-11-01</StartDate>
  <EndDate>2026-11-30</EndDate>
  <ShiftTypes>
    <Shift ID="D"><StartTime>08:30:00</StartTime><EndTime>17:30:00</EndTime></Shift>
    <Shift ID="N"><StartTime>17:00:00</StartTime><EndTime>09:00:00</EndTime></Shift>
  </ShiftTypes>
  <Employees>
    <Employee ID="E1" />
    <Employee ID="E2" />
  </Employees>
  <CoverRequirements>
    <DayOfWeekCover><Day>Monday</Day><Cover><Shift>D</Shift><Min>1</Min></Cover></DayOfWeekCover>
  </CoverRequirements>
  <ShiftOnRequests>
    <ShiftOn weight="10"><ShiftTypeID>D</ShiftTypeID><EmployeeID>E1</EmployeeID><Date>2026-11-02</Date></ShiftOn>
    <ShiftOn weight="5"><ShiftTypeID>O</ShiftTypeID><EmployeeID>E2</EmployeeID><Date>2026-11-03</Date></ShiftOn>
  </ShiftOnRequests>
  <DayOnRequests>
    <DayOn weight="10"><EmployeeID>E1</EmployeeID><Date>2026-11-04</Date></DayOn>
    <DayOn weight="1"><EmployeeID>E1</EmployeeID><Date>2026-11-02</Date></DayOn>
  </DayOnRequests>
  <ShiftOffRequests>
    <ShiftOff weight="10"><ShiftTypeID>N</ShiftTypeID><EmployeeID>E1</EmployeeID><Date>2026-11-05</Date></ShiftOff>
    <ShiftOff weight="10"><ShiftTypeID>O</ShiftTypeID><EmployeeID>E2</EmployeeID><Date>2026-11-06</Date></ShiftOff>
  </ShiftOffRequests>
  <FixedAssignments>
    <Employee>
      <EmployeeID>E1</EmployeeID>
      <Assign><Date>2026-11-10</Date><Shift>D</Shift></Assign>
      <Assign><Date>2026-11-11</Date><Shift>-</Shift></Assign>
    </Employee>
  </FixedAssignments>
</SchedulingPeriod>
"""
    )
    inst = from_ros(p)
    req = inst["request"]
    assert req["shift_wish"]["E1"][2] == "日勤"   # ShiftOn が DayOn より優先
    assert req["shift_wish"]["E1"][4] == "勤務"   # DayOn -> 勤務
    assert req["day_off"]["E2"] == [3]            # ShiftOn(O) -> day_off
    assert req["shift_avoid"]["E1"][5] == ["夜勤"]
    assert req["shift_wish"]["E2"][6] == "勤務"   # ShiftOff(O) -> 勤務
    assert req["fixed"]["E1"] == {10: "日勤", 11: "休"}
    assert all(
        all(tok not in msg for tok in ("ShiftOn", "ShiftOff", "DayOn", "期間中の固定"))
        for msg in inst["meta"]["dropped"]
    )


def test_check_p5_history_consecutive_run_and_ake() -> None:
    req_base = _req(
        need_per_shift={"早番": 0, "日勤": 0, "遅番": 0, "夜勤": 0},
        extra={f"2026-11-{d:02d}": {"日勤": 10, "早番": 10} for d in range(1, 31)},
    )
    cells = {f"S{i}": [""] * 30 for i in range(1, 11)}

    # S1: 前月末4連勤 -> 1日目勤務・2日目休みは OK、1日目・2日目ともに勤務すると5連勤超過
    req1 = dict(
        req_base,
        history={
            "S1": ["", "日勤", "日勤", "日勤", "日勤"],
            "S2": ["日勤", "日勤", "夜勤", ""],  # 明け含め4連続 (pre_cov=[1,1,1,1])
            "S3": ["遅番"],
        },
        carry_in={"S2": "夜勤"},  # history がある場合は history が優先される
    )
    ok_cells = {k: list(v) for k, v in cells.items()}
    ok_cells["S1"][0] = "日勤"  # 5日目
    ok_cells["S2"][0] = "日勤"  # 夜勤・明けの翌日は勤務 OK（5日目）
    ok_cells["S3"][0] = "日勤"
    ok_out = check(req1, {"status": "OPTIMAL", "days": 30, "wall_ms": 10, "app_labor_rules": True, "cells": ok_cells})
    assert ok_out["hard"] == {}
    assert ok_out["labor"] == {}

    bad_cells = {k: list(v) for k, v in ok_cells.items()}
    bad_cells["S1"][1] = "日勤"  # 6連勤
    bad_cells["S2"][1] = "日勤"  # 明けを含めて6連続（実勤務は2連勤なので hard ではなく labor のみ）
    bad_cells["S3"][0] = "早番"  # 遅番の翌日に早番
    bad_out = check(req1, {"status": "OPTIMAL", "days": 30, "wall_ms": 10, "app_labor_rules": True, "cells": bad_cells})
    assert bad_out["hard"].get("連続勤務が5日を超えた") == 1
    assert bad_out["hard"].get("遅番の翌日に早番") == 1
    assert bad_out["labor"].get("明けを含めた連勤が5日を超えた") == 2

    # carry_in だけ（history なし）なら 1〜5日目勤務しても既存判定と変わらない
    req_carry_only = dict(req_base, carry_in={"S1": "遅番"})
    carry_cells = {k: list(v) for k, v in cells.items()}
    for d_idx in range(5):
        carry_cells["S1"][d_idx] = "日勤"
    out_carry = check(req_carry_only, {"status": "OPTIMAL", "days": 30, "wall_ms": 10, "app_labor_rules": True, "cells": carry_cells})
    assert out_carry["hard"] == {}
    assert out_carry["labor"] == {}


def test_convert_from_ros_extracts_history_up_to_7_days(tmp_path: Path) -> None:
    p = tmp_path / "RosHistory.ros"
    spec_xml = "\n".join(
        f"    <DateSpecificCover><Date>2026-11-{d:02d}</Date><Cover><Shift>D</Shift><Min>1</Min></Cover></DateSpecificCover>"
        for d in range(1, 31)
    )
    # 10/23〜10/31 の 9日分の期間前割り当て → 末尾7日 (10/25〜10/31) だけを古い順に取り出す
    pre = [
        ("2026-10-23", "D"),
        ("2026-10-24", "D"),
        ("2026-10-25", "N"),
        ("2026-10-26", "-"),
        ("2026-10-27", "D"),
        ("2026-10-28", "O"),
        ("2026-10-29", "D"),
        ("2026-10-30", "N"),
        ("2026-10-31", "D"),
    ]
    pre_xml = "\n".join(f"      <Assign><Date>{ds}</Date><Shift>{sh}</Shift></Assign>" for ds, sh in pre)
    p.write_text(
        f"""<?xml version="1.0" encoding="utf-8"?>
<SchedulingPeriod>
  <StartDate>2026-10-22</StartDate>
  <EndDate>2026-11-30</EndDate>
  <ShiftTypes>
    <Shift ID="D"><StartTime>08:30:00</StartTime><EndTime>17:30:00</EndTime></Shift>
    <Shift ID="N"><StartTime>17:00:00</StartTime><EndTime>09:00:00</EndTime></Shift>
  </ShiftTypes>
  <Employees>
    <Employee ID="E1" />
  </Employees>
  <CoverRequirements>
{spec_xml}
  </CoverRequirements>
  <FixedAssignments>
    <Employee>
      <EmployeeID>E1</EmployeeID>
{pre_xml}
    </Employee>
  </FixedAssignments>
</SchedulingPeriod>
"""
    )
    inst = from_ros(p)
    req = inst["request"]
    assert req["history"] == {"E1": ["夜勤", "", "日勤", "", "日勤", "夜勤", "日勤"]}
    assert req["carry_in"] == {"E1": "日勤"}

    # 期間前割り当てが無ければ history は出ない
    p_no_hist = tmp_path / "RosNoHist.ros"
    _write_ros_with_dow(p_no_hist, {"Monday": 1})
    assert "history" not in from_ros(p_no_hist)["request"]


def test_check_q0_measurement_fields() -> None:
    req = _req(
        staff=[
            {"staff_id": "S1", "employment": "常勤", "shifts": ["日勤", "夜勤"]},
            {"staff_id": "S2", "employment": "常勤", "shifts": ["日勤"]},
            {"staff_id": "S3", "employment": "常勤", "is_leader": True, "shifts": ["日勤"]},
        ],
        need_per_shift={"早番": 0, "日勤": 1, "遅番": 0, "夜勤": 0},
        carry_in={"S1": "夜勤"},
    )
    cells = {
        "S1": [""] + ["日勤"] * 10 + [""] * 19,  # day 1 is ake (not public off), 19 public offs
        "S2": ["日勤"] * 15 + [""] * 15,         # 15 public offs
        "S3": ["日勤"] * 20 + [""] * 10,         # leader -> excluded from full_off_stats
    }
    out = check(req, {"status": "OPTIMAL", "days": 30, "wall_ms": 5, "app_labor_rules": True, "cells": cells})
    assert out["full_off_stats"] == {"min": 15, "max": 19, "avg": 17.0}
    assert out["daily_counts"]["日勤"] == {"min": 0, "max": 3, "over_total": 25}
    assert out["night_range"] == [0, 0]



