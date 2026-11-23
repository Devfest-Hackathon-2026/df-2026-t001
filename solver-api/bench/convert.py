"""ベンチマーク（schedulingbenchmarks.org の .ros / Instance*.txt）を、solve-inline のリクエストに変換する。

アプリの入力は「4つの勤務帯・勤務帯ごとに毎日同じ必要人数（日ごとの上乗せは extra）・80人まで・1か月」。
元データの条件はほとんどそのままでは入らない。入らなかったものは meta.dropped に必ず書く（捨てたことを隠さない）。

写し方:
* 勤務帯 … 開始・終了時刻で 夜勤 / 遅番 / 早番 / 日勤 に寄せる。同じ帯に寄った元の勤務は人数を足す
* 期間 … 28〜31日はそのまま。長ければ先頭の31日、短ければ繰り返して28日（2027-02）にする
* 必要人数 … 帯ごとに期間中の最小値を need、各日の差を extra（上限10）。元の人数は meta.cover に残して検証で使う
* 希望休（DayOff）… day_off（強く）。Instance*.txt の SECTION_DAYS_OFF は「必ず休み」なので unavailable
* 前期間の割り当て（FixedAssignments の期間前）… 最後の7日を history（最終日は carry_in にも残す）
* 医療的ケア … 元データに無いので全員「可」
"""
from __future__ import annotations

import calendar
import json
import math
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

APP = ("早番", "日勤", "遅番", "夜勤")
TARGET = {28: "2027-02", 29: "2028-02", 30: "2026-11", 31: "2026-12"}


def _min(t: str) -> int:
    h, m = t.split(":")[:2]
    return int(h) * 60 + int(m)


def classify(start: str, end: str) -> str:
    s, e = _min(start), _min(end)
    length = (e - s) % 1440 or 1440
    crosses = e <= s
    if s >= 20 * 60 or s < 5 * 60 or (crosses and length >= 10 * 60) or length >= 16 * 60:
        return "夜勤"
    if s >= 11 * 60 or (crosses and e <= 3 * 60) or e >= 20 * 60:
        return "遅番"
    if s < 7 * 60 + 30:
        return "早番"
    return "日勤"


def _target(n_days: int) -> tuple[str, int, str]:
    if n_days >= 31:
        return TARGET[31], 31, ("" if n_days == 31 else f"期間{n_days}日のうち先頭31日だけを使った")
    if n_days >= 28:
        return TARGET[n_days], n_days, ""
    return TARGET[28], 28, f"期間{n_days}日を繰り返して28日にした"


def _merge_limits(raw: list[dict], N: int) -> list[dict]:
    cap_max = min(N, 31)
    merged: dict[tuple[str, ...] | None, list[int | None]] = {}
    order: list[tuple[str, ...] | None] = []
    for lim in raw:
        sh = lim.get("shifts")
        key = tuple(sh) if sh is not None else None
        if key not in merged:
            merged[key] = [None, None]
            order.append(key)
        lo, hi = merged[key]
        if lim.get("at_least") is not None:
            v = max(0, min(cap_max, int(lim["at_least"])))
            lo = v if lo is None else max(lo, v)
        if lim.get("at_most") is not None:
            v = max(0, min(cap_max, int(lim["at_most"])))
            hi = v if hi is None else min(hi, v)
        merged[key] = [lo, hi]
    out: list[dict] = []
    for key in order:
        lo, hi = merged[key]
        if lo is not None and hi is not None and lo > hi:
            lo = hi
        if lo == 0 and hi is None:
            continue
        if lo is None and hi is None:
            continue
        item: dict = {"shifts": list(key) if key is not None else None}
        if lo is not None:
            item["at_least"] = lo
        if hi is not None:
            item["at_most"] = hi
        out.append(item)
    return out[:20]


