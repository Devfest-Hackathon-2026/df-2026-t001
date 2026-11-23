"""画面（シフト作成君）から、その施設の職員データをそのまま送って月次シフトを解く。保存しない（ステートレス）。

* Firestore・リポジトリ・Pub/Sub には触れない。リクエストの中身だけで Facility とルールを組み立てて solve_monthly を呼ぶ。
* 名前は受け取らない・ログに出さない。職員は staff_id と属性だけ。
* ルールの数値は defaults.py と同じく「デモ用の仮値」。法令・施設基準の数値ではない。
* defaults.default_rules を土台にし、この経路だけで次を差し替える（合成施設のテストが使う共通の既定値は変えない）。
  - 必要人数: 勤務区分ごとに「ちょうど need 人」（行事の日は need+extra 人まで。追加分は軟制約）
  - 夜勤回数の公平性: 夜勤に入れる人どうしで差を2回以内（強く）
  - 夜勤の医療的ケア: 1フロア1人 = 2人以上（強く）
  - 常勤の勤務日数: 下限は外し（人数が少ない施設では満たせない）、勤務日数の偏りを抑える（強く）
  - 夜勤の上限: 既定は画面の目安と同じ月8回（night_max で変更）
* さらに画面の労務チェック（labor.ts: 夜勤明けも連勤に数える・常勤の公休8日以上）を硬制約で足して先に解く。
  それで解けないときだけ、通常の solve_monthly（解けなければ破れ量つき）に戻す。
"""
from __future__ import annotations

import calendar
import math
import re
import time
from datetime import date
from typing import Annotated, Literal, Union

from ortools.sat.python import cp_model
from pydantic import BaseModel, Field, field_validator, model_validator

from .defaults import default_rules, request_rules
from .dsl import (OFF, PUBLIC_OFF, WORK_SHIFTS, Balance, Count, DaySel, Facility, Lifecycle, Month, MonthlyRule,
                  NightWindow, Occurrence, Origin, PeopleSel, Request, ShiftGroup, ShiftSel, ShiftType, Staffing,
                  StaffMember, Strength, Succession)
from .rule_label import rule_label
from .service import ServiceError
from .solver.explain import explain_monthly
from .solver.monthly import DEFAULT_WORKERS, MonthlyResult, _aggregate, _Build, _cells, solve_monthly, solve_two_stage

_O = Origin(kind="デモ用の仮値", evidence="デモ用の仮値（法令・施設基準の数値ではない）")
MAX_TIME = 18.0
APP_MAX_RUN = 5       # 画面の LABOR_RULES.maxConsecutive（夜勤明けも勤務日に数える）
APP_MIN_OFF = 8       # 画面の LABOR_RULES.minOffDays（常勤の公休。明けは公休に数えない）
APP_MAX_NIGHTS = 8    # 画面の LABOR_RULES.maxNightsPerMonth
DEFAULT_MIN_INTERVAL_H = 11.0
DEFAULT_SHIFT_TIMES: dict[str, dict[str, str]] = {
    "早番": {"start": "07:00", "end": "16:00"},
    "日勤": {"start": "09:00", "end": "18:00"},
    "遅番": {"start": "12:00", "end": "21:00"},
    "夜勤": {"start": "16:30", "end": "09:30"},
}
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_END_TIME_RE = re.compile(r"^(([01]\d|2[0-3]):[0-5]\d|24:00)$")
MAX_KEYS = 120        # day_off などの職員キーの上限（staff の上限 80 より余裕をみる）
WISH_SHIFTS = (*WORK_SHIFTS, "勤務")
FIXED_SHIFTS = (*WORK_SHIFTS, OFF)
HISTORY_SHIFTS = (*WORK_SHIFTS, "")
MAX_HISTORY_DAYS = 7
MAX_INLINE_RULES = 50
MAX_RULE_PATTERN_LEN = 14
MAX_RULE_PEOPLE = 80
LABOR_RELAXED_NOTE = (
    "人が足りないため、「夜勤明けも連勤に数える（5日まで）」「常勤は月8日以上休む」を外して作りました。"
    "外したことで守れていない箇所は、労務の警告に出ています。"
)


