"""台湾87人病棟（large-ward-with-87-people-2025-11.yaml）から、80人以下の部分（Day + Evening 60人）を切り出して
11区分そのままの solve-inline リクエストに変換する。

使い方:
  .venv/bin/python -m bench.convert_taiwan [yaml_path] [out_dir]
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import yaml

DEFAULT_YAML = Path("/Users/beni/df-hack26/ref/nurse-scheduling/web-frontend/public/examples/large-ward-with-87-people-2025-11.yaml")

TAIWAN_SHIFT_TYPES: list[dict] = [
    {"id": "D", "name": "日勤", "short": "D", "start": "08:00", "end": "16:00", "break_min": 0, "group": "日勤系", "counts": True, "next_day": "なし"},
    {"id": "D+", "name": "日勤リーダー", "short": "D+", "start": "08:00", "end": "16:00", "break_min": 0, "group": "日勤系", "counts": True, "next_day": "なし"},
    {"id": "E", "name": "準夜", "short": "E", "start": "16:00", "end": "24:00", "break_min": 0, "group": "その他", "counts": True, "next_day": "なし"},
    {"id": "E+", "name": "準夜リーダー", "short": "E+", "start": "16:00", "end": "24:00", "break_min": 0, "group": "その他", "counts": True, "next_day": "なし"},
    {"id": "N", "name": "深夜", "short": "N", "start": "00:00", "end": "08:00", "break_min": 0, "group": "夜勤系", "counts": True, "next_day": "なし"},
    {"id": "N+", "name": "深夜リーダー", "short": "N+", "start": "00:00", "end": "08:00", "break_min": 0, "group": "夜勤系", "counts": True, "next_day": "なし"},
    {"id": "A", "name": "管理勤務", "short": "A", "start": "08:00", "end": "16:00", "break_min": 0, "group": "その他", "counts": False, "next_day": "なし"},
    {"id": "D~", "name": "日勤新人", "short": "D~", "start": "08:00", "end": "16:00", "break_min": 0, "group": "日勤系", "counts": False, "next_day": "なし"},
    {"id": "E~", "name": "準夜新人", "short": "E~", "start": "16:00", "end": "24:00", "break_min": 0, "group": "その他", "counts": False, "next_day": "なし"},
    {"id": "N~", "name": "深夜新人", "short": "N~", "start": "00:00", "end": "08:00", "break_min": 0, "group": "夜勤系", "counts": False, "next_day": "なし"},
    {"id": "K", "name": "研修", "short": "K", "start": "08:00", "end": "16:00", "break_min": 0, "group": "日勤系", "counts": False, "next_day": "なし"},
]


def _norm_shift(v) -> str:
    if v is False or v is None or v == "OFF":
        return ""
    return str(v)


def convert_taiwan(yaml_path: Path = DEFAULT_YAML) -> dict:
    raw = yaml.safe_load(yaml_path.read_text())
    start_d = date.fromisoformat(raw["dates"]["range"]["startDate"])
    end_d = date.fromisoformat(raw["dates"]["range"]["endDate"])
    month = start_d.strftime("%Y-%m")
    days = (end_d - start_d).days + 1
    first_wd = start_d.isoweekday() % 7  # 0=日..6=土

    dgroups = {g["id"]: [int(x) for x in g["members"]] for g in raw["dates"].get("groups", [])}
    workdays = sorted(dgroups.get("WORKDAY", []))
    freedays = sorted(dgroups.get("FREEDAY", []))

    pgroups = {g["id"]: set(g["members"]) for g in raw["people"].get("groups", [])}
    day_people = pgroups["Day People"]
    eve_people = pgroups["Evening People"]
    senior_set = pgroups["Senior Nurses"]
    admin_set = pgroups["Admin People"]
    student_set = pgroups["Students"]
    slice_set = day_people | eve_people

    people_order = [p["id"] for p in raw["people"]["items"] if p["id"] in slice_set]
    hist_by_person = {p["id"]: p.get("history") or [] for p in raw["people"]["items"] if p["id"] in slice_set}

    # 個別リクエストを収集（weight が大きい OFF -> day_off、個別シフト指定 -> shift_wish）
    day_off: dict[str, set[int]] = defaultdict(set)
    shift_wish: dict[str, dict[int, str]] = defaultdict(dict)
    shift_avoid: dict[str, dict[int, set[str]]] = defaultdict(lambda: defaultdict(set))
    k_days: dict[str, set[int]] = defaultdict(set)
    extra_allowed: dict[str, set[str]] = defaultdict(set)
    forbid_all: dict[str, set[str]] = defaultdict(set)

    def _expand_dates(ds: list) -> list[int]:
        out: list[int] = []
        for x in ds:
            if x == "ALL":
                return list(range(1, days + 1))
            if x in dgroups:
                out.extend(dgroups[x])
            else:
                out.append(int(x))
        return sorted(set(out))

    for pref in raw.get("preferences", []):
        if pref.get("type") != "shift request":
            continue
        persons = pref.get("person") or []
        if not all(p in slice_set for p in persons):
            continue
        w = float(pref.get("weight", 0))
        sts = [_norm_shift(s) for s in (pref.get("shiftType") or [])]
        ds = _expand_dates(pref.get("date") or [])
        is_all_days = pref.get("date") == ["ALL"]
        for pid in persons:
            for st in sts:
                if st == "":
                    if not is_all_days and w >= 1e6:
                        day_off[pid].update(ds)
                elif w == float("-inf") and is_all_days:
                    forbid_all[pid].add(st)
                elif not is_all_days and w >= 1e9:
                    shift_wish[pid].update({d: st for d in ds})
                    extra_allowed[pid].add(st)
                    if st == "K":
                        k_days[pid].update(ds)
                elif not is_all_days and w < 0:
                    for d in ds:
                        shift_avoid[pid][d].add(st)

    # 学生（不算人力）の平日出勤・休日休み希望
    for pid in people_order:
        if pid in student_set:
            stu_shift = "D~" if pid in day_people else "E~"
            for d in workdays:
                shift_wish[pid].setdefault(d, stu_shift)
            for d in freedays:
                day_off[pid].add(d)

    # 職員一覧を構築（帯の完全分割を shifts で表現）
    staff: list[dict] = []
    history_out: dict[str, list[str]] = {}
    carry_in: dict[str, str] = {}
    for pid in people_order:
        if pid in student_set:
            sh = ["D~"] if pid in day_people else ["E~"]
        elif pid in day_people:
            sh = ["D"]
            if pid in senior_set:
                sh.append("D+")
            if pid in admin_set:
                sh.append("A")
        else:
            sh = ["E"]
            if pid in senior_set:
                sh.append("E+")
        sh = [k for k in sh if k not in forbid_all[pid]]
        for k in sorted(extra_allowed[pid]):
            if k not in sh:
                sh.append(k)

        limits: list[dict] = []
        if pid in k_days:
            limits.append({"shifts": ["K"], "at_most": len(k_days[pid])})
        if "N" in extra_allowed[pid]:
            n_wished = sum(1 for v in shift_wish[pid].values() if v == "N")
            limits.append({"shifts": ["N"], "at_most": max(1, n_wished)})
        if pid in student_set:
            limits.append({"shifts": None, "at_most": len(workdays)})

        entry: dict = {
            "staff_id": pid,
            "role": "主任" if pid in admin_set else ("看護師（学生）" if pid in student_set else "看護師"),
            "employment": "常勤",
            "skills": ["medical"],
            "shifts": sh,
            "is_leader": pid in admin_set,
        }
        if limits:
            entry["limits"] = limits
        staff.append(entry)

        seq = [_norm_shift(x) for x in hist_by_person.get(pid, [])][-7:]
        if any(seq):
            history_out[pid] = seq
            if seq[-1]:
                carry_in[pid] = seq[-1]

    # Day = 平日16（D13+D+3）/ 休日15（D12+D+3）、Evening = 毎日15（E12+E+3）
    need_by_group = {
        "日勤系": [15, 16, 16, 16, 16, 16, 15],
        "その他": 15,
    }
    need_per_shift = {"D+": 3, "E+": 3}

    req: dict = {
        "month": month,
        "days": days,
        "first_weekday": first_wd,
        "shift_types": TAIWAN_SHIFT_TYPES,
        "staff": staff,
        "need_per_shift": need_per_shift,
        "need_by_group": need_by_group,
        "need_mode": "min",
        "day_off": {pid: sorted(ds) for pid, ds in day_off.items() if ds},
        "shift_wish": {pid: dm for pid, dm in shift_wish.items() if dm},
        "carry_in": carry_in,
        "history": history_out,
        "max_run": 5,
        "min_interval_h": 11.0,
        "time_limit": 18,
    }
    if shift_avoid:
        req["shift_avoid"] = {pid: {d: sorted(s) for d, s in dm.items()} for pid, dm in shift_avoid.items() if dm}

    cover = []
    for d in range(1, days + 1):
        wd = (first_wd + d - 1) % 7
        cover.append({"D+": 3, "E+": 3, "_group_日勤系": need_by_group["日勤系"][wd], "_group_その他": 15})

    dropped = [
        "87人のうち Night People（P61〜P87・27人）を除外し、Day + Evening の60人だけを切り出した（上限80）",
        "休日均等化（|x-T|^2）と連続勤務の軟制約（連5回避・飛び石回避）は簡略化した",
    ]
    return {
        "name": "Taiwan-60-DayEvening",
        "request": req,
        "meta": {
            "src_days": days,
            "days": days,
            "staff": len(staff),
            "shift_map": {st["id"]: st["id"] for st in TAIWAN_SHIFT_TYPES},
            "cover": cover,
            "dropped": dropped,
            "kind": "台湾87人病棟（60人切り出し・11区分）",
        },
    }


if __name__ == "__main__":
    args = sys.argv[1:]
    yaml_path = Path(args[0]) if len(args) >= 1 else DEFAULT_YAML
    out_dir = Path(args[1]) if len(args) >= 2 else Path("/tmp/bench-taiwan")
    out_dir.mkdir(parents=True, exist_ok=True)
    inst = convert_taiwan(yaml_path)
    out_file = out_dir / f"{inst['name']}.json"
    out_file.write_text(json.dumps(inst, ensure_ascii=False, indent=1))
    rq = inst["request"]
    print(f"OK {inst['name']} 人={len(rq['staff'])} 区分={len(rq['shift_types'])} 日={rq['days']} -> {out_file}")
