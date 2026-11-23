"""施設ルールの DSL。月次ルールは5型だけ。ここが意味境界。

Gemini も画面も施設設定も、この型を通らずにソルバーへ届かない。
型を増やすと保存形式と画面とソルバーが全部動くので、増やす前に既存の型の組み合わせで表せないか見る。

  staffing    勤務区分 × 人群 × 日付群 ごとの必要人数
  request     人群 × 日付群 × 勤務区分群 の希望・回避（希望休は「休」を希望）
  succession  勤務の連なりの禁止、連続勤務の上限
  count       人ごとの勤務数・時間数の上下限・目標
  balance     人群・日付群ごとの勤務数の偏り（最大 − 最小）の上限
  occurrence  人ごとの、月内で完結する勤務並びの出現回数（開始日 × 並び × 上下限）

日次（時間帯別の業務割当）は `TaskRequest` 1型だけを持つ。日課テンプレート自体はルールではなくデータ。

設計の考え方（強度の3段階、来歴と期限、追記専用の編集ログ）は参考リポジトリ ben1san/df-hack26（チームメンバーの作品） に着想を得ているが、
コードは複製せず、介護施設向けに独自に実装している。
"""
from __future__ import annotations

from collections.abc import Sequence
from datetime import date
import re
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, model_validator

OFF = "休"
PUBLIC_OFF = "公休"
WORK_SHIFTS = ("早番", "日勤", "遅番", "夜勤")
ALL_KINDS = (*WORK_SHIFTS, OFF)
RESERVED_SHIFT_IDS = frozenset({OFF, PUBLIC_OFF, "明", "有", "勤務"})

ShiftGroup = Literal["日勤系", "夜勤系", "その他"]
NextDayKind = Literal["なし", "明け"]
_ST_START_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_ST_END_RE = re.compile(r"^(([01]\d|2[0-3]):[0-5]\d|24:00)$")

Strength = Literal["絶対", "強く", "できれば"]
PENALTY: dict[str, int] = {"強く": 1000, "できれば": 1}  # 絶対は罰点ではなく硬制約