def _hhmm(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _forbidden_interval_pairs(
    times: dict[str, dict[str, str]],
    min_interval_h: float,
    ake_ids: set[str] | frozenset[str] = frozenset({"夜勤"}),
) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """前日の終わりから翌日の始まりまで min_interval_h 未満の組を返す。
    戻り値: (翌日禁止の組 (A, B), 明け翌々日禁止の組 (A, B))。
    """
    two_day: list[tuple[str, str]] = []
    three_day: list[tuple[str, str]] = []
    spans: dict[str, tuple[int, int]] = {}
    for k, tm in times.items():
        s = _hhmm(tm["start"])
        e = _hhmm(tm["end"])
        spans[k] = (s, e + 1440 if e <= s else e)
    thresh_min = min_interval_h * 60.0
    for a, (sa, ea) in spans.items():
        for b, (sb, _eb) in spans.items():
            if a in ake_ids:
                gap2 = 2880 + sb - ea
                if gap2 < thresh_min - 1e-9:
                    three_day.append((a, b))
            else:
                gap1 = 1440 + sb - ea
                if gap1 < thresh_min - 1e-9:
                    two_day.append((a, b))
    return two_day, three_day


def _check_day_shift_map(
    v: dict[str, dict[int, str]], allowed: tuple[str, ...], field_name: str, label: str
) -> dict[str, dict[int, str]]:
    for sid, dm in v.items():
        if len(sid) > 40 or len(dm) > 31:
            raise ValueError(f"職員ごとの{label}は31件まで・staff_id は40文字まで: {sid[:40]}")
        for d, sh in dm.items():
            if sh not in allowed:
                raise ValueError(f"{field_name} の勤務区分が不正です: {sid} {d}日={sh}")
    return v


class StaffLimit(BaseModel):
    shifts: list[str] | None = Field(None, max_length=12)
    unit: Literal["回", "時間"] = "回"
    at_least: int | None = Field(None, ge=0)
    at_most: int | None = Field(None, ge=0)

    @field_validator("shifts")
    @classmethod
    def _shifts(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        if not v:
            raise ValueError("shifts を指定する場合は1つ以上の勤務区分が必要です")
        return v

    @model_validator(mode="after")
    def _bounds(self):
        if self.at_least is None and self.at_most is None:
            raise ValueError("limits は at_least か at_most のどちらかが必須です")
        cap = 31 if self.unit == "回" else 744
        for val in (self.at_least, self.at_most):
            if val is not None and val > cap:
                raise ValueError(f"limits の上限（{self.unit}）を超えています: {val} > {cap}")
        if self.at_least is not None and self.at_most is not None and self.at_least > self.at_most:
            raise ValueError(f"limits は at_least <= at_most にしてください: {self.at_least} > {self.at_most}")
        return self


class InlineStaff(BaseModel):
    staff_id: str = Field(max_length=40)
    role: str = Field("介護職員", max_length=20)
    employment: str = Field("常勤", max_length=10)
    years: int = Field(0, ge=0, le=60)
    skills: list[str] = Field(default_factory=list, max_length=20)
    shifts: list[str] = Field(default_factory=list, max_length=12)
    home_unit: str | None = Field(None, max_length=20)
    leave_by: str | None = Field(None, max_length=5)
    is_leader: bool = False
    limits: list[StaffLimit] = Field(default_factory=list, max_length=20)


# ---------------------------------------------------------------- 口（チャット・API）用ルール型


class _InlineRuleBase(BaseModel):
    id: str | None = Field(default=None, max_length=120)
    label: str | None = Field(default=None, max_length=500)
    strength: Strength = "強く"
    lifecycle: Lifecycle = Field(default_factory=Lifecycle)


class InlineStaffing(_InlineRuleBase):
    type: Literal["staffing"] = "staffing"
    shifts: ShiftSel
    people: PeopleSel = Field(default_factory=PeopleSel)
    days: DaySel = Field(default_factory=DaySel)
    at_least: int | None = None
    at_most: int | None = None

    @model_validator(mode="after")
    def _validate(self):
        if self.at_least is None and self.at_most is None:
            raise ValueError("人数ルールは下限か上限のどちらかが必要です")
        for label, val in (("下限", self.at_least), ("上限", self.at_most)):
            if val is not None and not 0 <= val <= MAX_RULE_PEOPLE:
                raise ValueError(f"人数ルールの{label}は 0〜{MAX_RULE_PEOPLE} 人で指定してください: {val}")
        if self.at_least is not None and self.at_most is not None and self.at_least > self.at_most:
            raise ValueError(f"人数ルールの下限（{self.at_least}）が上限（{self.at_most}）を超えています")
        if self.shifts.ids and PUBLIC_OFF in self.shifts.ids:
            raise ValueError("人数ルールでは 公休 を使えません")
        return self


class InlineRequest(_InlineRuleBase):
    type: Literal["request"] = "request"
    people: PeopleSel = Field(default_factory=PeopleSel)
    days: DaySel = Field(default_factory=DaySel)
    shifts: ShiftSel
    want: bool = True

    @model_validator(mode="after")
    def _validate(self):
        if self.shifts.ids and PUBLIC_OFF in self.shifts.ids:
            raise ValueError("希望・回避ルールでは 公休 を使えません")
        return self


class InlineSuccession(_InlineRuleBase):
    type: Literal["succession"] = "succession"
    people: PeopleSel = Field(default_factory=PeopleSel)
    pattern: list[ShiftSel] | None = None
    forbid: bool = True
    max_run: int | None = None

    @model_validator(mode="after")
    def _validate(self):
        if (self.pattern is None) == (self.max_run is None):
            raise ValueError("並び・連勤ルールは pattern か max_run のどちらか一方を指定してください")
        if self.max_run is not None and not 1 <= self.max_run <= 31:
            raise ValueError(f"連続勤務の上限は 1〜31 日で指定してください: {self.max_run}")
        if self.pattern is not None:
            if not 2 <= len(self.pattern) <= MAX_RULE_PATTERN_LEN:
                raise ValueError(f"並びの長さは 2〜{MAX_RULE_PATTERN_LEN} 日で指定してください: {len(self.pattern)}")
            if any(sel.ids and PUBLIC_OFF in sel.ids for sel in self.pattern):
                raise ValueError("並び・連勤ルールでは 公休 を使えません")
        return self


class InlineCount(_InlineRuleBase):
    type: Literal["count"] = "count"
    people: PeopleSel = Field(default_factory=PeopleSel)
    shifts: ShiftSel
    days: DaySel = Field(default_factory=DaySel)
    unit: Literal["回", "時間"] = "回"
    at_least: float | None = None
    at_most: float | None = None
    target: int | None = None

    @model_validator(mode="after")
    def _validate(self):
        if self.at_least is None and self.at_most is None and self.target is None:
            raise ValueError("回数・時間ルールは下限・上限・目標のいずれかが必要です")
        for label, val in (("下限", self.at_least), ("上限", self.at_most), ("目標", self.target)):
            if val is not None and val < 0:
                raise ValueError(f"回数・時間ルールの{label}は 0 以上で指定してください: {val}")
        if self.at_least is not None and self.at_most is not None and self.at_least > self.at_most:
            raise ValueError(f"回数・時間ルールの下限（{self.at_least}）が上限（{self.at_most}）を超えています")
        if self.target is not None:
            if self.strength == "絶対":
                raise ValueError("回数・時間ルールの目標は「絶対」では使えません")
            if self.at_least is not None and self.target < self.at_least:
                raise ValueError(f"回数・時間ルールの目標（{self.target}）が下限（{self.at_least}）を下回っています")
            if self.at_most is not None and self.target > self.at_most:
                raise ValueError(f"回数・時間ルールの目標（{self.target}）が上限（{self.at_most}）を上回っています")
        return self


class InlineBalance(_InlineRuleBase):
    type: Literal["balance"] = "balance"
    people: PeopleSel = Field(default_factory=PeopleSel)
    shifts: ShiftSel
    days: DaySel = Field(default_factory=DaySel)
    max_spread: int

    @model_validator(mode="after")
    def _validate(self):
        if not 0 <= self.max_spread <= 31:
            raise ValueError(f"平準化の許容差は 0〜31 回で指定してください: {self.max_spread}")
        return self


class InlineOccurrence(_InlineRuleBase):
    type: Literal["occurrence"] = "occurrence"
    people: PeopleSel = Field(default_factory=PeopleSel)
    pattern: list[ShiftSel]
    starts: DaySel = Field(default_factory=DaySel)
    at_least: int | None = None
    at_most: int | None = None

    @model_validator(mode="after")
    def _validate(self):
        if not 2 <= len(self.pattern) <= MAX_RULE_PATTERN_LEN:
            raise ValueError(f"並びの回数ルールの長さは 2〜{MAX_RULE_PATTERN_LEN} 日で指定してください: {len(self.pattern)}")
        if self.at_least is None and self.at_most is None:
            raise ValueError("並びの回数ルールは下限か上限のどちらかが必要です")
        for label, val in (("下限", self.at_least), ("上限", self.at_most)):
            if val is not None and not 0 <= val <= 31:
                raise ValueError(f"並びの回数ルールの{label}は 0〜31 回で指定してください: {val}")
        if self.at_least is not None and self.at_most is not None and self.at_least > self.at_most:
            raise ValueError(f"並びの回数ルールの下限（{self.at_least}）が上限（{self.at_most}）を超えています")
        return self


InlineRule = Annotated[
    Union[InlineStaffing, InlineRequest, InlineSuccession, InlineCount, InlineBalance, InlineOccurrence],
    Field(discriminator="type"),
]


class InlineSolveIn(BaseModel):
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    days: int | None = Field(None, ge=28, le=31)
    first_weekday: int | None = Field(None, ge=0, le=6)
    staff: list[InlineStaff] = Field(min_length=1, max_length=80)
    shift_types: list[ShiftType] = Field(default_factory=list, max_length=12)
    need_per_shift: dict[str, int] = Field(default_factory=lambda: {k: 4 for k in WORK_SHIFTS}, max_length=12)
    day_off: dict[str, list[int]] = Field(default_factory=dict, max_length=MAX_KEYS)       # 希望休（強く）
    unavailable: dict[str, list[int]] = Field(default_factory=dict, max_length=MAX_KEYS)   # 入れない日（絶対）。例: 主任の土日
    keep_free: dict[str, list[int]] = Field(default_factory=dict, max_length=MAX_KEYS)     # 「入れる日」を出した人は補欠として残したい（できれば）
    carry_in: dict[str, str] = Field(default_factory=dict, max_length=MAX_KEYS)            # 前月末日の勤務（夜勤なら1日は明け）
    extra: dict[str, dict[str, int]] = Field(default_factory=dict, max_length=31)          # "YYYY-MM-DD" -> {勤務区分: 追加人数}
    night_max: int | None = Field(None, ge=1, le=15)
    time_limit: float = Field(12.0, ge=1, le=MAX_TIME)
    need_by_weekday: dict[str, list[int]] = Field(default_factory=dict, max_length=12)     # {勤務区分: [日,月,火,水,木,金,土]}
    need_by_group: dict[ShiftGroup, int | list[int]] = Field(default_factory=dict, max_length=3)
    holidays: list[int] = Field(default_factory=list, max_length=31)                      # 日曜の人数を使う祝日（日）
    shift_wish: dict[str, dict[int, str]] = Field(default_factory=dict, max_length=MAX_KEYS)         # {sid: {日: 勤務区分|"勤務"}}
    shift_avoid: dict[str, dict[int, list[str]]] = Field(default_factory=dict, max_length=MAX_KEYS)  # {sid: {日: [勤務区分...]}}
    fixed: dict[str, dict[int, str]] = Field(default_factory=dict, max_length=MAX_KEYS)              # {sid: {日: 勤務区分|"休"}}
    history: dict[str, list[str]] = Field(default_factory=dict, max_length=MAX_KEYS)                 # {sid: 前月末最大7日（古い順）}
    need_mode: Literal["exact", "min"] = "exact"
    off_target: int | None = Field(None, ge=0, le=31)
    need_max: dict[str, int] = Field(default_factory=dict, max_length=12)
    need_max_by_weekday: dict[str, list[int]] = Field(default_factory=dict, max_length=12)
    max_run: int | None = Field(None, ge=1, le=10)
    shift_times: dict[str, dict[str, str]] | None = None
    min_interval_h: float | None = Field(None, ge=0, le=24)
    rules: list[InlineRule] = Field(default_factory=list)
    baseline: dict[str, list[str]] | None = None
    ward_night_avg_max: int | None = Field(None, ge=1, le=200)
    night_window: NightWindow = Field(default_factory=NightWindow)
    night_worker_min_h: int = Field(default=16, ge=0, le=100)

    @field_validator("day_off", "unavailable", "keep_free")
    @classmethod
    def _per_staff_days(cls, v: dict[str, list[int]]) -> dict[str, list[int]]:
        for sid, ds in v.items():
            if len(sid) > 40 or len(ds) > 31:
                raise ValueError(f"職員ごとの日は31件まで・staff_id は40文字まで: {sid[:40]}")
        return v

    @field_validator("carry_in")
    @classmethod
    def _carry(cls, v: dict[str, str]) -> dict[str, str]:
        for sid, k in v.items():
            if len(sid) > 40 or len(k) > 8:
                raise ValueError(f"carry_in が不正です: {sid[:40]}")
        return v

    @field_validator("extra")
    @classmethod
    def _extra(cls, v: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
        for ds in v:
            try:
                if len(ds) != 10:
                    raise ValueError
                date.fromisoformat(ds)
            except ValueError:
                raise ValueError(f"extra の日付は YYYY-MM-DD: {ds[:12]}") from None
        return v

    @model_validator(mode="after")
    def _check_all(self):
        # 勤務区分一覧の確定と重複チェック
        if self.shift_types:
            seen_st: set[str] = set()
            for st in self.shift_types:
                if st.id in seen_st:
                    raise ValueError(f"shift_types の id が重複しています: {st.id}")
                seen_st.add(st.id)
            if "need_per_shift" not in self.model_fields_set:
                self.need_per_shift = {}
            work_ids = tuple(st.id for st in self.shift_types)
        else:
            work_ids = WORK_SHIFTS
        work_set = set(work_ids)
        max_w = len(work_ids)

        for s in self.staff:
            bad = [k for k in s.shifts if k not in work_set]
            if bad:
                raise ValueError(f"勤務区分が不正です: {bad}")
            for lim in s.limits:
                if lim.shifts is not None:
                    bad_l = [k for k in lim.shifts if k not in work_set]
                    if bad_l:
                        raise ValueError(f"limits の勤務区分が不正です: {bad_l}")

        for k, n in self.need_per_shift.items():
            if k not in work_set or not 0 <= n <= 20:
                raise ValueError(f"need_per_shift が不正です: {k}={n}")
        for k, counts in self.need_by_weekday.items():
            if k not in work_set:
                raise ValueError(f"need_by_weekday の勤務区分が不正です: {k}")
            if len(counts) != 7 or any(not 0 <= n <= 20 for n in counts):
                raise ValueError(f"need_by_weekday は曜日ごと7件（0〜20人）で指定してください: {k}")
        for grp, spec in self.need_by_group.items():
            if isinstance(spec, list):
                if len(spec) != 7 or any(not isinstance(n, int) or not 0 <= n <= 80 for n in spec):
                    raise ValueError(f"need_by_group は曜日ごと7件（0〜80人）で指定してください: {grp}")
            elif not 0 <= spec <= 80:
                raise ValueError(f"need_by_group が不正です: {grp}={spec}")
        for k, n in self.need_max.items():
            if k not in work_set or not 0 <= n <= 20:
                raise ValueError(f"need_max が不正です: {k}={n}")
        for k, counts in self.need_max_by_weekday.items():
            if k not in work_set:
                raise ValueError(f"need_max_by_weekday の勤務区分が不正です: {k}")
            if len(counts) != 7 or any(not 0 <= n <= 20 for n in counts):
                raise ValueError(f"need_max_by_weekday は曜日ごと7件（0〜20人）で指定してください: {k}")
        if self.shift_times is not None:
            for k, tm in self.shift_times.items():
                if k not in work_set:
                    raise ValueError(f"shift_times の勤務区分が不正です: {k}")
                if not isinstance(tm, dict) or "start" not in tm or "end" not in tm:
                    raise ValueError(f"shift_times[{k}] には start と end が必要です")
                if not _TIME_RE.match(str(tm["start"])) or not _END_TIME_RE.match(str(tm["end"])):
                    raise ValueError(f"shift_times[{k}] の時刻は HH:MM 形式で指定してください: {tm}")
        for ds, row in self.extra.items():
            if len(row) > max_w:
                raise ValueError(f"extra の勤務区分は{max_w}つまで: {ds}")
        _check_day_shift_map(self.shift_wish, (*work_ids, "勤務"), "shift_wish", "希望勤務")
        for sid, dm in self.shift_avoid.items():
            if len(sid) > 40 or len(dm) > 31:
                raise ValueError(f"職員ごとの避けたい勤務は31件まで・staff_id は40文字まで: {sid[:40]}")
            for d, ks in dm.items():
                if len(ks) > max_w:
                    raise ValueError(f"shift_avoid の1日あたり勤務区分は{max_w}つまで: {sid} {d}日")
                bad = [k for k in ks if k not in work_set]
                if bad:
                    raise ValueError(f"shift_avoid の勤務区分が不正です: {sid} {d}日={bad}")
        _check_day_shift_map(self.fixed, (*work_ids, OFF), "fixed", "固定割り当て")
        hist_allowed = (*work_ids, "")
        for sid, seq in self.history.items():
            if len(sid) > 40 or len(seq) > MAX_HISTORY_DAYS:
                raise ValueError(f"history は7日まで・staff_id は40文字まで: {sid[:40]}")
            bad = [k for k in seq if k not in hist_allowed]
            if bad:
                raise ValueError(f"history の勤務区分が不正です: {sid}={bad}")
        y, m = map(int, self.month.split("-"))
        max_day = calendar.monthrange(y, m)[1] if 1 <= m <= 12 else 31
        staff_ids = {s.staff_id for s in self.staff}

        if len(self.rules) > MAX_INLINE_RULES:
            raise ValueError(f"追加ルールは{MAX_INLINE_RULES}本までにしてください: {len(self.rules)}本")
        count_off_ok = work_set | {OFF, PUBLIC_OFF}
        strict_work_off = work_set | {OFF}
        for idx, r in enumerate(self.rules):
            if r.people.ids is not None:
                if len(r.people.ids) > MAX_RULE_PEOPLE:
                    raise ValueError(f"追加ルール{idx + 1}の対象人数は{MAX_RULE_PEOPLE}人までです: {len(r.people.ids)}人")
                unknown = [sid for sid in r.people.ids if sid not in staff_ids]
                if unknown:
                    raise ValueError(f"追加ルール{idx + 1}に知らない職員IDが含まれています: {unknown[:3]}")
            for day_sel in (getattr(r, "days", None), getattr(r, "starts", None)):
                if day_sel is not None:
                    if day_sel.dates is not None:
                        bad_d = [d for d in day_sel.dates if not 1 <= d <= max_day]
                        if bad_d:
                            raise ValueError(f"追加ルール{idx + 1}の日付は 1〜{max_day} の範囲で指定してください: {bad_d[:5]}")
                    if day_sel.weekdays is not None:
                        bad_w = [w for w in day_sel.weekdays if not 0 <= w <= 6]
                        if bad_w:
                            raise ValueError(f"追加ルール{idx + 1}の曜日は 0〜6 で指定してください: {bad_w}")
            allowed_shifts = count_off_ok if isinstance(r, (InlineCount, InlineBalance, InlineOccurrence)) else strict_work_off
            if isinstance(r, (InlineSuccession, InlineOccurrence)) and r.pattern:
                sels = list(r.pattern)
            else:
                sels = [r.shifts] if hasattr(r, "shifts") else []
            for sel in sels:
                if sel.ids is not None:
                    bad = [k for k in sel.ids if k not in allowed_shifts]
                    if bad:
                        raise ValueError(f"追加ルール{idx + 1}の勤務区分が不正です: {bad}")
            if isinstance(r, InlineSuccession) and r.max_run is not None and r.max_run > max_day:
                raise ValueError(f"追加ルール{idx + 1}の連続勤務上限が月の日数（{max_day}日）を超えています: {r.max_run}")
            if isinstance(r, InlineCount):
                cap = max_day if r.unit == "回" else max_day * 24
                for label, val in (("下限", r.at_least), ("上限", r.at_most), ("目標", r.target)):
                    if val is not None and val > cap:
                        raise ValueError(f"追加ルール{idx + 1}の{label}が上限（{cap}{r.unit}）を超えています: {val}")
            if isinstance(r, InlineBalance) and r.max_spread > max_day:
                raise ValueError(f"追加ルール{idx + 1}の許容差が月の日数（{max_day}日）を超えています: {r.max_spread}")
            if isinstance(r, InlineOccurrence):
                for label, val in (("下限", r.at_least), ("上限", r.at_most)):
                    if val is not None and val > max_day:
                        raise ValueError(f"追加ルール{idx + 1}の{label}が月の日数（{max_day}日）を超えています: {val}")

        bad_holidays = [d for d in self.holidays if not 1 <= d <= max_day]
        if bad_holidays:
            raise ValueError(f"holidays の日付は 1〜{max_day} の範囲で指定してください: {bad_holidays}")
        for field_name, per_staff in (
            ("shift_wish", self.shift_wish),
            ("shift_avoid", self.shift_avoid),
            ("fixed", self.fixed),
        ):
            for sid, dm in per_staff.items():
                bad_days = [d for d in dm if not 1 <= d <= max_day]
                if bad_days:
                    raise ValueError(f"{field_name} の日付は 1〜{max_day} の範囲で指定してください: {sid} {bad_days}")
        if self.need_max or self.need_max_by_weekday:
            hols = set(self.holidays)
            fw = date(y, m, 1).isoweekday() % 7 if 1 <= m <= 12 else 0
            for k in set(self.need_max) | set(self.need_max_by_weekday):
                for d in range(1, max_day + 1):
                    wd = 0 if d in hols else (fw + d - 1) % 7
                    nd = self.need_by_weekday[k][wd] if k in self.need_by_weekday else self.need_per_shift.get(k, 0)
                    mx = self.need_max_by_weekday[k][wd] if k in self.need_max_by_weekday else self.need_max[k]
                    if mx < nd:
                        raise ValueError(f"{k}の人数上限（{mx}人）が必要人数（{nd}人）より小さいです（{d}日）")
        if self.baseline is not None:
            expected_days = self.days if self.days is not None else max_day
            staff_ids = {s.staff_id for s in self.staff}
            if set(self.baseline.keys()) != staff_ids:
                raise ValueError("baseline の職員IDが staff と一致しません")
            bl_allowed = work_set | {"", OFF}
            for sid, row in self.baseline.items():
                if len(row) != expected_days:
                    raise ValueError(f"baseline の日数が{expected_days}日と一致しません: {sid}")
                bad_bl = [v for v in row if v not in bl_allowed]
                if bad_bl:
                    raise ValueError(f"baseline の勤務区分が不正です: {sid}={bad_bl[:3]}")
        return self


def _month(b: InlineSolveIn) -> Month:
    y, m = map(int, b.month.split("-"))
    if not 1 <= m <= 12:
        raise ServiceError(400, f"month が不正です: {b.month}")
    days = calendar.monthrange(y, m)[1]
    fw = date(y, m, 1).isoweekday() % 7
    if b.days not in (None, days) or b.first_weekday not in (None, fw):
        raise ServiceError(400, f"{b.month} は {days} 日・1日の曜日は {fw} です")
    return Month(month=b.month, days=days, first_weekday=fw)


def _days(ds: list[int], n: int) -> list[int]:
    return sorted({d for d in ds if 1 <= d <= n})


def _daily_need(b: InlineSolveIn, mo: Month, holidays: set[int], k: str, d: int) -> int:
    if k in b.need_by_weekday:
        return b.need_by_weekday[k][0 if d in holidays else mo.weekday(d)]
    return b.need_per_shift.get(k, 0)


def _daily_max(b: InlineSolveIn, mo: Month, holidays: set[int], k: str, d: int) -> int | None:
    if k in b.need_max_by_weekday:
        return b.need_max_by_weekday[k][0 if d in holidays else mo.weekday(d)]
    if k in b.need_max:
        return b.need_max[k]
    return None


def _default_off_target(mo: Month, holidays: set[int]) -> int:
    return sum(1 for d in range(1, mo.days + 1) if mo.weekday(d) in (0, 6) or d in holidays)


def _auto_day_alpha(
    b: InlineSolveIn,
    fac: Facility,
    mo: Month,
    holidays: set[int],
    off_t: int,
    day_shifts: list[str],
    night_shifts: list[str],
) -> int:
    """下限モード時、日勤系の余剰人数を各日・各帯にならすための自動上限加算分 α を計算する。"""
    N = mo.days
    unavail_map = {sid: set(_days(ds, N)) for sid, ds in b.unavailable.items()}
    night_need = sum(_daily_need(b, mo, holidays, k, d) for d in range(1, N + 1) for k in night_shifts)
    night_staff_cnt = sum(1 for s in fac.staff if any(k in s.shifts for k in night_shifts))
    avg_ake = night_need / night_staff_cnt if night_staff_cnt else 0.0
    total_avail = 0.0
    for sb, s in zip(b.staff, fac.staff):
        if not s.shifts:
            continue
        unav_n = len(unavail_map.get(s.staff_id, set()))
        max_lim = next((lim.at_most for lim in sb.limits if lim.unit == "回" and lim.shifts is None and lim.at_most is not None), None)
        if s.employment == "常勤":
            ake = avg_ake if any(k in s.shifts for k in night_shifts) else 0.0
            est = min(N - unav_n, max(0.0, N - off_t - ake))
        else:
            est = float(min(14, max(0, N - unav_n)))
        if max_lim is not None:
            est = min(est, float(max_lim))
        total_avail += est
    total_need = sum(_daily_need(b, mo, holidays, k, d) for d in range(1, N + 1) for k in (*day_shifts, *night_shifts))
    surplus = max(0, round(total_avail - total_need))
    denom = sum(
        1
        for d in range(1, N + 1)
        for k in day_shifts
        if _daily_need(b, mo, holidays, k, d) > 0 and k not in b.need_max and k not in b.need_max_by_weekday
    )
    return max(1, math.ceil(surplus / denom)) if denom > 0 else 1


def _days_cap_override(b: InlineSolveIn) -> set[str]:
    return {
        s.staff_id
        for s in b.staff
        if any(lim.unit == "回" and lim.at_most is not None and lim.shifts is None for lim in s.limits)
    }


def _days_limit_override(b: InlineSolveIn) -> set[str]:
    return {
        s.staff_id
        for s in b.staff
        if any(lim.unit == "回" and lim.shifts is None and (lim.at_least is not None or lim.at_most is not None) for lim in s.limits)
    }


def _night_cap_override(b: InlineSolveIn, night_shift_ids: set[str] | None = None) -> set[str]:
    ns = night_shift_ids if night_shift_ids is not None else {"夜勤"}
    if not ns:
        return set()
    return {
        s.staff_id
        for s in b.staff
        if any(
            lim.unit == "回" and lim.at_most is not None and lim.shifts is not None and set(lim.shifts) == ns
            for lim in s.limits
        )
    }


def _limit_label(sid: str, lim: StaffLimit, bound: int, kind: str) -> str:
    if lim.unit == "時間":
        target = "勤務時間" if lim.shifts is None else "・".join(lim.shifts) + "の時間"
        return f"{sid}さんの{target}（月{bound}時間{kind}）"
    if lim.shifts is None:
        return f"{sid}さんの勤務日数（月{bound}日{kind}）"
    return f"{sid}さんの{'・'.join(lim.shifts)}（月{bound}回{kind}）"


def _daily_group_need(b: InlineSolveIn, mo: Month, holidays: set[int], grp: ShiftGroup, d: int) -> int:
    spec = b.need_by_group.get(grp)
    if spec is None:
        return 0
    if isinstance(spec, list):
        return spec[0 if d in holidays else mo.weekday(d)]
    return int(spec)


def build(b: InlineSolveIn, *, include_staffing: bool = True) -> tuple[Facility, Month, list, dict[str, str]]:
    mo = _month(b)
    ids = [s.staff_id for s in b.staff]
    if len(set(ids)) != len(ids):
        raise ServiceError(400, "staff_id が重複しています")
    known = set(ids)
    fac = Facility(
        facility_id="inline",
        name="inline",
        staff=[StaffMember(name=s.staff_id, **s.model_dump(exclude={"limits"})) for s in b.staff],
        shift_types=list(b.shift_types),
        ward_night_avg_max=b.ward_night_avg_max,
        night_window=b.night_window,
        night_worker_min_h=b.night_worker_min_h,
    )
    eff_sts = fac.effective_shift_types()
    work_ids = fac.work_shift_ids()
    work_set = set(work_ids)
    st_map = fac.shift_map()
    ake_ids = set(fac.ake_shift_ids())
    night_shift_ids = list(fac.night_shift_ids())
    night_set = set(night_shift_ids)
    day_shift_ids = [st.id for st in eff_sts if st.group != "夜勤系" and st.counts]

    need = {k: b.need_per_shift.get(k, 0) for k in work_ids}
    fac.need_per_shift = {k: n for k, n in need.items() if n > 0}
    N = mo.days

    # 行事の追加人数（日 -> 勤務 -> 人数）
    extra: dict[int, dict[str, int]] = {}
    for ds, row in b.extra.items():
        if not ds.startswith(b.month + "-"):
            continue
        d = int(ds[8:10])
        for k, n in row.items():
            if k in work_set and 0 < n <= 10 and 1 <= d <= N:
                extra.setdefault(d, {})[k] = n

    night_over = _night_cap_override(b, night_set)
    days_over = _days_cap_override(b)
    max_run = b.max_run if b.max_run is not None else APP_MAX_RUN
    use_dynamic_interval = bool(b.shift_types) or b.shift_times is not None or b.min_interval_h is not None
    replace = {"r-full-days", "r-night-fair", "r-night-medical", *(f"r-staff-{k}" for k in work_ids)}
    if use_dynamic_interval:
        replace.add("r-interval")
    cap = b.night_max or APP_MAX_NIGHTS
    night_label = "・".join(st_map[k].name for k in night_shift_ids) if night_shift_ids else "夜勤"
    rules: list = []
    for r in default_rules(fac, mo):
        if r.id in replace:
            continue
        if r.id == "r-run":
            r.max_run = max_run
            r.label = f"連続勤務は{max_run}日まで（デモ用の仮値）"
        elif r.id == "r-night-cap":
            if night_over:
                rem = [s.staff_id for s in fac.staff if s.staff_id not in night_over]
                if not rem:
                    continue
                r.people = PeopleSel(ids=rem)
            r.at_most = cap
            r.label = f"{night_label}は月{cap}回まで（デモ用の仮値）" if b.shift_types else f"夜勤は月{cap}回まで（デモ用の仮値）"
        elif r.id == "r-part-days" and days_over:
            rem = [s.staff_id for s in fac.staff if s.employment == "パート" and s.staff_id not in days_over]
            if not rem:
                continue
            r.people = PeopleSel(ids=rem)
        rules.append(r)

    if use_dynamic_interval:
        base_times = {st.id: {"start": st.start, "end": st.end} for st in eff_sts}
        times = {**base_times, **(b.shift_times or {})}
        min_iv = b.min_interval_h if b.min_interval_h is not None else DEFAULT_MIN_INTERVAL_H
        two_day, three_day = _forbidden_interval_pairs(times, min_iv, ake_ids)
        for a, c in two_day:
            rid = "r-interval" if (len(two_day) == 1 and not three_day and (a, c) == ("遅番", "早番")) else f"r-interval-{a}-{c}"
            an, cn = st_map[a].name, st_map[c].name
            rules.append(Succession(
                id=rid,
                label=f"{an}のあとに{cn}を置かない（勤務間インターバル{min_iv:g}時間未満）",
                strength="絶対",
                locked=True,
                origin=_O,
                pattern=[ShiftSel(ids=[a]), ShiftSel(ids=[c])],
                forbid=True,
            ))
        for a, c in three_day:
            an, cn = st_map[a].name, st_map[c].name
            rules.append(Succession(
                id=f"r-interval2-{a}-{c}",
                label=f"{an}の明け翌日に{cn}を置かない（勤務間インターバル{min_iv:g}時間未満）",
                strength="絶対",
                locked=True,
                origin=_O,
                pattern=[ShiftSel(ids=[a]), ShiftSel(ids=[OFF]), ShiftSel(ids=[c])],
                forbid=True,
            ))

    holidays = set(b.holidays)
    off_t = b.off_target if b.off_target is not None else _default_off_target(mo, holidays)
    if include_staffing:
        alpha = _auto_day_alpha(b, fac, mo, holidays, off_t, day_shift_ids, night_shift_ids) if b.need_mode == "min" else 1
        group_covered = {st.id for st in eff_sts if st.counts and st.group in b.need_by_group}
        # 必要人数: 日ごとに need_by_weekday（祝日は日曜の値）→ need_per_shift で決め、同じ人数の日をまとめる
        for k in work_ids:
            st = st_map[k]
            kn = st.name
            is_night = k in night_set
            has_explicit_need = (k in b.need_per_shift) or (k in b.need_by_weekday) or any(row.get(k) for row in extra.values())
            has_explicit_max = k in b.need_max or k in b.need_max_by_weekday
            if not st.counts and not has_explicit_need and not has_explicit_max:
                continue
            if k in group_covered and not has_explicit_need and not has_explicit_max:
                continue
            if k in group_covered:
                # 群の合計で数える区分のうち、個別指定があるもの（例: リーダー枠 D+）は下限（または0固定）として入れる
                by_lo: dict[int, list[int]] = {}
                for d in range(1, N + 1):
                    by_lo.setdefault(_daily_need(b, mo, holidays, k, d) + extra.get(d, {}).get(k, 0), []).append(d)
                for n, ds in sorted(by_lo.items()):
                    if n > 0:
                        rules.append(Staffing(
                            id=f"r-staff-{k}" if len(by_lo) == 1 else f"r-staff-{k}-{n}p",
                            label=f"{kn}は{n}人以上",
                            strength="絶対", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=ds), at_least=n,
                        ))
                    else:
                        rules.append(Staffing(
                            id=f"r-staff-{k}-0p" if len(by_lo) > 1 else f"r-staff-{k}",
                            label=f"{kn}は0人（配置なし）",
                            strength="絶対", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=ds), at_most=0,
                        ))
                continue
            if b.need_mode == "exact" or is_night:
                by_need: dict[int, list[int]] = {}
                for d in range(1, N + 1):
                    if not extra.get(d, {}).get(k):
                        by_need.setdefault(_daily_need(b, mo, holidays, k, d), []).append(d)
                if len(by_need) == 1:
                    n, plain = next(iter(by_need.items()))
                    if n > 0:
                        rules.append(Staffing(id=f"r-staff-{k}", label=f"{kn}は毎日{n}人（施設の基準人数・仮）", strength="絶対", origin=_O,
                                              shifts=ShiftSel(ids=[k]), days=DaySel(dates=plain), at_least=n, at_most=n))
                    else:
                        rules.append(Staffing(id=f"r-staff-{k}", label=f"{kn}は毎日0人（配置なし）", strength="絶対", origin=_O,
                                              shifts=ShiftSel(ids=[k]), days=DaySel(dates=plain), at_most=0))
                else:
                    for n, ds in sorted(by_need.items()):
                        if n > 0:
                            rules.append(Staffing(id=f"r-staff-{k}-{n}p", label=f"{kn}は{n}人の日（施設の基準人数・仮）", strength="絶対",
                                                  origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=ds), at_least=n, at_most=n))
                        else:
                            rules.append(Staffing(id=f"r-staff-{k}-0p", label=f"{kn}は0人の日（配置なし）", strength="絶対",
                                                  origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=ds), at_most=0))
                for d, row in sorted(extra.items()):
                    if row.get(k):
                        n = _daily_need(b, mo, holidays, k, d)
                        rules.append(Staffing(id=f"r-staff-{k}-{d}",
                                              label=f"{d}日の{kn}は{n}人以上（施設の基準人数・仮）" if n > 0 else f"{d}日の{kn}は{row[k]}人まで（行事）",
                                              strength="絶対", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=[d]),
                                              at_least=n if n > 0 else None, at_most=n + row[k]))
                        rules.append(Staffing(id=f"r-event-{k}-{d}", label=f"{d}日の{kn}は行事のため+{row[k]}人", strength="強く", origin=_O,
                                              shifts=ShiftSel(ids=[k]), days=DaySel(dates=[d]), at_least=n + row[k]))
            else:
                # need_mode == "min" かつ日勤系: 下限は絶対、上限（明示 or 自動 α）は「できれば」
                by_lo = {}
                by_hi: dict[int, list[int]] = {}
                for d in range(1, N + 1):
                    n = _daily_need(b, mo, holidays, k, d)
                    ex = extra.get(d, {}).get(k, 0)
                    exp_mx = _daily_max(b, mo, holidays, k, d) if has_explicit_max else None
                    if ex > 0:
                        rules.append(Staffing(
                            id=f"r-staff-{k}-{d}",
                            label=f"{d}日の{kn}は{n}人以上（施設の基準人数・仮）" if n > 0 else f"{d}日の{kn}は{ex}人まで（行事）",
                            strength="絶対", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=[d]),
                            at_least=n if n > 0 else None,
                            at_most=(n + ex) if (n == 0 and not has_explicit_max) else None,
                        ))
                        rules.append(Staffing(
                            id=f"r-event-{k}-{d}", label=f"{d}日の{kn}は行事のため+{ex}人",
                            strength="強く", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=[d]), at_least=n + ex,
                        ))
                        hi_val = max(exp_mx, n + ex) if exp_mx is not None else (n + ex + alpha if n > 0 else None)
                        if hi_val is not None:
                            by_hi.setdefault(hi_val, []).append(d)
                    else:
                        by_lo.setdefault(n, []).append(d)
                        if exp_mx is not None:
                            if n == 0 and exp_mx == 0:
                                pass  # 0人固定に含める
                            else:
                                by_hi.setdefault(exp_mx, []).append(d)
                        elif n > 0:
                            by_hi.setdefault(n + alpha, []).append(d)
                for n, ds in sorted(by_lo.items()):
                    if n > 0:
                        rules.append(Staffing(
                            id=f"r-staff-{k}" if len(by_lo) == 1 else f"r-staff-{k}-{n}p",
                            label=f"{kn}は毎日{n}人以上（施設の基準人数・仮）" if len(ds) == N else f"{kn}は{n}人以上の日（施設の基準人数・仮）",
                            strength="絶対", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=ds), at_least=n,
                        ))
                    elif not has_explicit_max or all((_daily_max(b, mo, holidays, k, d) or 0) == 0 for d in ds):
                        rules.append(Staffing(
                            id=f"r-staff-{k}-0p" if len(by_lo) > 1 else f"r-staff-{k}",
                            label=f"{kn}は毎日0人（配置なし）" if len(ds) == N else f"{kn}は0人の日（配置なし）",
                            strength="絶対", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=ds), at_most=0,
                        ))
                    else:
                        zero_only = [d for d in ds if (_daily_max(b, mo, holidays, k, d) or 0) == 0]
                        if zero_only:
                            rules.append(Staffing(
                                id=f"r-staff-{k}-0p", label=f"{kn}は0人の日（配置なし）",
                                strength="絶対", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=zero_only), at_most=0,
                            ))
                for mx, ds in sorted(by_hi.items()):
                    rules.append(Staffing(
                        id=f"r-needmax-{k}-{mx}",
                        label=f"{kn}は{mx}人まで（目安）",
                        strength="できれば", origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=ds), at_most=mx,
                    ))

        # 群ごとの合計必要人数（need_by_group）
        for grp in b.need_by_group:
            grp_ids = [st.id for st in eff_sts if st.group == grp and st.counts]
            if not grp_ids:
                continue
            by_gn: dict[int, list[int]] = {}
            for d in range(1, N + 1):
                gn = _daily_group_need(b, mo, holidays, grp, d)
                if gn > 0:
                    by_gn.setdefault(gn, []).append(d)
            for gn, ds in sorted(by_gn.items()):
                rules.append(Staffing(
                    id=f"r-group-{grp}-{gn}p",
                    label=f"{grp}は合計{gn}人以上",
                    strength="絶対", origin=_O, shifts=ShiftSel(ids=grp_ids), days=DaySel(dates=ds), at_least=gn,
                ))

    night_staff_ids = [s.staff_id for s in fac.staff if any(k in night_set for k in s.shifts)]
    if night_shift_ids and len(night_staff_ids) >= 2:
        rules.append(Balance(id="r-night-fair", label="夜勤回数の差は2回以内（夜勤に入れる人どうし）", strength="強く", origin=_O,
                             people=PeopleSel(ids=night_staff_ids), shifts=ShiftSel(ids=night_shift_ids), max_spread=2))
        rules.append(Balance(id="r-night-even", label="夜勤回数の差はできれば1回以内", strength="できれば", origin=_O,
                             people=PeopleSel(ids=night_staff_ids), shifts=ShiftSel(ids=night_shift_ids), max_spread=1))
    med_days = (
        [d for d in range(1, N + 1) if sum(_daily_need(b, mo, holidays, nk, d) for nk in night_shift_ids) >= 2]
        if night_shift_ids else []
    )
    if med_days:
        rules.append(Staffing(id="r-night-medical", label="夜勤に医療的ケアができる人を2人以上（各フロア1人）", strength="強く",
                              origin=_O, shifts=ShiftSel(ids=night_shift_ids), people=PeopleSel(skills=["medical"]),
                              days=DaySel() if len(med_days) == N else DaySel(dates=med_days), at_least=2))
    full_ids = [s.staff_id for s in fac.staff if s.employment == "常勤" and not s.is_leader and s.shifts]
    if b.need_mode == "min":
        days_lim_over = _days_limit_override(b)
        off_ids = [s.staff_id for s in fac.staff if s.employment == "常勤" and s.shifts and s.staff_id not in days_lim_over]
        if off_ids:
            rules.append(Count(
                id="r-off-target",
                label=f"常勤の公休は月{off_t}日を目標",
                strength="強く",
                origin=_O,
                people=PeopleSel(ids=off_ids),
                shifts=ShiftSel(ids=[PUBLIC_OFF]),
                target=off_t,
            ))
    elif len(full_ids) >= 2:
        rules.append(Balance(id="r-full-fair", label="常勤の勤務回数の差は4回以内", strength="強く", origin=_O,
                             people=PeopleSel(ids=full_ids), shifts=ShiftSel(), max_spread=4))
        full_days_ids = [sid for sid in full_ids if sid not in days_over]
        if full_days_ids:
            rules.append(Count(id="r-full-days", label=f"常勤は月{N - 8}日まで（デモ用の仮値）", strength="強く", origin=_O,
                               people=PeopleSel(ids=full_days_ids), shifts=ShiftSel(), at_most=N - 8))

    for s in b.staff:
        for idx, lim in enumerate(s.limits):
            if lim.at_most is not None:
                rules.append(Count(
                    id=f"lim-max-{s.staff_id}-{idx}",
                    label=_limit_label(s.staff_id, lim, lim.at_most, "まで"),
                    strength="絶対",
                    origin=Origin(kind="施設設定"),
                    people=PeopleSel(ids=[s.staff_id]),
                    shifts=ShiftSel(ids=lim.shifts),
                    unit=lim.unit,
                    at_most=lim.at_most,
                ))
            if lim.at_least is not None:
                rules.append(Count(
                    id=f"lim-min-{s.staff_id}-{idx}",
                    label=_limit_label(s.staff_id, lim, lim.at_least, "以上"),
                    strength="強く",
                    origin=Origin(kind="施設設定"),
                    people=PeopleSel(ids=[s.staff_id]),
                    shifts=ShiftSel(ids=lim.shifts),
                    unit=lim.unit,
                    at_least=lim.at_least,
                ))

    # 希望休（強く）・入れない日（絶対）・補欠として残したい日（できれば）
    rows = [{"staff_id": sid, "date": f"{b.month}-{d:02d}", "kind": "off"}
            for sid, ds in b.day_off.items() if sid in known for d in _days(ds, N)]
    rules += request_rules(rows, b.month)
    for sid, ds in sorted(b.unavailable.items()):
        if sid in known and _days(ds, N):
            rules.append(Request(id=f"na-{sid}", label=f"{sid} の入れない日", strength="絶対", origin=Origin(kind="施設設定"),
                                 people=PeopleSel(ids=[sid]), days=DaySel(dates=_days(ds, N)), shifts=ShiftSel(ids=[OFF]), want=True))
    for sid, ds in sorted(b.keep_free.items()):
        if sid in known and _days(ds, N):
            rules.append(Request(id=f"spare-{sid}", label=f"{sid} は補欠として残す", strength="できれば", origin=Origin(kind="手入力"),
                                 people=PeopleSel(ids=[sid]), days=DaySel(dates=_days(ds, N)), shifts=ShiftSel(ids=[OFF]), want=True))

    wish_groups: dict[tuple[str, str], list[int]] = {}
    for sid, dm in sorted(b.shift_wish.items()):
        if sid not in known:
            continue
        for d, sh in dm.items():
            if 1 <= d <= N:
                wish_groups.setdefault((sid, sh), []).append(d)
    for (sid, sh), ds in sorted(wish_groups.items()):
        sh_lbl = "勤務" if sh == "勤務" else st_map[sh].name
        rules.append(Request(
            id=f"wish-{sid}-{sh}",
            label=f"{sid}さんの{sh_lbl}希望（{len(ds)}日）",
            strength="強く",
            origin=Origin(kind="手入力"),
            people=PeopleSel(ids=[sid]),
            days=DaySel(dates=sorted(ds)),
            shifts=ShiftSel(ids=None if sh == "勤務" else [sh]),
            want=True,
        ))

    avoid_groups: dict[tuple[str, tuple[str, ...]], list[int]] = {}
    for sid, dm in sorted(b.shift_avoid.items()):
        if sid not in known:
            continue
        for d, ks in dm.items():
            if 1 <= d <= N and ks:
                avoid_groups.setdefault((sid, tuple(sorted(set(ks)))), []).append(d)
    for (sid, ks_key), ds in sorted(avoid_groups.items()):
        ks_lbl = "・".join(st_map[k].name for k in ks_key)
        rules.append(Request(
            id=f"avoid-{sid}-{'-'.join(ks_key)}",
            label=f"{sid}さんの{ks_lbl}回避（{len(ds)}日）",
            strength="強く",
            origin=Origin(kind="手入力"),
            people=PeopleSel(ids=[sid]),
            days=DaySel(dates=sorted(ds)),
            shifts=ShiftSel(ids=list(ks_key)),
            want=False,
        ))

    # 口（チャット・API）から来たルールは既定ルールの後ろに足し、サーバー側で id / label / origin を確定する
    shift_names = {st.id: st.name for st in eff_sts}
    staff_names = {s.staff_id: s.name for s in fac.staff}
    for idx, cr in enumerate(b.rules):
        rules.append(_to_monthly_rule(cr, idx, shift_names=shift_names, staff_names=staff_names, work_ids=work_ids))

    carry = {sid: k for sid, k in b.carry_in.items() if sid in known and k in work_set}
    return fac, mo, rules, carry