def _finish(name: str, src_days: int, staff_ids: list[str], allowed: dict[str, set[str]], cover_src: list[dict[str, int]],
            day_off: dict[str, set[int]], unavailable: dict[str, set[int]], carry: dict[str, str], night_max: int | None,
            mapping: dict[str, str], dropped: list[str], limits_by_staff: dict[str, list[dict]] | None = None,
            shift_wish: dict[str, dict[int, str]] | None = None,
            shift_avoid: dict[str, dict[int, set[str]]] | None = None,
            fixed: dict[str, dict[int, str]] | None = None,
            history: dict[str, list[str]] | None = None,
            shift_types: list[dict] | None = None,
            rules: list[dict] | None = None,
            non_auto_shifts: set[str] | None = None) -> dict:
    month, N, note = _target(src_days)
    if note:
        dropped.append(note)
    work_ids = tuple(st["id"] for st in shift_types) if shift_types else APP
    non_auto = non_auto_shifts or set()
    idx = lambda d: d % src_days  # noqa: E731 元の日（0始まり）
    cover = [{k: cover_src[idx(d)].get(k, 0) for k in work_ids} for d in range(N)]
    used = [k for k in work_ids if any(c[k] for c in cover)]
    need = {k: (min(c[k] for c in cover) if k in used else 0) for k in work_ids if k not in non_auto}
    y, m = map(int, month.split("-")[:2])
    wd = [date(y, m, d + 1).isoweekday() % 7 for d in range(N)]  # 0=日..6=土
    need_by_weekday: dict[str, list[int]] = {}
    for k in used:
        if k in non_auto:
            continue
        wd_raw = [min(cover[d][k] for d in range(N) if wd[d] == w) for w in range(7)]
        wd_cap = [min(20, x) for x in wd_raw]
        if len(set(wd_cap)) > 1:
            need_by_weekday[k] = wd_cap
            if any(x > 20 for x in wd_raw):
                dropped.append(f"{k}の曜日別必要人数（最大{max(wd_raw)}）は上限20を超え、20にした")
        elif need[k] > 20:
            dropped.append(f"{k}の必要人数{need[k]}は上限20を超え、20にした")
        need[k] = min(20, need[k])
    extra: dict[str, dict[str, int]] = {}
    for d in range(N):
        row: dict[str, int] = {}
        over10 = False
        for k in used:
            if k in non_auto:
                continue
            base = need_by_weekday[k][wd[d]] if k in need_by_weekday else need[k]
            diff = cover[d][k] - base
            if diff > 0:
                row[k] = min(10, diff)
            if diff > 10:
                over10 = True
        if over10:
            dropped.append(f"{d + 1}日の上乗せが10人を超え、10人で切った")
        if row:
            extra[f"{month}-{d + 1:02d}"] = row

    def days_of(src: dict[str, set[int]]) -> dict[str, list[int]]:
        out: dict[str, list[int]] = {}
        for sid, ds in src.items():
            hit = sorted({d + 1 for d in range(N) if idx(d) in ds})
            if hit:
                out[sid] = hit
        return out

    if len(staff_ids) > 80:
        dropped.append(f"職員{len(staff_ids)}人のうち先頭80人だけを使った（上限80）")
        staff_ids = staff_ids[:80]
    known_staff = set(staff_ids)

    def _map_day_values(src: dict[str, dict[int, str]] | None) -> dict[str, dict[int, str]]:
        out: dict[str, dict[int, str]] = {}
        for sid, dm in (src or {}).items():
            if sid not in known_staff:
                continue
            row = {d + 1: dm[idx(d)] for d in range(N) if idx(d) in dm}
            if row:
                out[sid] = row
        return out

    def _map_day_sets(src: dict[str, dict[int, set[str]]] | None) -> dict[str, dict[int, list[str]]]:
        out: dict[str, dict[int, list[str]]] = {}
        for sid, dm in (src or {}).items():
            if sid not in known_staff:
                continue
            row = {d + 1: sorted(dm[idx(d)]) for d in range(N) if idx(d) in dm and dm[idx(d)]}
            if row:
                out[sid] = row
        return out

    wish_out = _map_day_values(shift_wish)
    avoid_out = _map_day_sets(shift_avoid)
    fixed_out = _map_day_values(fixed)

    limits_map = limits_by_staff or {}
    staff = []
    for sid in staff_ids:
        fixed_for_sid = fixed_out.get(sid, {})
        fixed_non_auto: dict[str, int] = defaultdict(int)
        for v in fixed_for_sid.values():
            if v in non_auto:
                fixed_non_auto[v] += 1
        base_allowed = allowed.get(sid, set(used))
        sh_list = [k for k in work_ids if (k in base_allowed and k in used) or k in fixed_non_auto]
        entry: dict = {"staff_id": sid, "role": "介護職員", "employment": "常勤", "skills": ["medical"], "shifts": sh_list}
        raw_lims = list(limits_map.get(sid, []))
        for k, cnt in fixed_non_auto.items():
            raw_lims.append({"shifts": [k], "at_most": cnt})
        lims = _merge_limits(raw_lims, N)
        if lims:
            entry["limits"] = lims
        staff.append(entry)
    req: dict = {"month": month, "staff": staff, "need_per_shift": need, "day_off": days_of(day_off),
                 "unavailable": days_of(unavailable), "carry_in": {k: v for k, v in carry.items() if k in staff_ids},
                 "extra": extra, "time_limit": 18}
    if shift_types:
        req["shift_types"] = shift_types
    if need_by_weekday:
        req["need_by_weekday"] = need_by_weekday
    if night_max:
        req["night_max"] = max(1, min(15, night_max))
    if wish_out:
        req["shift_wish"] = wish_out
    if avoid_out:
        req["shift_avoid"] = avoid_out
    if fixed_out:
        req["fixed"] = fixed_out
    hist_out = {sid: seq for sid, seq in (history or {}).items() if sid in known_staff and seq}
    if hist_out:
        req["history"] = hist_out
    if rules:
        req["rules"] = rules
    return {"name": name, "request": req,
            "meta": {"src_days": src_days, "days": N, "staff": len(staff_ids), "shift_map": mapping, "cover": cover,
                     "dropped": sorted(set(dropped))}}


