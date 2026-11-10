"""施設ルールの DSL。月次ルールは5型だけ。ここが意味境界。

Gemini も画面も施設設定も、この型を通らずにソルバーへ届かない。
型を増やすと保存形式と画面とソルバーが全部動くので、増やす前に既存の型の組み合わせで表せないか見る。

  staffing  勤務区分 × 人群 × 日付群 ごとの必要人数
  request   人群 × 日付群 × 勤務区分群 の希望・回避（希望休は「休」を希望）
  succession 勤務の連なりの禁止、連続勤務の上限
  count     人ごとの勤務数・時間数の上下限
  balance   人群の間の勤務数の偏り（最大 − 最小）の上限

日次（時間帯別の業務割当）は `TaskRequest` 1型だけを持つ。日課テンプレート自体はルールではなくデータ。

設計の考え方（強度の3段階、来歴と期限、追記専用の編集ログ）は参考リポジトリ ben1san/df-hack26（チームメンバーの作品） に着想を得ているが、
コードは複製せず、介護施設向けに独自に実装している。
"""
from __future__ import annotations

from datetime import date
from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, model_validator

OFF = "休"
WORK_SHIFTS = ("早番", "日勤", "遅番", "夜勤")
ALL_KINDS = (*WORK_SHIFTS, OFF)

Strength = Literal["絶対", "強く", "できれば"]
PENALTY: dict[str, int] = {"強く": 1000, "できれば": 1}  # 絶対は罰点ではなく硬制約


# ---------------------------------------------------------------- 施設の語彙

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

    def kinds(self) -> list[str]:
        return list(WORK_SHIFTS) if self.ids is None else [k for k in self.ids if k in ALL_KINDS]


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
        return self


class Request(RuleBase):
    type: Literal["request"] = "request"
    people: PeopleSel
    days: DaySel
    shifts: ShiftSel                        # 休を含められる（希望休 = 休を希望）
    want: bool = True                       # True=希望 False=回避


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
        return self


class Count(RuleBase):
    type: Literal["count"] = "count"
    people: PeopleSel = Field(default_factory=PeopleSel)
    shifts: ShiftSel
    days: DaySel = Field(default_factory=DaySel)
    unit: Literal["回", "時間"] = "回"
    at_least: float | None = None
    at_most: float | None = None


class Balance(RuleBase):
    """人群の間で勤務数の最大 − 最小が max_spread 以下。人をまたいで集計する点が count と別物。"""
    type: Literal["balance"] = "balance"
    people: PeopleSel = Field(default_factory=PeopleSel)
    shifts: ShiftSel
    max_spread: int


# ---------------------------------------------------------------- 日次の1型

class TaskRequest(RuleBase):
    """人 × 業務 × 時間帯の希望・回避。日次の手修正の反復から生まれる。"""
    type: Literal["taskRequest"] = "taskRequest"
    people: PeopleSel
    task: str
    from_hour: float = 0.0
    to_hour: float = 24.0
    want: bool = False


MonthlyRule = Annotated[Union[Staffing, Request, Succession, Count, Balance], Field(discriminator="type")]
DailyRule = TaskRequest
AnyRule = Annotated[Union[Staffing, Request, Succession, Count, Balance, TaskRequest], Field(discriminator="type")]


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
