"""日本の介護施設の形をまねた入力と、境界の入力を作る。数値はすべて仮（法令・施設基準そのものではない）。

* 介護施設の形 … 規模（ユニット型の小規模〜80人上限）・夜勤に入れない人・パート・主任の土日・希望休（月2〜4日）・前月末の夜勤
* 境界 … 作れないはずの入力で、作れない理由を返すか。入力の上限で弾くか
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

APP = ("早番", "日勤", "遅番", "夜勤")

THREE_SHIFT_TYPES: list[dict] = [
    {"id": "日", "name": "日勤", "short": "日", "start": "08:30", "end": "17:15", "break_min": 45, "group": "日勤系", "counts": True, "next_day": "なし"},
    {"id": "準", "name": "準夜", "short": "準", "start": "16:30", "end": "01:15", "break_min": 45, "group": "夜勤系", "counts": True, "next_day": "なし"},
    {"id": "深", "name": "深夜", "short": "深", "start": "00:30", "end": "09:15", "break_min": 45, "group": "夜勤系", "counts": True, "next_day": "なし"},
]


def three_shift_facility(
    name: str,
    n_staff: int,
    need: dict[str, int],
    *,
    seed: int,
    part_ratio: float = 0.10,
    no_night_ratio: float = 0.10,
    medical_ratio: float = 0.85,
    off_per_person: tuple[int, int] = (2, 3),
    month: str = "2026-12",
    days: int = 31,
    first_weekday: int = 2,
    carry_night: float = 0.1,
    min_interval_h: float = 11.0,
    night_max: int = 8,
    ward_night_avg_max: float | None = None,
) -> dict:
    """日本の病棟の3交代（日・準・深）をまねた入力。数値は仮。"""
    rnd = random.Random(seed)
    staff, day_off, unavailable, carry = [], {}, {}, {}
    shift_ids = [st["id"] for st in THREE_SHIFT_TYPES]
    for i in range(n_staff):
        sid = f"N{i + 1:03d}"
        if i == 0:  # 師長・主任: 日勤のみ・土日休み
            s = {"staff_id": sid, "role": "主任", "employment": "常勤", "skills": ["medical"], "shifts": ["日"], "is_leader": True}
            unavailable[sid] = [d for d in range(1, days + 1) if (first_weekday + d - 1) % 7 in (0, 6)]
        elif rnd.random() < part_ratio:
            s = {"staff_id": sid, "role": "看護師", "employment": "パート", "skills": ["medical"], "shifts": ["日"]}
            unavailable[sid] = sorted(rnd.sample(range(1, days + 1), 10))
        else:
            sh = ["日"] if rnd.random() < no_night_ratio else list(shift_ids)
            s = {"staff_id": sid, "role": "看護師", "employment": "常勤",
                 "skills": ["medical"] if rnd.random() < medical_ratio else [], "shifts": sh}
        staff.append(s)
        k = rnd.randint(*off_per_person)
        if k and i:
            day_off[sid] = sorted(rnd.sample(range(1, days + 1), k))
        if "準" in s["shifts"] and rnd.random() < carry_night:
            carry[sid] = rnd.choice(["準", "深"])
    req: dict = {
        "month": month,
        "days": days,
        "first_weekday": first_weekday,
        "shift_types": THREE_SHIFT_TYPES,
        "staff": staff,
        "need_per_shift": need,
        "day_off": day_off,
        "unavailable": unavailable,
        "carry_in": carry,
        "night_max": night_max,
        "min_interval_h": min_interval_h,
        "time_limit": 18,
    }
    if ward_night_avg_max is not None:
        req["ward_night_avg_max"] = ward_night_avg_max
    cover = [{k: need.get(k, 0) for k in shift_ids} for _ in range(days)]
    return {"name": name, "request": req, "meta": {"days": days, "staff": n_staff, "cover": cover, "dropped": [], "kind": "3交代病棟（仮）"}}


def three_shift_cases() -> list[dict]:
    return [
        three_shift_facility("S3-1-3交代25人", 25, {"日": 7, "準": 2, "深": 2}, seed=31),
        three_shift_facility("S3-2-3交代30人", 30, {"日": 8, "準": 3, "深": 3}, seed=32, part_ratio=0.05, no_night_ratio=0.05),
        three_shift_facility("S3-3-3交代40人", 40, {"日": 12, "準": 4, "深": 4}, seed=33),
    ]


def facility(name: str, n_staff: int, need: dict[str, int], *, seed: int, part_ratio: float = 0.15, no_night_ratio: float = 0.15,
             medical_ratio: float = 0.5, off_per_person: tuple[int, int] = (2, 4), month: str = "2026-12", days: int = 31,
             first_weekday: int = 2, carry_night: float = 0.1) -> dict:
    rnd = random.Random(seed)
    staff, day_off, unavailable, carry = [], {}, {}, {}
    for i in range(n_staff):
        sid = f"S{i + 1:03d}"
        if i == 0:   # 主任: 夜勤なし・土日休み
            s = {"staff_id": sid, "role": "主任", "employment": "常勤", "skills": ["medical"], "shifts": ["早番", "日勤", "遅番"],
                 "is_leader": True}
            unavailable[sid] = [d for d in range(1, days + 1) if (first_weekday + d - 1) % 7 in (0, 6)]
        elif rnd.random() < part_ratio:
            s = {"staff_id": sid, "role": "介護職員", "employment": "パート", "skills": [],
                 "shifts": rnd.choice([["早番", "日勤"], ["日勤"], ["日勤", "遅番"]])}
            unavailable[sid] = sorted(rnd.sample(range(1, days + 1), 10))  # 週に2〜3日は入れない
        else:
            sh = ["早番", "日勤", "遅番"] + ([] if rnd.random() < no_night_ratio else ["夜勤"])
            s = {"staff_id": sid, "role": rnd.choice(["介護福祉士", "介護職員"]), "employment": "常勤",
                 "skills": ["medical"] if rnd.random() < medical_ratio else [], "shifts": sh}
        staff.append(s)
        k = rnd.randint(*off_per_person)
        if k and i:
            day_off[sid] = sorted(rnd.sample(range(1, days + 1), k))
        if "夜勤" in s["shifts"] and rnd.random() < carry_night:
            carry[sid] = "夜勤"
    req = {"month": month, "days": days, "first_weekday": first_weekday, "staff": staff, "need_per_shift": need,
           "day_off": day_off, "unavailable": unavailable, "carry_in": carry, "time_limit": 18}
    cover = [{k: need.get(k, 0) for k in APP} for _ in range(days)]
    return {"name": name, "request": req, "meta": {"days": days, "staff": n_staff, "cover": cover, "dropped": [], "kind": "介護施設（仮）"}}


def edge() -> list[dict]:
    out = []
    base = facility("_", 25, {"早番": 3, "日勤": 3, "遅番": 3, "夜勤": 2}, seed=7)

    def mk(name: str, why: str, mutate, expect: str) -> None:
        inst = json.loads(json.dumps(base))
        inst["name"] = name
        mutate(inst["request"])
        n = inst["request"].get("days", 31)
        inst["meta"] = {"days": n, "staff": len(inst["request"]["staff"]), "dropped": [], "kind": "境界", "why": why, "expect": expect,
                        "cover": [{k: inst["request"]["need_per_shift"].get(k, 0) for k in APP} for _ in range(n)]}
        out.append(inst)

    mk("E01-職員1人", "1人で毎日日勤1人", lambda r: (r.update(staff=[r["staff"][1]], need_per_shift={"日勤": 1}, day_off={}, unavailable={},
                                                               carry_in={})), "作れない（理由つき）")
    mk("E02-人手ぎりぎり16人", "50床相当を16人で", lambda r: r.update(staff=r["staff"][:16]), "作れない or 不足を明示")
    mk("E03-人手不足12人", "50床相当を12人で", lambda r: r.update(staff=r["staff"][:12]), "作れない（理由つき）")

    def two_night(r):
        for s in r["staff"][3:]:
            s["shifts"] = [k for k in s["shifts"] if k != "夜勤"]
        for s in r["staff"][1:3]:
            s["shifts"] = list(APP)
        r["need_per_shift"]["夜勤"] = 1
    mk("E04-夜勤できる人2人", "夜勤1人×31日を2人で（上限8回）", two_night, "作れない（夜勤の上限）")

    def weekend(r):
        r["unavailable"] = {s["staff_id"]: [d for d in range(1, 32) if (2 + d - 1) % 7 in (0, 6)] for s in r["staff"]}
    mk("E05-全員土日不可", "全員が土日に入れない", weekend, "作れない（土日）")
    mk("E06-必要人数0", "どの勤務帯も0人", lambda r: r.update(need_per_shift={k: 0 for k in APP}), "全員休みの表 or 入力の注意")
    mk("E07-81人", "上限80人を1人超える", lambda r: r.update(staff=[dict(r["staff"][1], staff_id=f"X{i:03d}") for i in range(81)],
                                                       day_off={}, unavailable={}, carry_in={}), "入力エラー（80人まで）")

    def same_day(r):
        r["day_off"] = {s["staff_id"]: [24, 25] for s in r["staff"][1:]}
    mk("E08-希望休が同じ日に集中", "全員が24・25日に希望休", same_day, "作れる・通らない希望休を示す")

    def all_carry(r):
        r["carry_in"] = {s["staff_id"]: "夜勤" for s in r["staff"] if "夜勤" in s["shifts"]}
    mk("E09-前月末に夜勤が全員", "夜勤に入れる全員が前月末夜勤", all_carry, "作れない（1日）or 不足を明示")
    mk("E10-夜勤上限1回", "night_max=1", lambda r: r.update(night_max=1), "作れない（夜勤の上限）")

    def parts(r):
        for s in r["staff"]:
            s.update(employment="パート", is_leader=False)
    mk("E11-全員パート", "常勤0人", parts, "作れる")

    def extra(r):
        r["extra"] = {f"2026-12-{d:02d}": {"日勤": 2} for d in range(1, 32, 3)}
    mk("E12-行事で上乗せ多数", "3日おきに日勤+2", extra, "作れる・上乗せが付く")
    mk("E13-夜勤だけ", "夜勤2人だけの施設", lambda r: r.update(need_per_shift={"夜勤": 2}), "作れる")
    mk("E14-2月28日", "28日の月", lambda r: r.update(month="2027-02", days=28, first_weekday=1, unavailable={}, day_off={}), "作れる")
    mk("E15-曜日の食い違い", "days=31 だが 2027-02", lambda r: r.update(month="2027-02"), "入力エラー（日数）")
    return out


def japan() -> list[dict]:
    return [
        facility("J1-ユニット型2ユニット20床", 12, {"早番": 2, "日勤": 1, "遅番": 2, "夜勤": 1}, seed=1),
        facility("J2-従来型50床", 25, {"早番": 3, "日勤": 3, "遅番": 3, "夜勤": 2}, seed=2),
        facility("J3-従来型100床", 50, {"早番": 6, "日勤": 6, "遅番": 6, "夜勤": 4}, seed=3),
        facility("J4-大規模80人", 80, {"早番": 10, "日勤": 8, "遅番": 10, "夜勤": 6}, seed=4),
        facility("J5-夜勤できる人が少ない50床", 25, {"早番": 3, "日勤": 3, "遅番": 3, "夜勤": 2}, seed=5, no_night_ratio=0.45),
        facility("J6-パート多め50床", 28, {"早番": 3, "日勤": 3, "遅番": 3, "夜勤": 2}, seed=6, part_ratio=0.4),
        facility("J7-医療的ケアできる人が少ない", 25, {"早番": 3, "日勤": 3, "遅番": 3, "夜勤": 2}, seed=8, medical_ratio=0.12),
        facility("J8-希望休が多い（月6〜8日）", 25, {"早番": 3, "日勤": 3, "遅番": 3, "夜勤": 2}, seed=9, off_per_person=(6, 8)),
    ]


def app_fixture(path: Path) -> dict:
    """画面の架空施設（さくら苑）。画面と同じく need は各帯ユニット数（4）。"""
    staff = json.loads(path.read_text())
    need = {k: 4 for k in APP}
    return {"name": "A1-さくら苑（画面の架空データ）", "request": {"month": "2026-12", "staff": staff, "need_per_shift": need, "time_limit": 18},
            "meta": {"days": 31, "staff": len(staff), "dropped": [], "kind": "アプリの架空データ",
                     "cover": [dict(need) for _ in range(31)]}}


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "--three-shift":
        out = Path(args[1])
        out.mkdir(parents=True, exist_ok=True)
        insts = three_shift_cases()
    else:
        out = Path(args[0])
        out.mkdir(parents=True, exist_ok=True)
        insts = japan() + edge() + [app_fixture(Path(args[1]))]
    for inst in insts:
        (out / f"{inst['name']}.json").write_text(json.dumps(inst, ensure_ascii=False, indent=1))
    print(f"{len(insts)} 件 -> {out}")