def from_txt(path: Path) -> dict:
    sec, rows = None, defaultdict(list)
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("SECTION_"):
            sec = line
            continue
        rows[sec].append(line.split(","))
    H = int(rows["SECTION_HORIZON"][0][0])
    length = {r[0]: int(r[1]) for r in rows["SECTION_SHIFTS"]}
    # 開始時刻が無い形式。長さとIDの慣例（E/D/L/N）で寄せる
    guess = {"E": "早番", "D": "日勤", "L": "遅番", "N": "夜勤"}
    mapping = {s: guess.get(s[0], "日勤") for s in length}
    _, N, _ = _target(H)
    dropped = ["勤務帯の時刻が無いのでID（E/D/L/N）で寄せた",
               "個人ごとの時間（Min/MaxTotalMinutes）・連勤・週末の上下限は使っていない（アプリは全員共通の固定ルール）",
               "続けてはいけない勤務の組（SECTION_SHIFTS）は使っていない"]
    staff_ids, allowed, nm, limits_by_staff = [], {}, [], {}
    for r in rows["SECTION_STAFF"]:
        sid = r[0]
        staff_ids.append(sid)
        caps_raw = dict(x.split("=") for x in r[1].split("|"))
        allowed[sid] = {mapping[s] for s, n in caps_raw.items() if int(n) > 0}
        nm += [int(n) for s, n in caps_raw.items() if mapping[s] == "夜勤"]
        by_app: dict[str, int] = defaultdict(int)
        for s, n in caps_raw.items():
            by_app[mapping[s]] += int(n)
        lims = []
        for k in APP:
            if k in allowed[sid]:
                cap_k = by_app[k]
                scaled = math.ceil(cap_k * N / H) if N > H else cap_k
                if 0 < scaled < N and scaled <= 31:
                    lims.append({"shifts": [k], "at_most": scaled})
        if lims:
            limits_by_staff[sid] = lims
    unavailable: dict[str, set[int]] = defaultdict(set)
    for r in rows["SECTION_DAYS_OFF"]:
        unavailable[r[0]] |= {int(x) for x in r[1:]}
    shift_wish: dict[str, dict[int, str]] = defaultdict(dict)
    wish_w: dict[tuple[str, int], float] = {}
    for r in rows["SECTION_SHIFT_ON_REQUESTS"]:
        sid, d, sh = r[0], int(r[1]), r[2]
        w = float(r[3]) if len(r) > 3 else 1.0
        if 0 <= d < H and sh in mapping and w >= wish_w.get((sid, d), -1.0):
            shift_wish[sid][d] = mapping[sh]
            wish_w[(sid, d)] = w
    shift_avoid: dict[str, dict[int, set[str]]] = defaultdict(lambda: defaultdict(set))
    for r in rows["SECTION_SHIFT_OFF_REQUESTS"]:
        sid, d, sh = r[0], int(r[1]), r[2]
        if 0 <= d < H and sh in mapping:
            shift_avoid[sid][d].add(mapping[sh])
    cover = [defaultdict(int) for _ in range(H)]
    for r in rows["SECTION_COVER"]:
        cover[int(r[0])][mapping[r[1]]] += int(r[2])
    if len(set(mapping.values())) < len(mapping):
        dropped.append("複数の勤務が同じ帯に寄ったので人数を足した")
    return _finish(path.stem, H, staff_ids, allowed, cover, {}, unavailable, {}, max(nm) if nm else None, mapping, dropped,
                   limits_by_staff, shift_wish=shift_wish, shift_avoid=shift_avoid)


