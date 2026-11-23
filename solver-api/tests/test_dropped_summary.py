"""bench.dropped_summary の集計・整形ロジックのユニットテスト。"""
from __future__ import annotations

import json
from pathlib import Path

from bench.dropped_summary import format_table, summarize


def _write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1))


def _make_cover(days: int, *, vary_weekday: bool) -> list[dict[str, int]]:
    rows = []
    for i in range(days):
        # 2026-11-01 は日曜。日曜だけ日勤 2、その他は 4 にする
        n = 2 if (vary_weekday and i % 7 == 0) else 4
        rows.append({"早番": 0, "日勤": n, "遅番": 0, "夜勤": 1})
    return rows


def _make_ros(path: Path) -> None:
    path.write_text(
        """<?xml version="1.0" encoding="utf-8"?>
<SchedulingPeriod>
  <StartDate>2026-11-01</StartDate>
  <EndDate>2026-11-30</EndDate>
  <ShiftTypes>
    <Shift ID="D"><StartTime>08:30:00</StartTime><EndTime>17:30:00</EndTime></Shift>
  </ShiftTypes>
  <Employees>
    <Employee ID="E1" />
  </Employees>
  <CoverRequirements>
    <DayOfWeekCover><Day>Monday</Day><Cover><Shift>D</Shift><Min>4</Min></Cover></DayOfWeekCover>
  </CoverRequirements>
  <FixedAssignments>
    <Employee>
      <EmployeeID>E1</EmployeeID>
      <Assign><Date>2026-10-29</Date><Shift>D</Shift></Assign>
      <Assign><Date>2026-10-30</Date><Shift>D</Shift></Assign>
      <Assign><Date>2026-10-31</Date><Shift>D</Shift></Assign>
      <Assign><Date>2026-11-05</Date><Shift>D</Shift></Assign>
    </Employee>
  </FixedAssignments>
</SchedulingPeriod>
"""
    )


def _make_txt(path: Path) -> None:
    path.write_text(
        """SECTION_HORIZON
14
SECTION_SHIFTS
D,480,
SECTION_STAFF
S1,D=10,480,240,5,2,3,2,1
SECTION_DAYS_OFF
S1,0
SECTION_SHIFT_ON_REQUESTS
S1,1,D,2
S1,2,D,2
SECTION_SHIFT_OFF_REQUESTS
S1,3,D,1
SECTION_COVER
0,D,4
1,D,3
"""
    )


def test_p0_state_counts_all_five_categories(tmp_path: Path) -> None:
    req_dir = tmp_path / "req"
    src_dir = tmp_path / "src"
    req_dir.mkdir()
    src_dir.mkdir()

    _make_ros(src_dir / "SampleRos.ros")
    _make_txt(src_dir / "InstanceSample.txt")
    # Instance*.txt と同名の Instance*.ros（Date ではなく Day を使う形式）が並存しても .txt を優先する
    (src_dir / "InstanceSample.ros").write_text(
        "<SchedulingPeriod><CoverRequirements><DateSpecificCover><Day>0</Day></DateSpecificCover></CoverRequirements></SchedulingPeriod>"
    )

    _write_json(
        req_dir / "SampleRos.json",
        {
            "name": "SampleRos",
            "request": {
                "month": "2026-11",
                "staff": [{"staff_id": "E1", "shifts": ["日勤", "夜勤"]}],
                "need_per_shift": {"早番": 0, "日勤": 2, "遅番": 0, "夜勤": 1},
                "extra": {"2026-11-02": {"日勤": 2}},
                "carry_in": {"E1": "日勤"},
            },
            "meta": {
                "days": 30,
                "cover": _make_cover(30, vary_weekday=True),
                "dropped": [
                    "個人ごとの勤務回数・時間・連勤・週末・勤務パターンの契約は使っていない（アプリは全員共通の固定ルール）",
                    "勤務の希望（ShiftOn）は入れる欄が無い（3件）",
                    "この勤務は避けたい（ShiftOff）は入れる欄が無い（5件）",
                    "この日は働きたい（DayOn）は入れる欄が無い（2件）",
                    "期間中の固定の割り当て（7件）は入れる欄が無い",
                ],
            },
        },
    )

    _write_json(
        req_dir / "InstanceSample.json",
        {
            "name": "InstanceSample",
            "request": {
                "month": "2027-02",
                "staff": [{"staff_id": "S1", "shifts": ["日勤"]}],
                "need_per_shift": {"早番": 0, "日勤": 3, "遅番": 0, "夜勤": 0},
                "extra": {},
            },
            "meta": {
                "days": 28,
                "cover": _make_cover(28, vary_weekday=False),
                "dropped": [
                    "個人ごとの勤務回数・時間・連勤・週末の上下限は使っていない（アプリは全員共通の固定ルール）",
                    "勤務の希望（ShiftOn）とこの勤務は避けたい（ShiftOff）は入れる欄が無い",
                ],
            },
        },
    )

    s = summarize(req_dir, src_dir=src_dir)
    assert s.total_files == 2
    assert s.weekday_need.files == 1
    assert s.weekday_need.extra_days == 1
    assert s.contracts.files == 2
    assert s.contracts.count_unhandled == 2
    assert s.contracts.time_only == 0
    # SampleRos: 3+5+2=10, InstanceSample: txt 2+1=3 -> 合計 13
    assert s.shift_requests.files == 2
    assert s.shift_requests.items == 13
    assert s.shift_requests.ros_files == 1
    assert s.shift_requests.txt_files == 1
    assert not s.shift_requests.items_incomplete
    assert s.fixed_in_period.files == 1
    assert s.fixed_in_period.items == 7
    # SampleRos: 10-31 は carry_in 対象のため除外、10-29 と 10-30 の 2 件
    assert s.prev_month_older.files == 1
    assert s.prev_month_older.items == 2
    assert not s.prev_month_older.source_missing

    # src_dir=None でも .ros / .txt の本数内訳と件数欠損フラグを正しく判定する
    s_nosrc = summarize(req_dir, src_dir=None)
    assert s_nosrc.shift_requests.ros_files == 1
    assert s_nosrc.shift_requests.txt_files == 1
    assert s_nosrc.shift_requests.items == 10
    assert s_nosrc.shift_requests.items_incomplete is True
    assert s_nosrc.prev_month_older.source_missing is True

    table = format_table(s)
    assert "曜日ごとの人数" in table
    assert "個人の契約" in table
    assert "勤務の希望・避けたい勤務・働きたい日" in table
    assert "期間中の固定" in table
    assert "前月の2日目以前" in table
    assert "並びのルール" in table
    assert "チーム・技能別の人数" in table


