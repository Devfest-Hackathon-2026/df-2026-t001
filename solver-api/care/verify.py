"""勤務表を、ソルバーとは別の素朴な Python で検証する。

使いどころ: ① ソルバーの出力の独立した確認（テスト） ② リーダーが手で直した表・AI案の検証（破れの一覧を返す）
ソルバーと同じ意味をそのまま評価する。速さは求めない。
"""
from __future__ import annotations

from .dsl import OFF, WORK_SHIFTS, Balance, Count, Facility, Month, Request, Staffing, Succession

WORK_H = {"早番": 8, "日勤": 8, "遅番": 8, "夜勤": 13}


def _kind(cells: dict[str, list[str]], sid: str, d: int) -> str:
    return cells[sid][d - 1] or OFF


def verify_monthly(fac: Facility, month: Month, cells: dict[str, list[str]], rules: list,
                   carry_in: dict[str, str] | None = None) -> dict[str, int]:
    """rule_id -> 破れたインスタンス数（0 は含めない）。allowed shifts と1日1勤務も確認する。"""
    broken: dict[str, int] = {}
    bump = lambda rid, n=1: broken.__setitem__(rid, broken.get(rid, 0) + n)  # noqa: E731
    N = month.days
    staff = {s.staff_id: s for s in fac.staff}
    for sid, s in staff.items():
        for d in range(1, N + 1):
            k = _kind(cells, sid, d)
            if k != OFF and k not in s.shifts:
                bump("allowed-shift")
    for r in rules:
        if r.lifecycle.stopped:
            continue
        people = [s for s in fac.staff if r.people.match(s)] if hasattr(r, "people") else []
        days = [d for d in range(1, N + 1) if r.days.match(d, month.weekday(d))] if hasattr(r, "days") else []
        if isinstance(r, Staffing):
            kinds = r.shifts.kinds()
            for d in days:
                tot = sum(1 for p in people if _kind(cells, p.staff_id, d) in kinds)
                if (r.at_least is not None and tot < r.at_least) or (r.at_most is not None and tot > r.at_most):
                    bump(r.id)
        elif isinstance(r, Request):
            kinds = r.shifts.kinds()
            for p in people:
                for d in days:
                    has = _kind(cells, p.staff_id, d) in kinds
                    if has != r.want:
                        bump(r.id)
        elif isinstance(r, Succession):
            if r.max_run is not None:
                for p in people:
                    for s0 in range(1, N - r.max_run + 1):
                        if all(_kind(cells, p.staff_id, s0 + i) in WORK_SHIFTS for i in range(r.max_run + 1)):
                            bump(r.id)
            else:
                pats = [sel.kinds() for sel in r.pattern]
                for p in people:
                    for s0 in range(1, N - len(pats) + 2):
                        match = all(_kind(cells, p.staff_id, s0 + i) in ks for i, ks in enumerate(pats))
                        if match == r.forbid:
                            bump(r.id)
        elif isinstance(r, Count):
            kinds = r.shifts.kinds()
            for p in people:
                if r.unit == "回":
                    tot = sum(1 for d in days if _kind(cells, p.staff_id, d) in kinds)
                else:
                    tot = sum(WORK_H[_kind(cells, p.staff_id, d)] for d in days if _kind(cells, p.staff_id, d) in kinds)
                if (r.at_least is not None and tot < int(r.at_least)) or (r.at_most is not None and tot > int(r.at_most)):
                    bump(r.id)
        elif isinstance(r, Balance):
            kinds = r.shifts.kinds()
            cnts = [sum(1 for d in range(1, N + 1) if _kind(cells, p.staff_id, d) in kinds) for p in people]
            if cnts and max(cnts) - min(cnts) > r.max_spread:
                bump(r.id)
    # 前月末からの引き継ぎ（夜勤明け・遅番→早番）
    for sid, c in (carry_in or {}).items():
        first = _kind(cells, sid, 1)
        if (c == "夜勤" and first != OFF) or (c == "遅番" and first == "早番"):
            bump("carry-in")
    return broken