def _extract_ros_contract_limits(
    contract_node: ET.Element,
    mapping: dict[str, str],
    rev: dict[str, set[str]],
    sg: dict[str, set[str]],
    offset: int,
    H: int,
    N: int,
) -> list[dict]:
    all_work = set(mapping)
    lims: list[dict] = []
    multi_mx: dict[str, int] = {}

    def _scale_max(mx: int) -> int:
        return min(N, math.ceil(mx * N / H) if N > H else mx)

    def _scale_min(mn: int) -> int:
        return min(N, round(mn * N / H) if N != H else mn)

    for m in contract_node.findall("Patterns/Match"):
        pats = m.findall("Pattern")
        if len(pats) != 1:
            continue
        ch = list(pats[0])
        if len(ch) != 1 or ch[0].tag not in ("Shift", "ShiftGroup"):
            continue
        rs_t, re_t = m.findtext("RegionStart"), m.findtext("RegionEnd")
        rs = int(rs_t) if rs_t is not None else offset
        re_ = int(re_t) if re_t is not None else offset + H - 1
        if rs > offset or re_ < offset + H - 1:
            continue
        mn_t, mx_t = m.findtext("Min/Count"), m.findtext("Max/Count")
        mn = int(mn_t) if mn_t is not None else None
        mx = int(mx_t) if mx_t is not None else None
        if mn is None and mx is None:
            continue

        tag, val = ch[0].tag, ch[0].text or ""
        if tag == "Shift":
            if val == "$":
                item: dict = {"shifts": None}
                if mn is not None:
                    item["at_least"] = _scale_min(mn)
                if mx is not None:
                    item["at_most"] = _scale_max(mx)
                lims.append(item)
            elif val == "-":
                if N >= H:
                    item = {"shifts": None}
                    if mx is not None:
                        item["at_least"] = max(0, N - (math.ceil(mx * N / H) if N > H else mx))
                    if mn is not None:
                        item["at_most"] = max(0, N - (math.floor(mn * N / H) if N > H else mn))
                    lims.append(item)
            elif val in mapping:
                app = mapping[val]
                if len(rev[app]) == 1:
                    item = {"shifts": [app]}
                    if mn is not None:
                        item["at_least"] = _scale_min(mn)
                    if mx is not None:
                        item["at_most"] = _scale_max(mx)
                    lims.append(item)
                elif mx is not None:
                    multi_mx[val] = mx if val not in multi_mx else min(multi_mx[val], mx)
        else:
            srcs = sg.get(val, set()) - {"-", "O"}
            if not srcs:
                continue
            if all_work and srcs >= all_work:
                item = {"shifts": None}
                if mn is not None:
                    item["at_least"] = _scale_min(mn)
                if mx is not None:
                    item["at_most"] = _scale_max(mx)
                lims.append(item)
            else:
                matched = sorted(app for app, ss in rev.items() if ss and ss <= srcs)
                if matched and set().union(*(rev[a] for a in matched)) == srcs:
                    item = {"shifts": matched}
                    if mn is not None:
                        item["at_least"] = _scale_min(mn)
                    if mx is not None:
                        item["at_most"] = _scale_max(mx)
                    lims.append(item)

    for app, ss in rev.items():
        if len(ss) > 1 and ss <= set(multi_mx):
            total_mx = sum(multi_mx[s_id] for s_id in ss)
            lims.append({"shifts": [app], "at_most": _scale_max(total_mx)})
    return lims


def _extract_ros_max_run(root: ET.Element, sg: dict[str, set[str]], mapping: dict[str, str]) -> int | None:
    """全契約が共通で持つ『連続勤務の上限（Max N consecutive working days）』を取り出す。"""
    all_work = set(mapping)
    if not all_work:
        return None
    caps: list[int] = []
    for c in root.findall("Contracts/Contract"):
        best: int | None = None
        for m in c.findall("Patterns/Match"):
            if m.findtext("Max/Count") != "0":
                continue
            pats = m.findall("Pattern")
            if len(pats) != 1:
                continue
            elems = list(pats[0])
            if len(elems) < 2:
                continue
            ok = True
            for el in elems:
                if el.tag == "Shift" and el.text == "$":
                    continue
                if el.tag == "ShiftGroup" and (sg.get(el.text or "", set()) - {"-", "O"}) >= all_work:
                    continue
                ok = False
                break
            if ok:
                cap = len(elems) - 1
                best = cap if best is None else min(best, cap)
        if best is None:
            return None
        caps.append(best)
    if caps and len(set(caps)) == 1 and 1 <= caps[0] <= 10:
        return caps[0]
    return None


def _extract_ros_forbidden_patterns(root: ET.Element, valid_shifts: set[str]) -> list[tuple[str, ...]]:
    """全契約が共通して禁止（Max/Count=0）している Shift の並び（長さ2〜5）を取り出す。"""
    per_contract: list[set[tuple[str, ...]]] = []
    for c in root.findall("Contracts/Contract"):
        pats_c: set[tuple[str, ...]] = set()
        for m in c.findall("Patterns/Match"):
            if m.findtext("Max/Count") != "0":
                continue
            for pat in m.findall("Pattern"):
                elems = list(pat)
                if not (2 <= len(elems) <= 5):
                    continue
                if any(el.tag != "Shift" for el in elems):
                    continue
                seq = tuple("休" if el.text == "-" else (el.text or "") for el in elems)
                if all(s == "休" or s in valid_shifts for s in seq):
                    pats_c.add(seq)
        per_contract.append(pats_c)
    if not per_contract:
        return []
    common = set.intersection(*per_contract)
    return sorted(common, key=lambda x: (len(x), x))