def _hhmm_min(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


# ---------------------------------------------------------------- 施設の語彙

class ShiftType(BaseModel):
    """勤務区分（名前・時刻・休憩・群・人数算入・翌日明け）。"""
    id: str = Field(min_length=1, max_length=8)
    name: str = Field(default="", max_length=16)
    short: str = Field(default="", max_length=4)
    start: str = "09:00"
    end: str = "18:00"
    break_min: int | None = Field(default=None, ge=0, le=360)
    group: ShiftGroup = "日勤系"
    counts: bool = True
    next_day: NextDayKind | None = None

    @model_validator(mode="after")
    def _normalize(self):
        if self.id in RESERVED_SHIFT_IDS:
            raise ValueError(f"勤務区分 id に予約語は使えません: {self.id}")
        if not _ST_START_RE.match(self.start):
            raise ValueError(f"勤務区分 {self.id} の開始時刻は HH:MM 形式で指定してください: {self.start}")
        if not _ST_END_RE.match(self.end):
            raise ValueError(f"勤務区分 {self.id} の終了時刻は HH:MM 形式で指定してください: {self.end}")
        if not self.name:
            self.name = self.id
        if not self.short:
            self.short = self.id[:2]
        if self.next_day is None:
            s_min, e_min = self.start_minutes(), self.end_minutes()
            # 日をまたぎ、翌日の 05:00 より後に終わる勤務（16時間夜勤など）は既定で「明け」
            self.next_day = "明け" if (e_min <= s_min and self.end != "24:00" and e_min > 300) else "なし"
        return self

    def start_minutes(self) -> int:
        return _hhmm_min(self.start)

    def end_minutes(self) -> int:
        return _hhmm_min(self.end)

    def span_minutes(self) -> int:
        s, e = self.start_minutes(), self.end_minutes()
        return (e - s) if e > s else (1440 - s + e)

    def effective_break_min(self) -> int:
        if self.break_min is not None:
            return self.break_min
        span = self.span_minutes()
        if span >= 960:
            return 240
        if span > 480:
            return 60
        return 0

    def work_minutes(self) -> int:
        return max(0, self.span_minutes() - self.effective_break_min())

    def work_hours(self) -> float:
        return self.work_minutes() / 60.0

    def night_overlap_minutes(self, win_start: str = "16:00", win_hours: int = 16) -> int:
        """夜勤時間帯（win_start から連続 win_hours 時間）との重なり（分・休憩は引かない）。"""
        s0 = self.start_minutes()
        e0 = s0 + self.span_minutes()
        w0 = _hhmm_min(win_start)
        w1 = w0 + win_hours * 60
        return sum(max(0, min(e0, w1 + k) - max(s0, w0 + k)) for k in (-1440, 0, 1440))


DEFAULT_SHIFT_TYPES: tuple[ShiftType, ...] = (
    ShiftType(id="早番", name="早番", short="早", start="07:00", end="16:00", break_min=60, group="日勤系", counts=True, next_day="なし"),
    ShiftType(id="日勤", name="日勤", short="日", start="09:00", end="18:00", break_min=60, group="日勤系", counts=True, next_day="なし"),
    ShiftType(id="遅番", name="遅番", short="遅", start="12:00", end="21:00", break_min=60, group="日勤系", counts=True, next_day="なし"),
    ShiftType(id="夜勤", name="夜勤", short="夜", start="16:30", end="09:30", break_min=240, group="夜勤系", counts=True, next_day="明け"),
)


class NightWindow(BaseModel):
    """72時間ルールの夜勤時間帯（22:00〜05:00 を含む連続16時間が基本）。"""
    start: str = "16:00"
    end: str | None = None
    hours: int = Field(default=16, ge=1, le=24)

    @model_validator(mode="after")
    def _check(self):
        if not _ST_START_RE.match(self.start):
            raise ValueError(f"night_window.start は HH:MM 形式で指定してください: {self.start}")
        if self.end is not None:
            if not _ST_END_RE.match(self.end):
                raise ValueError(f"night_window.end は HH:MM 形式で指定してください: {self.end}")
            s, e = _hhmm_min(self.start), _hhmm_min(self.end)
            span = (e - s) if e > s else (1440 - s + e)
            if span % 60 == 0 and 60 <= span <= 1440:
                self.hours = span // 60
        return self


class StaffMember(BaseModel):
    staff_id: str
    name: str
    role: str                       # 主任 / 介護福祉士 / 介護職員 / 新人
    employment: str                 # 常勤 / パート
    years: int = 0
    skills: list[str] = Field(default_factory=list)
    shifts: list[str] = Field(default_factory=list)   # 入れる勤務区分
    home_unit: str | None = None
    leave_by: str | None = None     # 退勤上限 "15:00"
    is_leader: bool = False


class TaskTemplate(BaseModel):
    """日課テンプレート。ルールではなく施設のデータ。"""
    template_id: str
    task: str                       # wake / meal / bath / excretion / med / round / ...
    start: str                      # "HH:MM"
    end: str
    headcount: int
    skill: str | None = None
    note: str = ""


class Facility(BaseModel):
    facility_id: str
    name: str
    staff: list[StaffMember]
    templates: list[TaskTemplate] = Field(default_factory=list)
    need_per_shift: dict[str, int] = Field(default_factory=dict)
    shift_types: list[ShiftType] = Field(default_factory=list)
    ward_night_avg_max: int | None = Field(default=None, ge=1, le=200)
    night_window: NightWindow = Field(default_factory=NightWindow)
    night_worker_min_h: int = Field(default=16, ge=0, le=100)

    @model_validator(mode="after")
    def _unique_shift_types(self):
        seen: set[str] = set()
        for st in self.shift_types:
            if st.id in seen:
                raise ValueError(f"勤務区分 id が重複しています: {st.id}")
            seen.add(st.id)
        return self

    def effective_shift_types(self) -> list[ShiftType]:
        return list(self.shift_types) if self.shift_types else list(DEFAULT_SHIFT_TYPES)

    def work_shift_ids(self) -> tuple[str, ...]:
        return tuple(st.id for st in self.effective_shift_types())

    def shift_map(self) -> dict[str, ShiftType]:
        return {st.id: st for st in self.effective_shift_types()}

    def ake_shift_ids(self) -> tuple[str, ...]:
        return tuple(st.id for st in self.effective_shift_types() if st.next_day == "明け")

    def night_shift_ids(self) -> tuple[str, ...]:
        return tuple(st.id for st in self.effective_shift_types() if st.group == "夜勤系")

    def counting_shift_ids(self) -> tuple[str, ...]:
        return tuple(st.id for st in self.effective_shift_types() if st.counts)


# ---------------------------------------------------------------- 選択子

class PeopleSel(BaseModel):
    ids: list[str] | None = None
    roles: list[str] | None = None
    skills: list[str] | None = None        # いずれかを持つ
    employment: str | None = None

    def match(self, s: StaffMember) -> bool:
        if self.ids is not None and s.staff_id not in self.ids:
            return False
        if self.roles is not None and s.role not in self.roles:
            return False
        if self.skills is not None and not set(self.skills) & set(s.skills):
            return False
        if self.employment is not None and s.employment != self.employment:
            return False
        return True


class DaySel(BaseModel):
    """曜日は 0=日 .. 6=土。dates は 1 始まりの日。"""
    weekdays: list[int] | None = None
    dates: list[int] | None = None
    named: Literal["平日", "休日"] | None = None

    def match(self, day: int, weekday: int) -> bool:
        if self.weekdays is not None and weekday not in self.weekdays:
            return False
        if self.dates is not None and day not in self.dates:
            return False
        if self.named == "平日" and weekday in (0, 6):
            return False
        if self.named == "休日" and weekday not in (0, 6):
            return False
        return True


class ShiftSel(BaseModel):
    ids: list[str] | None = None            # None = 休を除くすべての勤務

    def kinds(self, work_shifts: Sequence[str] = WORK_SHIFTS) -> list[str]:
        if self.ids is None:
            return list(work_shifts)
        allowed = set(work_shifts) | {OFF, PUBLIC_OFF}
        return [k for k in self.ids if k in allowed]


# ---------------------------------------------------------------- 来歴と寿命

OriginKind = Literal["施設設定", "日課から導出", "反復検出", "リーダーの言葉", "手入力", "デモ用の仮値"]


class Origin(BaseModel):
    """来歴。次のリーダーはルール一覧を読むだけで前任の暗黙知を受け取れる。"""
    kind: OriginKind = "手入力"
    evidence: str | None = None
    detected_from: list[str] = Field(default_factory=list)   # 編集ログの edit_id
    approved_by: str | None = None
    approved_at: date | None = None


class Lifecycle(BaseModel):
    """反復が生み、期限と不使用が殺す。"""
    expires_on: date | None = None
    stopped: bool = False

    def active_on(self, d: date) -> bool:
        return not self.stopped and (self.expires_on is None or d <= self.expires_on)


class RuleBase(BaseModel):
    id: str
    label: str                              # リーダーが読む1行
    strength: Strength = "絶対"
    origin: Origin = Field(default_factory=Origin)
    lifecycle: Lifecycle = Field(default_factory=Lifecycle)
    locked: bool = False                    # 施設基準由来など。破るときは理由の記録を要する

    def active_on(self, d: date) -> bool:
        """その日に効くか（停止していない・期限内）。期限 expires_on の日までは効く。"""
        return self.lifecycle.active_on(d)


# ---------------------------------------------------------------- 月次の5型

class Staffing(RuleBase):
    type: Literal["staffing"] = "staffing"
    shifts: ShiftSel
    people: PeopleSel = Field(default_factory=PeopleSel)
    days: DaySel = Field(default_factory=DaySel)
    at_least: int | None = None
    at_most: int | None = None

    @model_validator(mode="after")
    def _bounds(self):
        if self.at_least is None and self.at_most is None:
            raise ValueError("staffing は at_least か at_most のどちらかが要る")
        if self.shifts.ids and PUBLIC_OFF in self.shifts.ids:
            raise ValueError("staffing では 公休 を使えません")
        return self


class Request(RuleBase):
    type: Literal["request"] = "request"
    people: PeopleSel
    days: DaySel
    shifts: ShiftSel                        # 休を含められる（希望休 = 休を希望）
    want: bool = True                       # True=希望 False=回避

    @model_validator(mode="after")
    def _no_public_off(self):
        if self.shifts.ids and PUBLIC_OFF in self.shifts.ids:
            raise ValueError("request では 公休 を使えません")
        return self


class Succession(RuleBase):
    type: Literal["succession"] = "succession"
    people: PeopleSel = Field(default_factory=PeopleSel)
    pattern: list[ShiftSel] | None = None   # 連なりの形（連続する日）
    forbid: bool = True
    max_run: int | None = None              # 休み以外の連続日数の上限

    @model_validator(mode="after")
    def _one_of(self):
        if (self.pattern is None) == (self.max_run is None):
            raise ValueError("succession は pattern か max_run のどちらか一方")
        if self.pattern and any(sel.ids and PUBLIC_OFF in sel.ids for sel in self.pattern):
            raise ValueError("succession では 公休 を使えません")
        return self


class Count(RuleBase):
    type: Literal["count"] = "count"
    people: PeopleSel = Field(default_factory=PeopleSel)
    shifts: ShiftSel
    days: DaySel = Field(default_factory=DaySel)
    unit: Literal["回", "時間"] = "回"
    at_least: float | None = None
    at_most: float | None = None
    target: int | None = None

    @model_validator(mode="after")
    def _check_target(self):
        if self.at_least is not None and self.at_most is not None and self.at_least > self.at_most:
            raise ValueError("Count は at_least <= at_most にしてください")
        if self.target is not None:
            if self.strength == "絶対":
                raise ValueError("Count の target は絶対（硬制約）では使えません")
            if self.target < 0:
                raise ValueError("Count の target は 0 以上にしてください")
            if (self.at_least is not None and self.target < self.at_least) or (
                self.at_most is not None and self.target > self.at_most
            ):
                raise ValueError("Count の target が上下限と矛盾しています")
        return self


class Balance(RuleBase):
    """人群・日付群の間で勤務数の最大 − 最小が max_spread 以下。人をまたいで集計する点が count と別物。"""
    type: Literal["balance"] = "balance"
    people: PeopleSel = Field(default_factory=PeopleSel)
    shifts: ShiftSel
    days: DaySel = Field(default_factory=DaySel)
    max_spread: int

    def members(self, staff: Sequence["StaffMember"], work_shifts: Sequence[str] = WORK_SHIFTS) -> list["StaffMember"]:
        """差をそろえる人。勤務（夜勤など）の差なら、その勤務に入れる人だけにする。
        入れない人（いつも0回）を混ぜると「差◯回以内」が「全員◯回以下」に変わってしまうため（2026-11-24 の実測：
        夜勤に入れない7名を含めた「全員の土日夜勤の差は1回以内」は、絶対にすると作れなかった）。休み・公休の差は全員。"""
        kinds = self.shifts.kinds(work_shifts)
        people = [s for s in staff if self.people.match(s)]
        if not kinds or any(k in (OFF, PUBLIC_OFF) for k in kinds):
            return people
        return [s for s in people if any(k in s.shifts for k in kinds)]


class Occurrence(RuleBase):
    """人ごとに、月の中で完結する勤務並びの出現回数（重なりは数える・月またぎは数えない）。"""
    type: Literal["occurrence"] = "occurrence"
    people: PeopleSel = Field(default_factory=PeopleSel)
    pattern: list[ShiftSel]
    starts: DaySel = Field(default_factory=DaySel)
    at_least: int | None = None
    at_most: int | None = None

    @model_validator(mode="after")
    def _check(self):
        if len(self.pattern) < 2:
            raise ValueError("Occurrence の pattern は2日以上にしてください")
        if self.at_least is None and self.at_most is None:
            raise ValueError("Occurrence は at_least か at_most のどちらかが要る")
        for val in (self.at_least, self.at_most):
            if val is not None and val < 0:
                raise ValueError("Occurrence の回数は 0 以上にしてください")
        if self.at_least is not None and self.at_most is not None and self.at_least > self.at_most:
            raise ValueError("Occurrence は at_least <= at_most にしてください")
        return self


# ---------------------------------------------------------------- 日次の1型

class TaskRequest(RuleBase):
    """人 × 業務 × 時間帯の希望・回避。日次の手修正の反復から生まれる。"""
    type: Literal["taskRequest"] = "taskRequest"
    people: PeopleSel
    task: str
    from_hour: float = 0.0
    to_hour: float = 24.0
    want: bool = False


MonthlyRule = Annotated[Union[Staffing, Request, Succession, Count, Balance, Occurrence], Field(discriminator="type")]
DailyRule = TaskRequest
AnyRule = Annotated[Union[Staffing, Request, Succession, Count, Balance, Occurrence, TaskRequest], Field(discriminator="type")]


# ---------------------------------------------------------------- 表

class Month(BaseModel):
    """提案と現状を別に持つ。棄却 = 提案があって現状が違うセル。"""
    month: str                              # YYYY-MM
    days: int
    first_weekday: int                      # 1日の曜日 0=日
    proposal: dict[str, list[str]] = Field(default_factory=dict)   # staff_id -> 日ごとの勤務（空文字=休）
    current: dict[str, list[str]] = Field(default_factory=dict)

    def weekday(self, day: int) -> int:
        return (self.first_weekday + day - 1) % 7

    def date_of(self, day: int) -> date | None:
        """月の day 日の日付。month が YYYY-MM でなければ None（期限の判定をしない）。"""
        try:
            y, m = map(int, self.month.split("-"))
            return date(y, m, day)
        except (ValueError, TypeError):
            return None

    def active(self, rule, day: int) -> bool:
        """ルールが day 日に効くか（停止・期限）。期限が月の途中で切れるルールは、期限の日までだけ効く。"""
        if rule.lifecycle.stopped:
            return False
        d = self.date_of(day)
        return d is None or rule.lifecycle.active_on(d)