def _to_monthly_rule(
    cr: InlineRule,
    idx: int,
    *,
    shift_names: dict[str, str],
    staff_names: dict[str, str],
    work_ids: tuple[str, ...],
) -> MonthlyRule:
    common = dict(
        id=f"r-ui-{idx}",
        label=rule_label(cr, shift_names=shift_names, staff_names=staff_names, work_ids=work_ids),
        strength=cr.strength,
        origin=Origin(kind="リーダーの言葉"),
        lifecycle=cr.lifecycle,
        locked=False,
    )
    if isinstance(cr, InlineStaffing):
        return Staffing(
            **common, shifts=cr.shifts, people=cr.people, days=cr.days,
            at_least=cr.at_least, at_most=cr.at_most,
        )
    if isinstance(cr, InlineRequest):
        return Request(**common, people=cr.people, days=cr.days, shifts=cr.shifts, want=cr.want)
    if isinstance(cr, InlineSuccession):
        return Succession(**common, people=cr.people, pattern=cr.pattern, forbid=cr.forbid, max_run=cr.max_run)
    if isinstance(cr, InlineCount):
        return Count(
            **common, people=cr.people, shifts=cr.shifts, days=cr.days, unit=cr.unit,
            at_least=cr.at_least, at_most=cr.at_most, target=cr.target,
        )
    if isinstance(cr, InlineOccurrence):
        return Occurrence(
            **common, people=cr.people, pattern=cr.pattern, starts=cr.starts,
            at_least=cr.at_least, at_most=cr.at_most,
        )
    return Balance(**common, people=cr.people, shifts=cr.shifts, days=cr.days, max_spread=cr.max_spread)