def _extract_ros_shift_types(root: ET.Element, common_forbid: list[tuple[str, ...]]) -> tuple[list[dict], set[str]]:
    """ShiftTypes をそのまま shift_types 定義に変換する。AutoAllocate=false や ID=O は counts=False。"""
    forbid2 = {p for p in common_forbid if len(p) == 2}
    out: list[dict] = []
    non_auto: set[str] = set()
    for s in root.findall("ShiftTypes/Shift"):
        sid = s.get("ID")
        st, en = s.findtext("StartTime"), s.findtext("EndTime")
        if not sid or sid == "-" or not st or not en:
            continue
        start_hm, end_hm = st[:5], en[:5]
        auto_alloc = (s.findtext("AutoAllocate") or "true").strip().lower() != "false"
        counts = auto_alloc and sid != "O"
        if not counts:
            non_auto.add(sid)
            group = "その他"
        else:
            cls = classify(start_hm, end_hm)
            group = "夜勤系" if cls == "夜勤" else ("その他" if cls == "遅番" else "日勤系")
        # 同じ勤務の2連が禁止されていない（3交代や連夜勤あり）なら翌日は明けにしない
        next_day = "なし" if (sid, sid) not in forbid2 else None
        item: dict = {
            "id": sid[:8],
            "name": (s.findtext("Name") or sid)[:20],
            "short": (s.findtext("Label") or sid)[:4],
            "start": start_hm,
            "end": end_hm,
            "group": group,
            "counts": counts,
        }
        if next_day is not None:
            item["next_day"] = next_day
        out.append(item)
    return out, non_auto


def _fallback_ikegami_3shift(base_path: Path = Path("/tmp/bench-req/Ikegami-3Shift-DATA1.json")) -> dict:
    """サンドボックスで .ros を直接読めない場合に /tmp/bench-req/Ikegami-3Shift-DATA1.json から 3Shift 区分版を再構成する。"""
    src = json.loads(base_path.read_text())
    req0 = src["request"]
    app_to_orig = {"早番": "D", "遅番": "E", "夜勤": "N"}
    shift_types = [
        {"id": "N", "name": "Night", "short": "N", "start": "18:00", "end": "06:00", "group": "夜勤系", "counts": True, "next_day": "なし"},
        {"id": "E", "name": "Evening", "short": "E", "start": "12:00", "end": "20:00", "group": "その他", "counts": True, "next_day": "なし"},
        {"id": "D", "name": "Day", "short": "D", "start": "06:00", "end": "16:00", "group": "日勤系", "counts": True, "next_day": "なし"},
        {"id": "O", "name": "Other work", "short": "O", "start": "06:00", "end": "18:00", "group": "その他", "counts": False, "next_day": "なし"},
    ]
    o_fixed: dict[str, list[int]] = {
        "A02": [13], "A04": [20], "A08": [10], "A10": [1, 16], "A11": [16], "A12": [16], "A13": [7],
        "B14": [10], "B16": [13, 21], "B17": [13], "B18": [20], "B19": [7, 16], "B20": [30], "B21": [30], "B22": [1, 30], "B23": [30],
    }
    staff = []
    for s in req0["staff"]:
        sid = s["staff_id"]
        sh = ["N", "E", "D"] + (["O"] if sid in o_fixed else [])
        lims = []
        for lim in s.get("limits", []):
            lsh = lim.get("shifts")
            nl = dict(lim)
            if lsh is not None:
                nl["shifts"] = [app_to_orig[k] for k in lsh if k in app_to_orig]
                if not nl["shifts"]:
                    continue
            lims.append(nl)
        if sid in o_fixed:
            lims.append({"shifts": ["O"], "at_most": len(o_fixed[sid])})
        entry = {**s, "shifts": sh}
        if lims:
            entry["limits"] = _merge_limits(lims, 30)
        staff.append(entry)
    fixed: dict[str, dict[int, str]] = {}
    for sid, days in o_fixed.items():
        fixed[sid] = {d: "O" for d in days}
    history: dict[str, list[str]] = {}
    for sid, seq in (req0.get("history") or {}).items():
        history[sid] = [app_to_orig.get(k, "") for k in seq]
    if "A03" in history and len(history["A03"]) >= 6:
        history["A03"][5] = "O"
    if "A04" in history and len(history["A04"]) >= 1:
        history["A04"][0] = "O"
    if "B15" in history and len(history["B15"]) >= 6:
        history["B15"][5] = "O"
    if "B21" in history and len(history["B21"]) >= 1:
        history["B21"][0] = "O"
    carry_in = {sid: app_to_orig[k] for sid, k in (req0.get("carry_in") or {}).items() if k in app_to_orig}
    carry_in["A03"] = "O"
    carry_in["B15"] = "O"
    shift_wish = {
        sid: {int(d): app_to_orig.get(v, v) for d, v in dm.items()}
        for sid, dm in (req0.get("shift_wish") or {}).items()
    }
    extra = {
        ds: {app_to_orig[k]: n for k, n in row.items() if k in app_to_orig}
        for ds, row in (req0.get("extra") or {}).items()
    }
    patterns = [("N", "D"), ("N", "O"), ("N", "E"), ("E", "D"), ("E", "O"), ("N", "N", "N"), ("E", "E", "E", "E"), ("D", "D", "D", "D", "D")]
    rules = [
        {"type": "succession", "id": f"r-pat-{i + 1}", "label": f"禁止の並び {'→'.join(p)}", "strength": "強く",
         "pattern": [{"ids": [k]} for k in p], "forbid": True}
        for i, p in enumerate(patterns)
    ]
    req = {
        "month": req0["month"],
        "shift_types": shift_types,
        "staff": staff,
        "need_per_shift": {"D": 7, "E": 4, "N": 3},
        "need_by_weekday": {"D": [8, 7, 7, 7, 7, 7, 8]},
        "need_mode": "min",
        "need_max_by_weekday": {"D": [13, 11, 11, 11, 11, 11, 11], "E": [4] * 7, "N": [3] * 7},
        "day_off": req0.get("day_off", {}),
        "unavailable": req0.get("unavailable", {}),
        "carry_in": carry_in,
        "history": history,
        "shift_wish": shift_wish,
        "fixed": fixed,
        "extra": extra,
        "max_run": 6,
        "rules": rules,
        "time_limit": 18,
    }
    cover = [{app_to_orig[k]: v for k, v in row.items() if k in app_to_orig} | {"O": 0} for row in src["meta"]["cover"]]
    return {
        "name": "Ikegami-3Shift-DATA1",
        "request": req,
        "meta": {
            "src_days": src["meta"]["src_days"],
            "days": src["meta"]["days"],
            "staff": len(staff),
            "shift_map": {k: k for k in ("N", "E", "D", "O")},
            "cover": cover,
            "dropped": ["スキル別の必要人数は使っていない（勤務帯ごとの合計だけ）", "医療的ケアの可否は元データに無いので全員「可」にした"],
        },
    }


