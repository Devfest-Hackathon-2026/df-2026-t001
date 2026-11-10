"""欠員の候補が「ソルバーの必須ルール」を破らないかを、候補ごとに確かめる（POST /api/v1/rank-candidates の cells 指定時）。

* 画面は、その月の勤務（cells: staff_id -> 日ごとの勤務。"" は休み）を送る。氏名は受け取らない。
* 候補ごとに「その人が欠員の日にその勤務を引き受けた」仮の勤務表を作り、その人の行を検証する。
* ルールは inline_solve（シフト作成君の月次）の最初の解き方と同じもの:
  - inline_solve.build が組み立てる絶対ルールのうち、人ごとの行で決まるもの（夜勤明け・遅番→早番・夜勤の上限）
    → verify.verify_monthly でそのまま評価する
  - 画面の労務チェック（labor.ts と inline_solve._app_labor）: 夜勤明けも勤務日に数えた連勤の上限・常勤の公休8日以上
  - 勤務区分（その人が入れる勤務か）・前月末からの引き継ぎ（carry_in）
* 「引き受けたことで新しく破れる」ものだけを理由にする（すでに破れている窓・回数は、候補のせいにしない）。
* 施設全体の人数（r-staff-*）は、欠員の枠を埋める向きにしか動かないので候補の判定には使わない。
  「強く」「できれば」の軟制約（夜勤の医療的ケア・公平性など）も除外の理由にしない。
"""
from __future__ import annotations

import calendar
from datetime import date as Date

from .dsl import OFF, WORK_SHIFTS, Count, Facility, Month, StaffMember, Succession
from .inline_solve import APP_MAX_NIGHTS, APP_MAX_RUN, APP_MIN_OFF, InlineSolveIn, InlineStaff, build
from .verify import verify_monthly

# 理由として先に挙げる順（複数破れるときは、この順で最初の1つ）
ORDER = ("allowed-shift", "one-per-day", "carry-in", "r-ake", "r-interval", "r-run", "r-night-cap", "app-min-off")
LABEL_RUN = f"連続勤務は{APP_MAX_RUN}日まで（夜勤明けも勤務日に数える・デモ用の仮値）"
LABEL_OFF = f"常勤の公休は月{APP_MIN_OFF}日以上（夜勤明けは公休に数えない・デモ用の仮値）"
FIXED = {"allowed-shift": "入れる勤務区分ではない", "one-per-day": "1日に1勤務まで",
         "carry-in": "前月末の夜勤明けは休み・遅番の翌日に早番を置かない（デモ用の仮値）"}


def month_of(day: str, month_days: int | None = None, first_weekday: int | None = None) -> Month | None:
    """欠員日の月。画面が送った日数・曜日が暦と合わなければ None（cells を使わない）。"""
    d = Date.fromisoformat(day)
    n = calendar.monthrange(d.year, d.month)[1]
    fw = Date(d.year, d.month, 1).isoweekday() % 7
    if month_days not in (None, n) or first_weekday not in (None, fw):
        return None
    return Month(month=day[:7], days=n, first_weekday=fw)


CODES = {"", OFF, *WORK_SHIFTS}


def check_cells(cells: dict[str, list[str]], day: str) -> None:
    """画面が送った cells の形を確かめる（リクエストの検証で呼ぶ。合わなければ 422）。"""
    d = Date.fromisoformat(day)
    n = calendar.monthrange(d.year, d.month)[1]
    for sid, row in cells.items():
        if not 1 <= len(sid) <= 40:
            raise ValueError("cells の staff_id が不正です")
        if len(row) != n:
            raise ValueError(f"cells[{sid}] は {n} 日分が必要です（{len(row)} 日分）")
        bad = sorted({k for k in row if k not in CODES})
        if bad:
            raise ValueError(f"cells[{sid}] の勤務区分が不正です: {bad[:3]}")


def _cov(row: list[str], carry: str | None) -> list[int]:
    """画面（labor.ts）の数え方: 勤務の日と夜勤明けの日を 1。"""
    out = []
    for i, k in enumerate(row):
        prev = row[i - 1] if i else (carry or "")
        out.append(1 if (k in WORK_SHIFTS or prev == "夜勤") else 0)
    return out


def _app_labor(row: list[str], carry: str | None, s: StaffMember) -> dict[str, int]:
    """inline_solve._app_labor と同じ硬制約の破れ数（連勤の窓の数・公休の不足）。"""
    c = _cov(row, carry)
    N = len(row)
    out: dict[str, int] = {}
    run = sum(1 for i in range(N - APP_MAX_RUN) if sum(c[i:i + APP_MAX_RUN + 1]) > APP_MAX_RUN)
    if run:
        out["r-run"] = run
    if s.employment == "常勤" and not s.is_leader and s.shifts:
        short = max(0, sum(c) - (N - APP_MIN_OFF))
        if short:
            out["app-min-off"] = short
    return out


