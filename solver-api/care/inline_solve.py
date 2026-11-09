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
import time
from datetime import date

from ortools.sat.python import cp_model
from pydantic import BaseModel, Field, field_validator

from .defaults import default_rules, request_rules
from .dsl import (OFF, WORK_SHIFTS, Balance, Count, DaySel, Facility, Month, Origin, PeopleSel, Request, ShiftSel, Staffing,
                  StaffMember)
from .service import ServiceError
from .solver.explain import explain_monthly
from .solver.monthly import DEFAULT_WORKERS, MonthlyResult, _aggregate, _Build, _cells, solve_monthly

_O = Origin(kind="デモ用の仮値", evidence="デモ用の仮値（法令・施設基準の数値ではない）")
MAX_TIME = 18.0
APP_MAX_RUN = 5       # 画面の LABOR_RULES.maxConsecutive（夜勤明けも勤務日に数える）
APP_MIN_OFF = 8       # 画面の LABOR_RULES.minOffDays（常勤の公休。明けは公休に数えない）
APP_MAX_NIGHTS = 8    # 画面の LABOR_RULES.maxNightsPerMonth


class InlineStaff(BaseModel):
    staff_id: str = Field(max_length=40)
    role: str = Field("介護職員", max_length=20)
    employment: str = Field("常勤", max_length=10)
    years: int = Field(0, ge=0, le=60)
    skills: list[str] = Field(default_factory=list, max_length=20)
    shifts: list[str] = Field(default_factory=list, max_length=4)
    home_unit: str | None = Field(None, max_length=20)
    leave_by: str | None = Field(None, max_length=5)
    is_leader: bool = False

    @field_validator("shifts")
    @classmethod
    def _shifts(cls, v: list[str]) -> list[str]:
        bad = [k for k in v if k not in WORK_SHIFTS]
        if bad:
            raise ValueError(f"勤務区分が不正です: {bad}")
        return v


class InlineSolveIn(BaseModel):
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    days: int | None = Field(None, ge=28, le=31)
    first_weekday: int | None = Field(None, ge=0, le=6)
    staff: list[InlineStaff] = Field(min_length=1, max_length=80)
    need_per_shift: dict[str, int] = Field(default_factory=lambda: {k: 4 for k in WORK_SHIFTS})
    day_off: dict[str, list[int]] = Field(default_factory=dict)       # 希望休（強く）
    unavailable: dict[str, list[int]] = Field(default_factory=dict)   # 入れない日（絶対）。例: 主任の土日
    keep_free: dict[str, list[int]] = Field(default_factory=dict)     # 「入れる日」を出した人は補欠として残したい（できれば）
    carry_in: dict[str, str] = Field(default_factory=dict)            # 前月末日の勤務（夜勤なら1日は明け）
    extra: dict[str, dict[str, int]] = Field(default_factory=dict)    # "YYYY-MM-DD" -> {勤務区分: 追加人数}
    night_max: int | None = Field(None, ge=1, le=15)
    time_limit: float = Field(12.0, ge=1, le=MAX_TIME)

    @field_validator("need_per_shift")
    @classmethod
    def _need(cls, v: dict[str, int]) -> dict[str, int]:
        for k, n in v.items():
            if k not in WORK_SHIFTS or not 0 <= n <= 20:
                raise ValueError(f"need_per_shift が不正です: {k}={n}")
        return v


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


