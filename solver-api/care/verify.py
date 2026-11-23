"""勤務表を、ソルバーとは別の素朴な Python で検証する。

使いどころ: ① ソルバーの出力の独立した確認（テスト） ② リーダーが手で直した表・AI案の検証（破れの一覧を返す）
ソルバーと同じ意味をそのまま評価する。速さは求めない。
"""
from __future__ import annotations

from .dsl import OFF, PUBLIC_OFF, WORK_SHIFTS, Balance, Count, Facility, Month, Occurrence, Request, Staffing, Succession

WORK_H = {"早番": 8, "日勤": 8, "遅番": 8, "夜勤": 13}


def _kind(cells: dict[str, list[str]], sid: str, d: int) -> str:
    return cells[sid][d - 1] or OFF


def _match_kinds(
    cells: dict[str, list[str]],
    sid: str,
    d: int,
    kinds: list[str],
    last_prev: str,
    ake_shifts: tuple[str, ...] = ("夜勤",),
) -> bool:
    k = _kind(cells, sid, d)
    if k != OFF:
        return k in kinds
    if OFF in kinds:
        return True
    if PUBLIC_OFF in kinds:
        prev = last_prev if d == 1 else _kind(cells, sid, d - 1)
        return prev not in ake_shifts
    return False


def verify_monthly(fac: Facility, month: Month, cells: dict[str, list[str]], rules: list,
                   carry_in: dict[str, str] | None = None,
                   history: dict[str, list[str]] | None = None) -> dict[str, int]:
    """rule_id -> 破れたインスタンス数（0 は含めない）。allowed shifts と1日1勤務も確認する。"""
    broken: dict[str, int] = {}
    bump = lambda rid, n=1: broken.__setitem__(rid, broken.get(rid, 0) + n)  # noqa: E731
    N = month.days
    eff_sts = fac.effective_shift_types()
    work_ids = fac.work_shift_ids()
    work_set = set(work_ids)
    ake_ids = fac.ake_shift_ids()
    work_min = {st.id: st.work_minutes() for st in eff_sts}
    staff = {s.staff_id: s for s in fac.staff}
    carry = carry_in or {}
    hist = history or {}
    last_prev_of = {
        sid: (hist[sid][-1] if hist.get(sid) else carry.get(sid, ""))
        for sid in staff
    }
    for sid, s in staff.items():
        for d in range(1, N + 1):
            k = _kind(cells, sid, d)
            if k != OFF and k not in s.shifts:
                bump("allowed-shift")
    for r in rules:
        act = [d for d in range(1, N + 1) if month.active(r, d)]       # 停止・期限（期限の日までだけ効く）
        if not act:
            continue
        people = [s for s in fac.staff if r.people.match(s)] if hasattr(r, "people") else []
        days = [d for d in act if r.days.match(d, month.weekday(d))] if hasattr(r, "days") else []
        if isinstance(r, Staffing):
            kinds = r.shifts.kinds(work_ids)
            for d in days:
                tot = sum(1 for p in people if _kind(cells, p.staff_id, d) in kinds)
                if (r.at_least is not None and tot < r.at_least) or (r.at_most is not None and tot > r.at_most):
                    bump(r.id)
        elif isinstance(r, Request):
            kinds = r.shifts.kinds(work_ids)
            for p in people:
                for d in days:
                    has = _kind(cells, p.staff_id, d) in kinds
                    if has != r.want:
                        bump(r.id)
        elif isinstance(r, Succession):
            if r.max_run is not None:
                for p in people:
                    for s0 in range(1, N - r.max_run + 1):
                        if s0 in act and all(_kind(cells, p.staff_id, s0 + i) in work_set for i in range(r.max_run + 1)):
                            bump(r.id)
            else:
                pats = [sel.kinds(work_ids) for sel in r.pattern]
                for p in people:
                    for s0 in range(1, N - len(pats) + 2):
                        if s0 not in act:
                            continue
                        match = all(_kind(cells, p.staff_id, s0 + i) in ks for i, ks in enumerate(pats))
                        if match == r.forbid:
                            bump(r.id)
        elif isinstance(r, Count):
            kinds = r.shifts.kinds(work_ids)
            for p in people:
                if r.unit == "回":
                    tot = sum(1 for d in days if _match_kinds(cells, p.staff_id, d, kinds, last_prev_of[p.staff_id], ake_ids))
                    if (r.at_least is not None and tot < int(r.at_least)) or (r.at_most is not None and tot > int(r.at_most)):
                        bump(r.id)
                    elif r.target is not None and tot != int(r.target):
                        bump(r.id)
                else:
                    tot_min = sum(work_min.get(_kind(cells, p.staff_id, d), 0) for d in days if _kind(cells, p.staff_id, d) in kinds)
                    lo_min = int(round(r.at_least * 60)) if r.at_least is not None else None
                    hi_min = int(round(r.at_most * 60)) if r.at_most is not None else None
                    tg_min = int(round(r.target * 60)) if r.target is not None else None
                    if (lo_min is not None and tot_min < lo_min) or (hi_min is not None and tot_min > hi_min):
                        bump(r.id)
                    elif tg_min is not None and tot_min != tg_min:
                        bump(r.id)
        elif isinstance(r, Balance):
            kinds = r.shifts.kinds(work_ids)
            cnts = [sum(1 for d in days if _match_kinds(cells, p.staff_id, d, kinds, last_prev_of[p.staff_id], ake_ids)) for p in people]
            if cnts and max(cnts) - min(cnts) > r.max_spread:
                bump(r.id)
        elif isinstance(r, Occurrence):
            pats = [sel.kinds(work_ids) for sel in r.pattern]
            L = len(pats)
            start_days = [d for d in act if r.starts.match(d, month.weekday(d)) and d + L - 1 <= N]
            for p in people:
                cnt = sum(
                    1
                    for d in start_days
                    if all(_match_kinds(cells, p.staff_id, d + i, ks, last_prev_of[p.staff_id], ake_ids) for i, ks in enumerate(pats))
                )
                if (r.at_least is not None and cnt < r.at_least) or (r.at_most is not None and cnt > r.at_most):
                    bump(r.id)
    # 前月末からの引き継ぎ（明け対象勤務の翌日は休み・既定4区分で遅番→早番）
    has_default_interval = (not fac.shift_types) and ("遅番" in work_set and "早番" in work_set)
    for sid, c in (carry_in or {}).items():
        first = _kind(cells, sid, 1)
        if (c in ake_ids and first != OFF) or (has_default_interval and c == "遅番" and first == "早番"):
            bump("carry-in")
    return broken