class RowChecker:
    """inline_solve と同じルールで、1人の行の破れを数える。候補ごとに作り直さず使い回す。"""

    def __init__(self, mo: Month, staff: list[InlineStaff], night_max: int | None = None):
        self.mo = mo
        # ルールの組み立ては inline_solve.build そのもの（人数の基準は 0 にして、人ごとのルールだけを残す）
        b = InlineSolveIn(month=mo.month, staff=staff[:1], need_per_shift={k: 0 for k in WORK_SHIFTS}, night_max=night_max)
        _, _, rules, _ = build(b)
        self.staff = {s.staff_id: StaffMember(name=s.staff_id, **s.model_dump()) for s in staff}
        # 人ごとの行だけで決まる絶対ルール。r-run は夜勤明けも数える画面の数え方（_app_labor）で置き換える
        self.rules = [r for r in rules if r.strength == "絶対" and isinstance(r, (Succession, Count)) and r.id != "r-run"]
        self.labels = {r.id: r.label for r in self.rules}
        self.labels.update({"r-run": LABEL_RUN, "app-min-off": LABEL_OFF, **FIXED})
        self.cap = night_max or APP_MAX_NIGHTS

    def broken(self, sid: str, row: list[str], carry: str | None) -> dict[str, int]:
        s = self.staff[sid]
        fac = Facility(facility_id="inline", name="inline", staff=[s])
        out = verify_monthly(fac, self.mo, {sid: row}, self.rules, {sid: carry} if carry else None)
        for k, n in _app_labor(row, carry, s).items():
            out[k] = out.get(k, 0) + n
        return out

    def check(self, sid: str, row: list[str], day: int, shift: str, carry: str | None) -> tuple[str, str] | None:
        """sid が day 日に shift を引き受けたら新しく破れる絶対ルール (rule_id, label)。破れなければ None。"""
        if shift not in self.staff[sid].shifts:
            return "allowed-shift", f"{shift}は{self.labels['allowed-shift']}"
        if row[day - 1] not in ("", OFF):
            return "one-per-day", self.labels["one-per-day"]
        before = self.broken(sid, row, carry)
        after_row = list(row)
        after_row[day - 1] = shift
        after = self.broken(sid, after_row, carry)
        new = [k for k, n in after.items() if n > before.get(k, 0)]
        if not new:
            return None
        rid = min(new, key=lambda k: ORDER.index(k) if k in ORDER else len(ORDER))
        return rid, self.labels.get(rid, rid)


def normalize(cells: dict[str, list[str]], ids: list[str], days: int) -> dict[str, list[str]]:
    """送られていない人は全休、"休" は ""。"""
    out = {}
    for sid in ids:
        row = [("" if k == OFF else k) for k in cells.get(sid, [])]
        out[sid] = row if len(row) == days else [""] * days
    return out


def exclude_hard(day: str, shift: str, cands: list, cells: dict[str, list[str]], carry_in: dict[str, str] | None = None,
                 month_days: int | None = None, first_weekday: int | None = None, night_max: int | None = None):
    """cands（inline_rank.StaffIn）のうち、引き受けると絶対ルールを破る人を外す。

    戻り値: (残す人, [{staff_id, reason, rule_id}])。月の日数・曜日が暦と合わないときは何も外さない。"""
    mo = month_of(day, month_days, first_weekday)
    if mo is None or not cands:
        return list(cands), []
    staff = [InlineStaff(staff_id=s.id, role=(s.role or "介護職員")[:20], employment=s.employment, years=int(s.years), skills=list(s.skills),
                         shifts=[k for k in (s.shifts or WORK_SHIFTS) if k in WORK_SHIFTS]) for s in cands]
    chk = RowChecker(mo, staff, night_max)
    rows = normalize(cells, [s.id for s in cands], mo.days)
    carry = {k: v for k, v in (carry_in or {}).items() if v in WORK_SHIFTS}
    d = int(day[8:10])
    kept, out = [], []
    for s in cands:
        hit = chk.check(s.id, rows[s.id], d, shift, carry.get(s.id))
        if hit is None:
            kept.append(s)
        else:
            out.append({"staff_id": s.id, "reason": hit[1], "rule_id": hit[0]})
    return kept, out