def _history(b: InlineSolveIn, fac: Facility) -> dict[str, list[str]]:
    known = {s.staff_id for s in fac.staff}
    return {sid: list(seq) for sid, seq in b.history.items() if sid in known and seq}


def _prepare_fixed(
    b: InlineSolveIn,
    fac: Facility,
    mo: Month,
    carry: dict[str, str],
    history: dict[str, list[str]] | None = None,
) -> dict[str, dict[int, str]] | None:
    staff_map = {s.staff_id: s for s in fac.staff}
    st_map = fac.shift_map()
    ake_ids = set(fac.ake_shift_ids())
    unavail_map = {sid: set(_days(ds, mo.days)) for sid, ds in b.unavailable.items()}
    fixed: dict[str, dict[int, str]] = {}
    for sid, dm in sorted(b.fixed.items()):
        if sid not in staff_map:
            continue
        row = {d: sh for d, sh in dm.items() if 1 <= d <= mo.days}
        if row:
            fixed[sid] = row
    if not fixed:
        return None
    hist_map = history or {}
    for sid, dm in sorted(fixed.items()):
        allowed = set(staff_map[sid].shifts)
        unavail = unavail_map.get(sid, set())
        h = hist_map.get(sid)
        for d, sh in sorted(dm.items()):
            if sh == OFF:
                continue
            if sh not in allowed:
                raise ServiceError(422, f"{sid} の {d}日 は入れない勤務帯（{sh}）を固定できません")
            if d in unavail:
                raise ServiceError(422, f"{sid} の {d}日 は入れない日に勤務（{sh}）を固定できません")
            prev = (h[-1] if h else carry.get(sid)) if d == 1 else dm.get(d - 1)
            if prev in ake_ids:
                prev_name = st_map[prev].name if prev in st_map else prev
                raise ServiceError(422, f"{sid} の {d}日 は{prev_name}の翌日のため勤務（{sh}）を固定できません")
    return fixed