def from_ros(path: Path, *, extended: bool = False, keep_shift_types: bool = False) -> dict:
    try:
        r = ET.parse(path).getroot()
    except PermissionError:
        if keep_shift_types and path.stem == "Ikegami-3Shift-DATA1" and Path("/tmp/bench-req/Ikegami-3Shift-DATA1.json").exists():
            return _fallback_ikegami_3shift()
        raise
    start0 = date.fromisoformat(r.findtext("StartDate"))
    start = start0
    end = date.fromisoformat(r.findtext("EndDate"))
    H = (end - start).days + 1
    dropped = ["スキル別の必要人数は使っていない（勤務帯ごとの合計だけ）", "医療的ケアの可否は元データに無いので全員「可」にした"]
    if not keep_shift_types:
        dropped.insert(0, "連勤・週末・勤務パターンのルールは使っていない（アプリは全員共通の固定ルール）")
    if r.find("Contracts/Contract/Workload") is not None:
        dropped.append("個人ごとの時間単位の契約（Workload）は使っていない")

    shift_types_out: list[dict] | None = None
    non_auto_shifts: set[str] = set()
    rules_out: list[dict] = []
    mapping: dict[str, str] = {}
    if keep_shift_types:
        raw_ids = {s.get("ID") for s in r.findall("ShiftTypes/Shift") if s.get("ID") and s.get("ID") != "-"}
        common_forbid = _extract_ros_forbidden_patterns(r, raw_ids)
        shift_types_out, non_auto_shifts = _extract_ros_shift_types(r, common_forbid)
        mapping = {st["id"]: st["id"] for st in shift_types_out}
        # 禁止の並び（長さ2〜5の Shift 並び）を rules として写す（休を含む3日並び等も含む）
        for i, pat in enumerate(common_forbid[:20]):
            rules_out.append({
                "type": "succession",
                "id": f"r-pat-{i + 1}",
                "label": f"禁止の並び {'→'.join(pat)}",
                "strength": "強く",
                "pattern": [{"ids": [k]} for k in pat],
                "forbid": True,
            })
    else:
        for s in r.findall("ShiftTypes/Shift"):
            st, en = s.findtext("StartTime"), s.findtext("EndTime")
            if s.get("ID") in ("O", "-") or not st or not en:
                continue
            mapping[s.get("ID")] = classify(st, en)
    staff_ids = [e.get("ID") for e in r.findall("Employees/Employee")]
    cov_root = r.find("CoverRequirements")
    used_src: set[str] = set()
    skill_only: list[int] = []
    dow: dict[int, dict[str, int]] = {}
    names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    def total(node, *, use_max: bool = False) -> dict[str, int]:
        out: dict[str, int] = defaultdict(int)
        plain = [c for c in node.findall("Cover") if c.find("Skill") is None and c.find("SkillGroup") is None]
        if not plain:   # スキル別しか無い日は、スキル別を足して合計とみなす
            plain = node.findall("Cover")
            skill_only.append(1)
        for c in plain:
            sh = c.findtext("Shift")
            if sh not in mapping:
                continue
            if use_max:
                v = c.findtext("Max") or c.findtext("Preferred") or c.findtext("Min") or "0"
            else:
                v = c.findtext("Min") or c.findtext("Preferred") or c.findtext("Max") or "0"
            out[mapping[sh]] += int(v)
            used_src.add(sh)
        return out

    use_ext = extended or keep_shift_types
    for n in cov_root.findall("DayOfWeekCover"):
        dow[names.index(n.findtext("Day"))] = total(n)
    spec = {date.fromisoformat(n.findtext("Date")): total(n) for n in cov_root.findall("DateSpecificCover")}
    dow_max = {names.index(n.findtext("Day")): total(n, use_max=True) for n in cov_root.findall("DayOfWeekCover")} if use_ext else {}
    spec_max = {date.fromisoformat(n.findtext("Date")): total(n, use_max=True) for n in cov_root.findall("DateSpecificCover")} if use_ext else {}
    # 時間帯（TimePeriod）で指定する系統（Montreal）は勤務帯に写せない
    if skill_only:
        dropped.append("勤務帯ごとの合計が無く、スキル別の人数を足して合計にした")
    if spec and not dow:   # 日付指定だけの系統（池上）は、指定のある最初の日から始める。前の日は前月扱い
        start = min(spec)
        H = (end - start).days + 1
    if any(c.find("TimePeriod") is not None for c in cov_root.iter("Cover")):
        dropped.append("時間帯（TimePeriod）単位の必要人数は勤務帯に写せず、使っていない")
    cover = []
    for i in range(H):
        d = start + timedelta(days=i)
        cover.append(spec.get(d) or dow.get(d.weekday(), {}))
    if not any(any(c.values()) for c in cover):
        dropped.append("勤務帯ごとの必要人数が1つも取れなかった")
    if len({mapping[s] for s in used_src}) < len(used_src):
        dropped.append("複数の勤務が同じ帯に寄ったので人数を足した")
    day_off: dict[str, set[int]] = defaultdict(set)
    for n in r.findall("DayOffRequests/DayOff"):
        d = date.fromisoformat(n.findtext("Date"))
        if start <= d <= end:
            day_off[n.findtext("EmployeeID")].add((d - start).days)
    shift_wish: dict[str, dict[int, str]] = defaultdict(dict)
    wish_w: dict[tuple[str, int], float] = {}
    for n in r.findall("ShiftOnRequests/ShiftOn"):
        d = date.fromisoformat(n.findtext("Date"))
        if not (start <= d <= end):
            continue
        sid = n.findtext("EmployeeID")
        sh = n.findtext("ShiftTypeID")
        day_idx = (d - start).days
        if sh == "-" or (sh == "O" and sh not in mapping):
            day_off[sid].add(day_idx)
        elif sh in mapping:
            w = float(n.get("weight") or 1.0)
            if w >= wish_w.get((sid, day_idx), -1.0):
                shift_wish[sid][day_idx] = mapping[sh]
                wish_w[(sid, day_idx)] = w
    for n in r.findall("DayOnRequests/DayOn"):
        d = date.fromisoformat(n.findtext("Date"))
        if start <= d <= end:
            sid = n.findtext("EmployeeID")
            shift_wish[sid].setdefault((d - start).days, "勤務")
    shift_avoid: dict[str, dict[int, set[str]]] = defaultdict(lambda: defaultdict(set))
    for n in r.findall("ShiftOffRequests/ShiftOff"):
        d = date.fromisoformat(n.findtext("Date"))
        if not (start <= d <= end):
            continue
        sid = n.findtext("EmployeeID")
        sh = n.findtext("ShiftTypeID")
        day_idx = (d - start).days
        if sh == "-" or (sh == "O" and sh not in mapping):
            shift_wish[sid].setdefault(day_idx, "勤務")
        elif sh in mapping:
            shift_avoid[sid][day_idx].add(mapping[sh])
    carry: dict[str, str] = {}
    history_map: dict[str, list[str]] = {}
    fixed_in_map: dict[str, dict[int, str]] = defaultdict(dict)
    min_hist_date = start - timedelta(days=7)
    for e in r.findall("FixedAssignments/Employee"):
        sid = e.findtext("EmployeeID")
        last = None
        pre_days: dict[date, str] = {}
        for a in e.findall("Assign"):
            d = date.fromisoformat(a.findtext("Date"))
            sh = a.findtext("Shift")
            if d < start:
                if last is None or d > last[0]:
                    last = (d, sh)
                if d >= min_hist_date:
                    pre_days[d] = mapping[sh] if sh in mapping else ""
            elif start <= d <= end:
                day_idx = (d - start).days
                if sh in mapping:
                    fixed_in_map[sid][day_idx] = mapping[sh]
                elif sh in ("-", "O"):
                    fixed_in_map[sid][day_idx] = "休"
        if last and last[0] == start - timedelta(days=1) and last[1] in mapping:
            carry[sid] = mapping[last[1]]
        if pre_days and sid:
            first_d = min(pre_days)
            n_hist = (start - first_d).days
            history_map[sid] = [pre_days.get(first_d + timedelta(days=i), "") for i in range(n_hist)]
    _, N, _ = _target(H)
    offset = (start - start0).days
    rev: dict[str, set[str]] = defaultdict(set)
    for src_id, app in mapping.items():
        rev[app].add(src_id)
    sg = {g.get("ID"): {s.text for s in g.findall("Shift") if s.text} for g in r.findall("ShiftGroups/ShiftGroup")}
    by_cid = {c.get("ID"): c for c in r.findall("Contracts/Contract")}
    limits_by_staff: dict[str, list[dict]] = {}
    for e in r.findall("Employees/Employee"):
        sid = e.get("ID")
        c = by_cid.get(e.findtext("ContractID"))
        if sid and c is not None:
            lims = _extract_ros_contract_limits(c, mapping, rev, sg, offset, H, N)
            if lims:
                limits_by_staff[sid] = lims
    res = _finish(path.stem, H, staff_ids, {}, cover, day_off, {}, carry, None, mapping, dropped,
                  limits_by_staff, shift_wish=shift_wish, shift_avoid=shift_avoid, fixed=fixed_in_map,
                  history=history_map, shift_types=shift_types_out, rules=rules_out or None,
                  non_auto_shifts=non_auto_shifts or None)
    if use_ext:
        req = res["request"]
        mr = _extract_ros_max_run(r, sg, mapping)
        if mr is not None:
            req["max_run"] = mr
        max_cover_src = [spec_max.get(start + timedelta(days=i)) or dow_max.get((start + timedelta(days=i)).weekday(), {}) for i in range(H)]
        N_res = res["meta"]["days"]
        y, m = map(int, req["month"].split("-")[:2])
        wd = [date(y, m, d + 1).isoweekday() % 7 for d in range(N_res)]
        need_max_wd: dict[str, list[int]] = {}
        has_width = False
        iter_keys = tuple(st["id"] for st in shift_types_out) if shift_types_out else APP
        for k in iter_keys:
            if k in non_auto_shifts:
                continue
            if not req["need_per_shift"].get(k) and k not in req.get("need_by_weekday", {}):
                continue
            base_wd = req.get("need_by_weekday", {}).get(k) or [req["need_per_shift"][k]] * 7
            mx_wd = [
                min(20, max(base_wd[w], max((max_cover_src[d % H].get(k, 0) for d in range(N_res) if wd[d] == w), default=0)))
                for w in range(7)
            ]
            if any(mx_wd[w] > base_wd[w] for w in range(7)):
                has_width = True
            need_max_wd[k] = mx_wd
        if has_width:
            req["need_mode"] = "min"
            req["need_max_by_weekday"] = need_max_wd
    return res