def build(b: InlineSolveIn) -> tuple[Facility, Month, list, dict[str, str]]:
    mo = _month(b)
    ids = [s.staff_id for s in b.staff]
    if len(set(ids)) != len(ids):
        raise ServiceError(400, "staff_id が重複しています")
    known = set(ids)
    fac = Facility(facility_id="inline", name="inline",
                   staff=[StaffMember(name=s.staff_id, **s.model_dump()) for s in b.staff],
                   need_per_shift={k: n for k, n in b.need_per_shift.items() if n > 0})
    N = mo.days

    # 行事の追加人数（日 -> 勤務 -> 人数）
    extra: dict[int, dict[str, int]] = {}
    for ds, row in b.extra.items():
        if not ds.startswith(b.month + "-"):
            continue
        d = int(ds[8:10])
        for k, n in row.items():
            if k in WORK_SHIFTS and 0 < n <= 10 and 1 <= d <= N:
                extra.setdefault(d, {})[k] = n

    replace = {"r-full-days", "r-night-fair", "r-night-medical", *(f"r-staff-{k}" for k in WORK_SHIFTS)}
    rules: list = [r for r in default_rules(fac, mo) if r.id not in replace]
    cap = b.night_max or APP_MAX_NIGHTS
    for r in rules:
        if r.id == "r-night-cap":
            r.at_most = cap
            r.label = f"夜勤は月{cap}回まで（デモ用の仮値）"

    # 必要人数: 毎日ちょうど need 人。行事の日は need+extra 人まで置けて、追加分は「強く」
    for k, n in fac.need_per_shift.items():
        plain = [d for d in range(1, N + 1) if not extra.get(d, {}).get(k)]
        if plain:
            rules.append(Staffing(id=f"r-staff-{k}", label=f"{k}は毎日{n}人（施設の基準人数・仮）", strength="絶対", origin=_O,
                                  shifts=ShiftSel(ids=[k]), days=DaySel(dates=plain), at_least=n, at_most=n))
        for d, row in sorted(extra.items()):
            if row.get(k):
                rules.append(Staffing(id=f"r-staff-{k}-{d}", label=f"{d}日の{k}は{n}人以上（施設の基準人数・仮）", strength="絶対",
                                      origin=_O, shifts=ShiftSel(ids=[k]), days=DaySel(dates=[d]), at_least=n, at_most=n + row[k]))
                rules.append(Staffing(id=f"r-event-{k}-{d}", label=f"{d}日の{k}は行事のため+{row[k]}人", strength="強く", origin=_O,
                                      shifts=ShiftSel(ids=[k]), days=DaySel(dates=[d]), at_least=n + row[k]))

    night_ids = [s.staff_id for s in fac.staff if "夜勤" in s.shifts]
    if len(night_ids) >= 2:
        rules.append(Balance(id="r-night-fair", label="夜勤回数の差は2回以内（夜勤に入れる人どうし）", strength="強く", origin=_O,
                             people=PeopleSel(ids=night_ids), shifts=ShiftSel(ids=["夜勤"]), max_spread=2))
        rules.append(Balance(id="r-night-even", label="夜勤回数の差はできれば1回以内", strength="できれば", origin=_O,
                             people=PeopleSel(ids=night_ids), shifts=ShiftSel(ids=["夜勤"]), max_spread=1))
    if fac.need_per_shift.get("夜勤", 0) >= 2:
        rules.append(Staffing(id="r-night-medical", label="夜勤に医療的ケアができる人を2人以上（各フロア1人）", strength="強く",
                              origin=_O, shifts=ShiftSel(ids=["夜勤"]), people=PeopleSel(skills=["medical"]), at_least=2))
    full_ids = [s.staff_id for s in fac.staff if s.employment == "常勤" and not s.is_leader and s.shifts]
    if len(full_ids) >= 2:
        rules.append(Balance(id="r-full-fair", label="常勤の勤務回数の差は4回以内", strength="強く", origin=_O,
                             people=PeopleSel(ids=full_ids), shifts=ShiftSel(), max_spread=4))
        rules.append(Count(id="r-full-days", label=f"常勤は月{N - 8}日まで（デモ用の仮値）", strength="強く", origin=_O,
                           people=PeopleSel(ids=full_ids), shifts=ShiftSel(), at_most=N - 8))

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

    carry = {sid: k for sid, k in b.carry_in.items() if sid in known and k in WORK_SHIFTS}
    return fac, mo, rules, carry


def _app_labor(bd: _Build, carry: dict[str, str]) -> None:
    """画面の労務チェック（src/core/labor.ts）と同じ数え方の硬制約。
    画面は夜勤明けの日も勤務日として連勤に数え、公休は「勤務も明けもない日」で数える。"""
    N = bd.N
    for s in bd.staff:
        sid = s.staff_id
        cov = []
        for d in range(1, N + 1):
            prev = bd.x[sid, d - 1, "夜勤"] if d > 1 else (1 if carry.get(sid) == "夜勤" else 0)
            cov.append(sum(bd.x[sid, d, k] for k in WORK_SHIFTS) + prev)   # 夜勤明けは必ず休みなので高々1
        for i in range(N - APP_MAX_RUN):
            bd.m.add(sum(cov[i:i + APP_MAX_RUN + 1]) <= APP_MAX_RUN)
        if s.employment == "常勤" and not s.is_leader and s.shifts:
            bd.m.add(sum(cov) <= N - APP_MIN_OFF)


def _solve_strict(fac: Facility, mo: Month, rules: list, carry: dict[str, str], time_limit: float, workers: int) -> MonthlyResult:
    """solve_monthly と同じ組み立てに、画面の労務チェックを足して解く（解けなければ呼び出し側が通常の solve_monthly に戻す）。"""
    t0 = time.time()
    bd = _Build(fac, mo, rules, fixed=None, carry_in=carry, relax=False, boost=None, baseline=None, use_coverage=False)
    _app_labor(bd, carry)
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


def solve_inline(b: InlineSolveIn, *, workers: int | None = None) -> dict:
    fac, mo, rules, carry = build(b)
    w = workers or DEFAULT_WORKERS
    tl = min(b.time_limit, MAX_TIME)
    r = _solve_strict(fac, mo, rules, carry, tl, w)
    if r.status not in ("OPTIMAL", "FEASIBLE"):
        # 画面の労務チェックまで入れると解けない → 通常の月次（解けなければ破れ量も返す）
        spent = r.wall_ms
        r = solve_monthly(fac, mo, rules, carry_in=carry, use_coverage=False, time_limit=max(1.0, tl - spent / 1000), workers=w)
        r.wall_ms += spent
    out = {"month": b.month, "days": mo.days, "first_weekday": mo.first_weekday, "status": r.status, "wall_ms": r.wall_ms,
           "app_labor_rules": bool(r.stats.get("strict")), "explanation": explain_monthly(r)}
    if r.status in ("OPTIMAL", "FEASIBLE"):
        out["cells"] = r.cells
        out["soft_broken"] = [{"rule_id": x.rule_id, "label": x.label, "count": x.count, "detail": x.detail} for x in r.soft_broken]
    else:
        out["cells"] = {}
        out["relaxation"] = [{"rule_id": x.rule_id, "label": x.label, "count": x.count, "detail": x.detail} for x in r.relaxation]
    return out