def _app_labor(
    bd: _Build,
    carry: dict[str, str],
    days_cap_override: set[str] | frozenset[str] = frozenset(),
    history: dict[str, list[str]] | None = None,
    max_run: int = APP_MAX_RUN,
) -> None:
    """画面の労務チェック（src/core/labor.ts）と同じ数え方の硬制約。
    画面は夜勤明けの日も勤務日として連勤に数え、公休は「勤務も明けもない日」で数える。"""
    N = bd.N
    hist_map = history or {}
    work_ids = bd.work_ids
    ake_ids = set(bd._ake_shifts)
    for s in bd.staff:
        sid = s.staff_id
        h = hist_map.get(sid)
        last_prev = h[-1] if h else carry.get(sid, "")
        cov = []
        for d in range(1, N + 1):
            if d > 1:
                prev = sum(bd.x[sid, d - 1, ak] for ak in ake_ids) if ake_ids else 0
            else:
                prev = 1 if last_prev in ake_ids else 0
            cov.append(sum(bd.x[sid, d, k] for k in work_ids) + prev)   # 明け対象勤務の翌日は休みなので高々1
        if h:
            pre_cov = [1 if (h[j] or (j > 0 and h[j - 1] in ake_ids)) else 0 for j in range(len(h))]
            full_cov = pre_cov + cov
            pre_len = len(pre_cov)
            start_i = max(0, pre_len - max_run)
            for i in range(start_i, len(full_cov) - max_run):
                min_possible = sum(pre_cov[i:pre_len]) + (
                    1 if last_prev in ake_ids and i <= pre_len < i + max_run + 1 else 0
                )
                if min_possible > max_run:
                    # 前月末の実績と1日目の夜勤明けだけで既に上限超過する変更不能な窓は飛ばし、2日目以降や他職員の制約を維持する
                    continue
                bd.m.add(sum(full_cov[i:i + max_run + 1]) <= max_run)
        else:
            for i in range(N - max_run):
                bd.m.add(sum(cov[i:i + max_run + 1]) <= max_run)
        if s.employment == "常勤" and not s.is_leader and s.shifts and sid not in days_cap_override:
            bd.m.add(sum(cov) <= N - APP_MIN_OFF)


