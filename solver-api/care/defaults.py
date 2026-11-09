"""施設の初期ルール。数値はすべて「デモ用の仮値」で、法令や施設基準の数値ではない。画面・資料にもそう明記する。"""
from __future__ import annotations

from .dsl import (Balance, Count, DaySel, Facility, Month, Origin, PeopleSel, Request, ShiftSel, Staffing, Succession,
                  WORK_SHIFTS, OFF)

_O = Origin(kind="デモ用の仮値", evidence="デモ用の仮値（法令・施設基準の数値ではない）")


def default_rules(fac: Facility, month: Month | None = None) -> list:
    """連続勤務・夜勤明け・勤務間インターバル・夜勤回数・必要人数・公平性など。"""
    n_days = month.days if month else 30
    rules: list = [
        Succession(id="r-run", label="連続勤務は5日まで（デモ用の仮値）", strength="絶対", locked=True, origin=_O, max_run=5),
        Succession(id="r-ake", label="夜勤のあとは翌日を休みにする（デモ用の仮値）", strength="絶対", locked=True, origin=_O,
                   pattern=[ShiftSel(ids=["夜勤"]), ShiftSel(ids=list(WORK_SHIFTS))], forbid=True),
        Succession(id="r-interval", label="遅番のあとに早番を置かない（勤務間インターバル・デモ用の仮値）", strength="絶対", locked=True,
                   origin=_O, pattern=[ShiftSel(ids=["遅番"]), ShiftSel(ids=["早番"])], forbid=True),
        Count(id="r-night-cap", label="夜勤は月9回まで（デモ用の仮値）", strength="絶対", locked=True, origin=_O,
              shifts=ShiftSel(ids=["夜勤"]), at_most=9),
        Count(id="r-full-days", label=f"常勤は月{n_days - 12}〜{n_days - 8}日勤務（デモ用の仮値）", strength="強く", origin=_O,
              people=PeopleSel(employment="常勤"), shifts=ShiftSel(), at_least=n_days - 12, at_most=n_days - 8),
        Count(id="r-part-days", label="パートは月14日まで（デモ用の仮値）", strength="強く", origin=_O,
              people=PeopleSel(employment="パート"), shifts=ShiftSel(), at_most=14),
        Balance(id="r-night-fair", label="夜勤回数の差は3回以内", strength="強く", origin=_O,
                people=PeopleSel(skills=["night"]), shifts=ShiftSel(ids=["夜勤"]), max_spread=3),
        Staffing(id="r-night-medical", label="夜勤に医療的ケアができる人を1人以上", strength="強く", origin=_O,
                 shifts=ShiftSel(ids=["夜勤"]), people=PeopleSel(skills=["medical"]), at_least=1),
    ]
    for sh, n in fac.need_per_shift.items():
        rules.append(Staffing(id=f"r-staff-{sh}", label=f"{sh}は毎日{n}人以上（施設の基準人数・仮）", strength="絶対", origin=_O,
                              shifts=ShiftSel(ids=[sh]), at_least=n))
    return rules


def request_rules(rows: list[dict], month: str) -> list:
    """希望休（fact_requests の行）→ Request。希望は軟制約。"""
    by: dict[str, list[int]] = {}
    for r in rows:
        if r["date"].startswith(month) and r["kind"] == "off":
            by.setdefault(r["staff_id"], []).append(int(r["date"][8:10]))
    return [Request(id=f"req-{sid}", label=f"{sid} の希望休（{len(ds)}日）", strength="強く", origin=Origin(kind="手入力"),
                    people=PeopleSel(ids=[sid]), days=DaySel(dates=sorted(ds)), shifts=ShiftSel(ids=[OFF]), want=True)
            for sid, ds in by.items()]