def test_p8_state_after_conditions_added(tmp_path: Path) -> None:
    req_dir = tmp_path / "req"
    src_dir = tmp_path / "src"
    req_dir.mkdir()
    src_dir.mkdir()

    _make_ros(src_dir / "SampleRos.ros")

    _write_json(
        req_dir / "SampleRos.json",
        {
            "name": "SampleRos",
            "request": {
                "month": "2026-11",
                "staff": [{"staff_id": "E1", "shifts": ["日勤", "夜勤"], "limits": [{"shifts": None, "at_most": 20}]}],
                "need_per_shift": {"早番": 0, "日勤": 2, "遅番": 0, "夜勤": 1},
                "need_by_weekday": {"日勤": [2, 4, 4, 4, 4, 4, 4]},
                "extra": {},
                "history": {"E1": ["", "", "", "日勤", "日勤", "日勤"]},
            },
            "meta": {
                "days": 30,
                "cover": _make_cover(30, vary_weekday=True),
                "dropped": [
                    "個人ごとの時間単位の契約は使っていない",
                ],
            },
        },
    )

    s = summarize(req_dir, src_dir=src_dir)
    assert s.total_files == 1
    assert s.weekday_need.files == 0
    assert s.contracts.files == 1
    assert s.contracts.count_unhandled == 0
    assert s.contracts.time_only == 1
    assert s.shift_requests.files == 0
    assert s.shift_requests.items == 0
    assert s.fixed_in_period.files == 0
    assert s.fixed_in_period.items == 0
    # history が 6 日分あるため 10-29, 10-30 もカバー済み
    assert s.prev_month_older.files == 0
    assert s.prev_month_older.items == 0
    assert not s.prev_month_older.source_missing


def test_src_dir_none_marks_source_missing_instead_of_zero(tmp_path: Path) -> None:
    req_dir = tmp_path / "req"
    req_dir.mkdir()

    _write_json(
        req_dir / "NoMetaPrev.json",
        {
            "name": "NoMetaPrev",
            "request": {
                "month": "2026-11",
                "staff": [{"staff_id": "E1", "shifts": ["日勤"]}],
                "need_per_shift": {"早番": 0, "日勤": 4, "遅番": 0, "夜勤": 0},
                "extra": {},
            },
            "meta": {
                "days": 30,
                "cover": _make_cover(30, vary_weekday=False),
                "dropped": [],
            },
        },
    )

    s = summarize(req_dir, src_dir=None)
    assert s.prev_month_older.source_missing is True
    table = format_table(s)
    assert "元データ未参照" in table


def test_q0_counts_sequence_rules_and_skill_cover(tmp_path: Path) -> None:
    req_dir = tmp_path / "req"
    req_dir.mkdir()
    _write_json(
        req_dir / "SeqSkill.json",
        {
            "name": "SeqSkill",
            "request": {
                "month": "2026-11",
                "staff": [{"staff_id": "E1", "shifts": ["日勤"]}],
                "need_per_shift": {"早番": 0, "日勤": 1, "遅番": 0, "夜勤": 0},
                "extra": {},
            },
            "meta": {
                "days": 30,
                "cover": _make_cover(30, vary_weekday=False),
                "dropped": [
                    "連勤・週末・勤務パターンのルールは使っていない（アプリは全員共通の固定ルール）",
                    "スキル別の必要人数は使っていない（勤務帯ごとの合計だけ）",
                ],
            },
        },
    )
    s = summarize(req_dir, src_dir=None)
    assert s.sequence_rules.files == 1
    assert s.skill_cover.files == 1
    table = format_table(s)
    assert "並びのルール" in table
    assert "チーム・技能別の人数" in table