def _solve_strict(
    fac: Facility,
    mo: Month,
    rules: list,
    carry: dict[str, str],
    time_limit: float,
    workers: int,
    days_cap_override: set[str] | frozenset[str] = frozenset(),
    fixed: dict[str, dict[int, str]] | None = None,
    history: dict[str, list[str]] | None = None,
    max_run: int = APP_MAX_RUN,
    baseline: dict[str, list[str]] | None = None,
) -> MonthlyResult:
    """solve_monthly と同じ組み立てに、画面の労務チェックを足して解く（解けなければ呼び出し側が通常の solve_monthly に戻す）。"""
    t0 = time.time()
    bd = _Build(fac, mo, rules, fixed=fixed, carry_in=carry, relax=False, boost=None, baseline=None, use_coverage=False,
                history=history)
    _app_labor(bd, carry, days_cap_override, history=history, max_run=max_run)
    if baseline is not None:
        st_name, cells, broken, obj, _sf, extra = solve_two_stage(bd, baseline, time_limit=time_limit, workers=workers)
        res = MonthlyResult(
            status=st_name,
            cells=cells,
            soft_broken=broken,
            objective=obj,
            wall_ms=int((time.time() - t0) * 1000),
            stats={"vars": len(bd.x), "instances": len(bd.insts), "strict": True, **extra},
        )
        return res
    s = cp_model.CpSolver()
    s.parameters.max_time_in_seconds = time_limit
    s.parameters.num_workers = workers
    st = s.solve(bd.m)
    res = MonthlyResult(status=s.status_name(st), stats={"vars": len(bd.x), "instances": len(bd.insts), "strict": True})
    if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        res.cells = _cells(s, bd)
        res.soft_broken = _aggregate(s, bd)
        res.objective = s.objective_value
    res.wall_ms = int((time.time() - t0) * 1000)
    return res