def convert(path: Path, *, keep_shift_types: bool = False) -> dict:
    return from_txt(path) if path.suffix == ".txt" else from_ros(path, keep_shift_types=keep_shift_types)


if __name__ == "__main__":
    args = sys.argv[1:]
    keep_st = False
    if "--keep-shift-types" in args:
        keep_st = True
        args = [a for a in args if a != "--keep-shift-types"]
    if len(args) < 2:
        sys.exit("usage: python -m bench.convert [--keep-shift-types] <out_dir> <files...> | <files...> <out_dir>")
    # 末尾が .ros / .txt でなければ出力先ディレクトリとみなす（ワークフロー記載の <file> <out_dir> 形式も許可）
    if Path(args[-1]).suffix not in (".ros", ".txt") and Path(args[0]).suffix in (".ros", ".txt"):
        out = Path(args[-1])
        files = [Path(a) for a in args[:-1]]
    else:
        out = Path(args[0])
        files = [Path(a) for a in args[1:]]
    out.mkdir(parents=True, exist_ok=True)
    for p in files:
        try:
            inst = convert(p, keep_shift_types=keep_st)
        except Exception as e:  # noqa: BLE001
            print(f"NG {p.name}: {type(e).__name__}: {e}")
            continue
        (out / f"{inst['name']}.json").write_text(json.dumps(inst, ensure_ascii=False, indent=1))
        rq = inst["request"]
        print(f"OK {inst['name']:24s} 人={len(rq['staff']):3d} 日={inst['meta']['days']} need={rq['need_per_shift']} 捨={len(inst['meta']['dropped'])}")
