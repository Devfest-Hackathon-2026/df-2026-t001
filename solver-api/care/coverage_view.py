"""日次スケジュールを人ごとの時間帯の一覧に整形する（CLI・デモ用）。"""
from __future__ import annotations

from .dsl import Facility, Month
from .solver.coverage import slot_label
from .solver.daily import DailyResult, on_duty

from .vocab import TASK_JA  # 表示名は vocab に一本化


def day_timeline(fac: Facility, mo: Month, cells, day: int, res: DailyResult, ci=None) -> str:
    items: dict[str, list[tuple[int, int, str]]] = {}
    for a in res.assignments:
        items.setdefault(a["staff_id"], []).append((a["start"], a["end"], TASK_JA.get(a["task"], a["task"])))
    for b in res.breaks:
        items.setdefault(b["staff_id"], []).append((b["start"], b["end"], "休憩"))
    lines = []
    for sd in sorted(on_duty(fac, mo, cells, day, ci), key=lambda x: (x.prev_day is False, x.shift, x.staff.staff_id)):
        sid = sd.staff.staff_id
        seq = " ".join(f"{slot_label(s)}-{slot_label(e) if e < 48 else '24:00'} {t}" for s, e, t in sorted(items.get(sid, [])))
        tag = f"{sd.shift}{'(明け)' if sd.prev_day else ''}"
        lines.append(f"  {sid} {sd.staff.name:<8} {tag:<8} {seq or '（業務なし）'}")
    return "\n".join(lines)