def _need_mode_summary(b: InlineSolveIn, fac: Facility, mo: Month) -> str:
    holidays = set(b.holidays)
    off_t = b.off_target if b.off_target is not None else _default_off_target(mo, holidays)
    eff_sts = fac.effective_shift_types()
    day_ks = [st.id for st in eff_sts if st.group != "夜勤系" and st.counts]
    night_ks = [st.id for st in eff_sts if st.group == "夜勤系" and st.counts]
    day_totals = [sum(_daily_need(b, mo, holidays, k, d) for k in day_ks) for d in range(1, mo.days + 1)]
    night_totals = [sum(_daily_need(b, mo, holidays, k, d) for k in night_ks) for d in range(1, mo.days + 1)]
    d_lo, d_hi = min(day_totals), max(day_totals)
    n_lo, n_hi = min(night_totals), max(night_totals)
    d_str = f"{d_lo}人以上" if d_lo == d_hi else f"{d_lo}〜{d_hi}人以上"
    n_str = f"{n_lo}人" if n_lo == n_hi else f"{n_lo}〜{n_hi}人"
    return f"日勤系は{d_str}、夜勤は{n_str}、公休は月{off_t}日を目標に作りました。"


def _night_avg_summary(fac: Facility, cells: dict[str, list[str]]) -> str | None:
    if fac.ward_night_avg_max is None:
        return None
    win = fac.night_window
    ov_min = {
        st.id: st.night_overlap_minutes(win.start, win.hours)
        for st in fac.effective_shift_types()
        if st.group == "夜勤系" and st.counts
    }
    thresh_min = max(1, fac.night_worker_min_h * 60)
    worker_hs: list[float] = []
    for row in cells.values():
        m_tot = sum(ov_min.get(k, 0) for k in row)
        if m_tot >= thresh_min:
            worker_hs.append(m_tot / 60.0)
    cap_h = fac.ward_night_avg_max
    if not worker_hs:
        return f"病棟の月平均夜勤時間は0.0時間（上限{cap_h}時間・算定対象0人）。"
    avg_h = sum(worker_hs) / len(worker_hs)
    if avg_h > cap_h + 1e-6:
        over = avg_h - cap_h
        return (
            f"病棟の月平均夜勤時間が{avg_h:.1f}時間となり、上限{cap_h}時間を{over:.1f}時間超えています"
            f"（算定対象{len(worker_hs)}人・個人別の夜勤時間上限との併用を推奨）。"
        )
    return (
        f"病棟の月平均夜勤時間は{avg_h:.1f}時間（上限{cap_h}時間以内、算定対象{len(worker_hs)}人）。"
        "特定の人に夜勤が偏らないよう、個人別の夜勤時間上限との併用をおすすめします。"
    )


