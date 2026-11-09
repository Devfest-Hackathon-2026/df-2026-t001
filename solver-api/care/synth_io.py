"""ローカルの合成データ（scripts/synth/out）から施設・提案勤務表・希望休を読む。テストとデモ用。

本番では Firestore（施設・従業員・テンプレート・勤務表・ルール）と BigQuery（履歴）から読む。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .dsl import Facility, Month, StaffMember, TaskTemplate

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "scripts" / "synth" / "out"
NEED = {"fac-sakura": {"早番": 4, "日勤": 6, "遅番": 4, "夜勤": 4}, "fac-midori": {"早番": 3, "日勤": 4, "遅番": 3, "夜勤": 2},
        "fac-hidamari": {"早番": 2, "日勤": 2, "遅番": 2, "夜勤": 2}}


def load(fid: str, month: str = "2026-11", out: str | os.PathLike | None = None):
    out = Path(out or DEFAULT_OUT)
    seed = json.load(open(out / "seed.json", encoding="utf-8"))
    f = next(x for x in seed["facilities"] if x["facility"]["id"] == fid)
    fac = Facility(
        facility_id=fid, name=f["facility"]["name"], need_per_shift=NEED[fid],
        staff=[StaffMember(**{k: v for k, v in s.items() if k in StaffMember.model_fields}) for s in f["staff"]],
        templates=[TaskTemplate(**{k: v for k, v in t.items() if k in TaskTemplate.model_fields}) for t in f["templates"]])
    m = f["rosters"][month]
    mo = Month(month=month, days=m["days"], first_weekday=m["firstWeekday"], proposal=m["proposal"], current=m["current"])
    reqs = [json.loads(l) for l in open(out / "fact_requests.ndjson", encoding="utf-8")]
    return fac, mo, [r for r in reqs if r["facility_id"] == fid]


def carry_in(fid: str, month: str = "2026-11", out: str | os.PathLike | None = None) -> dict[str, str]:
    """前月末日の勤務（夜勤明け・遅番→早番の判定に使う）。欠勤した人は除く。"""
    import datetime as dt
    out = Path(out or DEFAULT_OUT)
    y, m = map(int, month.split("-"))
    last = (dt.date(y, m, 1) - dt.timedelta(days=1)).isoformat()
    res = {}
    for line in open(out / "fact_assignments.ndjson", encoding="utf-8"):
        a = json.loads(line)
        if a["facility_id"] == fid and a["date"] == last and a["status"] != "absent":
            res[a["staff_id"]] = a["shift"]
    return res