def solve_inline(b: InlineSolveIn, *, workers: int | None = None) -> dict:
    fac, mo, rules, carry = build(b)
    history = _history(b, fac) or None
    fixed = _prepare_fixed(b, fac, mo, carry, history=history)
    w = workers or DEFAULT_WORKERS
    tl = min(b.time_limit, MAX_TIME)
    max_run = b.max_run if b.max_run is not None else APP_MAX_RUN
    r = _solve_strict(fac, mo, rules, carry, tl, w, _days_cap_override(b), fixed=fixed, history=history, max_run=max_run, baseline=b.baseline)
    if r.status not in ("OPTIMAL", "FEASIBLE"):
        # 画面の労務チェックまで入れると解けない → 通常の月次（解けなければ破れ量も返す）
        spent = r.wall_ms
        r = solve_monthly(fac, mo, rules, fixed=fixed, carry_in=carry, baseline=b.baseline, use_coverage=False,
                          time_limit=max(1.0, tl - spent / 1000), workers=w, history=history, two_stage=bool(b.baseline))
        r.wall_ms += spent
    strict = bool(r.stats.get("strict"))
    explanation = explain_monthly(r)
    if r.status in ("OPTIMAL", "FEASIBLE") and not strict:
        relaxed_note = (
            f"人が足りないため、「夜勤明けも連勤に数える（{max_run}日まで）」「常勤は月{APP_MIN_OFF}日以上休む」を外して作りました。"
            "外したことで守れていない箇所は、労務の警告に出ています。"
        ) if max_run != APP_MAX_RUN else LABOR_RELAXED_NOTE
        explanation = [relaxed_note] if not r.soft_broken else [relaxed_note, *explanation]
    elif r.status not in ("OPTIMAL", "FEASIBLE") and fixed:
        n_fixed = sum(len(dm) for dm in fixed.values())
        if r.relaxation:
            reasons = "・".join(x.label for x in r.relaxation[:2])
            note = f"固定した{n_fixed}件が、「{reasons}」と両立しません。"
        else:
            note = f"固定した{n_fixed}件が、ほかの条件と両立しません。"
        explanation = [note, *explanation]
    if r.status in ("OPTIMAL", "FEASIBLE") and b.need_mode == "min":
        explanation = [_need_mode_summary(b, fac, mo), *explanation]
    if r.status in ("OPTIMAL", "FEASIBLE") and b.ward_night_avg_max is not None:
        navg_line = _night_avg_summary(fac, r.cells)
        if navg_line:
            explanation = [*explanation, navg_line]
    head_notes: list[str] = []
    if b.max_run is not None and b.max_run >= 6:
        head_notes.append(f"連続勤務の上限を{b.max_run}日にしています（日本看護協会の目安は5日）。")
    if b.min_interval_h is not None and b.min_interval_h < 11:
        head_notes.append(f"勤務と勤務の間隔を{b.min_interval_h:g}時間以上にしています（日本看護協会の目安は11時間）。")
    if head_notes:
        explanation = [*head_notes, *explanation]
    changed_out: dict | None = None
    if r.status in ("OPTIMAL", "FEASIBLE") and b.baseline is not None:
        changed_cells = [
            {
                "staff_id": s.staff_id,
                "day": d,
                "before": "" if b.baseline[s.staff_id][d - 1] in ("", OFF) else b.baseline[s.staff_id][d - 1],
                "after": r.cells[s.staff_id][d - 1],
            }
            for s in fac.staff
            for d in range(1, mo.days + 1)
            if ("" if b.baseline[s.staff_id][d - 1] in ("", OFF) else b.baseline[s.staff_id][d - 1]) != r.cells[s.staff_id][d - 1]
        ]
        changed_out = {"count": len(changed_cells), "cells": changed_cells}
        bl_notes = [f"前の表から変わった勤務は{len(changed_cells)}件です。"]
        if r.stats.get("baseline_timeout"):
            bl_notes.append("前の表に寄せる時間がありませんでした。")
        explanation = [*bl_notes, *explanation]
    out = {"month": b.month, "days": mo.days, "first_weekday": mo.first_weekday, "status": r.status, "wall_ms": r.wall_ms,
           "app_labor_rules": strict, "explanation": explanation}
    if changed_out is not None:
        out["changed"] = changed_out
    if r.status in ("OPTIMAL", "FEASIBLE"):
        out["cells"] = r.cells
        out["soft_broken"] = [{"rule_id": x.rule_id, "label": x.label, "count": x.count, "detail": x.detail} for x in r.soft_broken]
    else:
        out["cells"] = {}
        out["relaxation"] = [{"rule_id": x.rule_id, "label": x.label, "count": x.count, "detail": x.detail} for x in r.relaxation]
    return out
