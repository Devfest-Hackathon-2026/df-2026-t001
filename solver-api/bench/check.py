"""solve-inline の結果を、ソルバーのコード（care.*）を一切使わずに確かめる。

見るもの:
* 必ず守るはずのもの（画面で「必ず守る」と書いているもの）— 破れが1件でもあれば NG
  人数（ちょうど need。上乗せの日は need〜need+extra）／入れない勤務帯／夜勤の翌日は休み／遅番の翌日に早番なし／
  連続勤務5日まで／夜勤の上限／入れない日
* 画面の労務チェック（夜勤明けも連勤に数える・常勤の公休8日以上）— app_labor_rules が true なら守られているはず
* 元データの必要人数に対する不足・過剰（変換で丸めた分も含む「元の要求に対してどれだけ足りたか」）
* 希望休がどれだけ通ったか、夜勤・勤務日数の偏り
"""
from __future__ import annotations

from datetime import date

APP = ("早番", "日勤", "遅番", "夜勤")
WORK_H = {"早番": 8, "日勤": 8, "遅番": 8, "夜勤": 13}
MAX_RUN = 5
MIN_OFF = 8
DEFAULT_NIGHT_MAX = 8
DEFAULT_SHIFT_TYPES = (
    {"id": "早番", "name": "早番", "start": "07:00", "end": "16:00", "break_min": 60, "group": "日勤系", "counts": True, "next_day": "なし"},
    {"id": "日勤", "name": "日勤", "start": "09:00", "end": "18:00", "break_min": 60, "group": "日勤系", "counts": True, "next_day": "なし"},
    {"id": "遅番", "name": "遅番", "start": "12:00", "end": "21:00", "break_min": 60, "group": "日勤系", "counts": True, "next_day": "なし"},
    {"id": "夜勤", "name": "夜勤", "start": "16:30", "end": "09:30", "break_min": 240, "group": "夜勤系", "counts": True, "next_day": "明け"},
)
DEFAULT_SHIFT_TIMES = {st["id"]: {"start": st["start"], "end": st["end"]} for st in DEFAULT_SHIFT_TYPES}


def _hhmm(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _norm_shift_types(req: dict) -> list[dict]:
    raw = req.get("shift_types")
    if not raw:
        return [dict(st) for st in DEFAULT_SHIFT_TYPES]
    out = []
    for st in raw:
        start = st.get("start", "09:00")
        end = st.get("end", "18:00")
        s_m, e_m = _hhmm(start), _hhmm(end)
        nd = st.get("next_day")
        if nd is None:
            nd = "明け" if (e_m <= s_m and end != "24:00" and e_m > 300) else "なし"
        span = (e_m - s_m) if e_m > s_m else (1440 - s_m + e_m)
        bm = st.get("break_min")
        if bm is None:
            bm = 240 if span >= 960 else (60 if span > 480 else 0)
        out.append({
            "id": st["id"],
            "name": st.get("name") or st["id"],
            "start": start,
            "end": end,
            "break_min": bm,
            "span_min": span,
            "work_min": max(0, span - bm),
            "group": st.get("group", "日勤系"),
            "counts": bool(st.get("counts", True)),
            "next_day": nd,
        })
    return out


def _night_overlap_min(st: dict, win_start: str = "16:00", win_hours: int = 16) -> int:
    s0 = _hhmm(st["start"])
    e0 = s0 + st.get("span_min", ((_hhmm(st["end"]) - s0) if _hhmm(st["end"]) > s0 else (1440 - s0 + _hhmm(st["end"]))))
    w0 = _hhmm(win_start)
    w1 = w0 + win_hours * 60
    return sum(max(0, min(e0, w1 + k) - max(s0, w0 + k)) for k in (-1440, 0, 1440))


def _interval_forbids(req: dict, sts: list[dict], ake_ids: set[str]) -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    has_custom_st = bool(req.get("shift_types"))
    if not has_custom_st and req.get("shift_times") is None and req.get("min_interval_h") is None:
        return {("遅番", "早番")}, set()
    base_times = {st["id"]: {"start": st["start"], "end": st["end"]} for st in sts}
    times = {**base_times, **(req.get("shift_times") or {})}
    min_iv = 11.0 if req.get("min_interval_h") is None else float(req["min_interval_h"])
    spans = {}
    for k, tm in times.items():
        s, e = _hhmm(tm["start"]), _hhmm(tm["end"])
        spans[k] = (s, e + 1440 if e <= s else e)
    thresh = min_iv * 60.0
    two_day: set[tuple[str, str]] = set()
    three_day: set[tuple[str, str]] = set()
    for a, (_sa, ea) in spans.items():
        for b, (sb, _eb) in spans.items():
            if a in ake_ids:
                if 2880 + sb - ea < thresh - 1e-9:
                    three_day.add((a, b))
            else:
                if 1440 + sb - ea < thresh - 1e-9:
                    two_day.add((a, b))
    return two_day, three_day


def _rule_active_days(r: dict, y: int, m: int, N: int) -> list[int]:
    lc = r.get("lifecycle") or {}
    if lc.get("stopped"):
        return []
    exp = lc.get("expires_on")
    if not exp:
        return list(range(1, N + 1))
    try:
        exp_d = date.fromisoformat(exp) if isinstance(exp, str) else exp
        return [d for d in range(1, N + 1) if date(y, m, d) <= exp_d]
    except ValueError:
        return list(range(1, N + 1))


def _match_people(sel: dict | None, staff_list: list[dict]) -> list[dict]:
    if not sel:
        return list(staff_list)
    ids = sel.get("ids")
    roles = sel.get("roles")
    skills = sel.get("skills")
    emp = sel.get("employment")
    id_set = set(ids) if ids is not None else None
    role_set = set(roles) if roles is not None else None
    skill_set = set(skills) if skills is not None else None
    out = []
    for s in staff_list:
        if id_set is not None and s["staff_id"] not in id_set:
            continue
        if role_set is not None and s.get("role", "介護職員") not in role_set:
            continue
        if skill_set is not None and not (skill_set & set(s.get("skills") or [])):
            continue
        if emp is not None and s.get("employment", "常勤") != emp:
            continue
        out.append(s)
    return out


def _match_days(sel: dict | None, act: list[int], first_wd: int) -> list[int]:
    if not sel:
        return list(act)
    wds = set(sel["weekdays"]) if sel.get("weekdays") is not None else None
    dates = set(sel["dates"]) if sel.get("dates") is not None else None
    named = sel.get("named")
    out = []
    for d in act:
        wd = (first_wd + d - 1) % 7
        if wds is not None and wd not in wds:
            continue
        if dates is not None and d not in dates:
            continue
        if named == "平日" and wd in (0, 6):
            continue
        if named == "休日" and wd not in (0, 6):
            continue
        out.append(d)
    return out


def _sel_kinds(sel: dict | None, work_ids: tuple[str, ...]) -> list[str]:
    if not sel or sel.get("ids") is None:
        return list(work_ids)
    allowed = set(work_ids) | {"休", "公休"}
    return [k for k in sel["ids"] if k in allowed]


def _eval_custom_rules(
    raw_rules: list[dict],
    *,
    req: dict,
    cells: dict[str, list[str]],
    N: int,
    y: int,
    m: int,
    first_wd: int,
    work_ids: tuple[str, ...],
    ake_ids: set[str],
    work_min: dict[str, int],
    carry: dict[str, str],
    history_map: dict[str, list[str]],
    hard: dict[str, int],
) -> list[dict]:
    """口から来た追加ルール（5型）をソルバー非依存で判定する。"""
    at = lambda sid, d: (cells[sid][d - 1] or "") if 1 <= d <= N else ""  # noqa: E731
    bump = lambda mp, k, n=1: mp.__setitem__(k, mp.get(k, 0) + n)  # noqa: E731
    staff_list = req["staff"]
    last_prev_of = {
        s["staff_id"]: ((history_map.get(s["staff_id"]) or [])[-1] if history_map.get(s["staff_id"]) else carry.get(s["staff_id"], ""))
        for s in staff_list
    }
    all_work = set(work_ids)

    def match_cell(sid: str, d: int, kinds: list[str]) -> bool:
        k = at(sid, d) or "休"
        if k != "休":
            return k in kinds
        if "休" in kinds:
            return True
        if "公休" in kinds:
            prev = last_prev_of[sid] if d == 1 else at(sid, d - 1)
            return prev not in ake_ids
        return False

    hard_labels = {
        "staffing": "追加ルール（人数）",
        "request": "追加ルール（希望・回避）",
        "succession": "追加ルール（並び・連勤）",
        "count": "追加ルール（回数・時間）",
        "balance": "追加ルール（偏り）",
        "occurrence": "追加ルール（並びの回数）",
    }
    results: list[dict] = []
    for idx, r in enumerate(raw_rules):
        rtype = r.get("type")
        strength = r.get("strength") or "強く"
        act = _rule_active_days(r, y, m, N)
        act_set = set(act)
        people = _match_people(r.get("people"), staff_list)
        days = _match_days(r.get("days"), act, first_wd) if act else []
        broken = 0
        max_dev = 0

        if act:
            if rtype == "staffing":
                kinds = _sel_kinds(r.get("shifts"), work_ids)
                lo, hi = r.get("at_least"), r.get("at_most")
                for d in days:
                    tot = sum(1 for p in people if match_cell(p["staff_id"], d, kinds))
                    if lo is not None and tot < lo:
                        broken += 1
                    if hi is not None and tot > hi:
                        broken += 1

            elif rtype == "request":
                kinds = _sel_kinds(r.get("shifts"), work_ids)
                want = bool(r.get("want", True))
                for p in people:
                    sid = p["staff_id"]
                    for d in days:
                        if match_cell(sid, d, kinds) != want:
                            broken += 1

            elif rtype == "succession":
                if r.get("max_run") is not None:
                    n = int(r["max_run"])
                    for p in people:
                        sid = p["staff_id"]
                        h = history_map.get(sid) or []
                        if h and 1 in act_set:
                            s0 = max(1 - n, 1 - len(h))
                            for s in range(s0, min(1, N - n + 1)):
                                pre_sum = sum(1 for d0 in range(s, 1) if (h[len(h) + d0 - 1] or "休") in all_work)
                                if pre_sum <= -s:
                                    continue
                                tot = pre_sum + sum(1 for d1 in range(1, s + n + 1) if at(sid, d1) in all_work)
                                if tot > n:
                                    broken += 1
                        for s in range(1, N - n + 1):
                            if s not in act_set:
                                continue
                            if sum(1 for i in range(n + 1) if at(sid, s + i) in all_work) > n:
                                broken += 1
                else:
                    pats = [set(_sel_kinds(sel, work_ids)) for sel in (r.get("pattern") or [])]
                    L = len(pats)
                    forbid = bool(r.get("forbid", True))
                    if L >= 2:
                        for p in people:
                            sid = p["staff_id"]
                            h = list(history_map.get(sid) or [])
                            if not h and L == 2 and carry.get(sid):
                                h = [carry[sid]]
                            if h and 1 in act_set:
                                s0 = max(2 - L, 1 - len(h))
                                for s in range(s0, min(1, N - L + 2)):
                                    pre_ok = all(
                                        0 <= (len(h) + s + i - 1) < len(h)
                                        and (h[len(h) + s + i - 1] or "休") in ks
                                        for i, ks in enumerate(pats)
                                        if s + i <= 0
                                    )
                                    if not pre_ok:
                                        continue
                                    full_match = all(
                                        (at(sid, s + i) or "休") in ks
                                        for i, ks in enumerate(pats)
                                        if s + i >= 1
                                    )
                                    if (full_match if forbid else not full_match):
                                        broken += 1
                            for s in range(1, N - L + 2):
                                if s not in act_set:
                                    continue
                                match = all((at(sid, s + i) or "休") in ks for i, ks in enumerate(pats))
                                if (match if forbid else not match):
                                    broken += 1

            elif rtype == "count":
                kinds = _sel_kinds(r.get("shifts"), work_ids)
                unit = r.get("unit", "回")
                scale = 60 if unit == "時間" else 1
                lo = int(round(r["at_least"] * scale)) if r.get("at_least") is not None else None
                hi = int(round(r["at_most"] * scale)) if r.get("at_most") is not None else None
                tg = int(round(r["target"] * scale)) if r.get("target") is not None else None
                for p in people:
                    sid = p["staff_id"]
                    if unit == "回":
                        tot = sum(1 for d in days if match_cell(sid, d, kinds))
                    else:
                        tot = sum(work_min.get(at(sid, d), 0) for d in days if at(sid, d) in kinds)
                    if lo is not None and tot < lo:
                        broken += 1
                    if hi is not None and tot > hi:
                        broken += 1
                    if tg is not None:
                        raw_dev = abs(tot - tg)
                        if raw_dev > 0:
                            broken += 1
                            dev = (raw_dev + 59) // 60 if unit == "時間" else raw_dev
                            max_dev = max(max_dev, dev)

            elif rtype == "balance":
                if len(people) >= 2 and days:
                    kinds = _sel_kinds(r.get("shifts"), work_ids)
                    cnts = [sum(1 for d in days if match_cell(p["staff_id"], d, kinds)) for p in people]
                    if max(cnts) - min(cnts) > r["max_spread"]:
                        broken += 1

            elif rtype == "occurrence":
                pats = [_sel_kinds(sel, work_ids) for sel in (r.get("pattern") or [])]
                L = len(pats)
                if L >= 2:
                    start_days = [d for d in _match_days(r.get("starts"), act, first_wd) if d + L - 1 <= N]
                    lo, hi = r.get("at_least"), r.get("at_most")
                    for p in people:
                        sid = p["staff_id"]
                        cnt = sum(
                            1
                            for d in start_days
                            if all(match_cell(sid, d + i, ks) for i, ks in enumerate(pats))
                        )
                        if lo is not None and cnt < lo:
                            broken += 1
                        if hi is not None and cnt > hi:
                            broken += 1

        entry: dict = {
            "index": idx,
            "rule_id": f"r-ui-{idx}",
            "type": rtype,
            "strength": strength,
            "broken": broken,
        }
        if rtype == "count" and r.get("target") is not None:
            entry["max_dev"] = max_dev
        results.append(entry)

        if strength == "絶対" and broken > 0:
            if rtype == "succession" and r.get("pattern") and r.get("forbid", True):
                bump(hard, "禁止の並び", broken)
            else:
                bump(hard, hard_labels.get(rtype or "", "追加ルール"), broken)

    return results


def check(req: dict, res: dict, meta: dict | None = None) -> dict:
    N = res.get("days") or len(next(iter(res.get("cells", {}).values()), []))
    cells: dict[str, list[str]] = res.get("cells") or {}
    out: dict = {"status": res.get("status"), "wall_ms": res.get("wall_ms"), "strict": res.get("app_labor_rules")}
    if not cells:
        out["made"] = False
        out["relaxation"] = [f"{x['label']}×{x['count']}" for x in res.get("relaxation", [])]
        return out
    out["made"] = True
    month = req["month"]
    y, m = map(int, month.split("-")[:2])
    first_wd = date(y, m, 1).isoweekday() % 7
    staff = {s["staff_id"]: s for s in req["staff"]}
    sts = _norm_shift_types(req)
    work_ids = tuple(st["id"] for st in sts)
    st_map = {st["id"]: st for st in sts}
    ake_ids = {st["id"] for st in sts if st["next_day"] == "明け"}
    night_ids = {st["id"] for st in sts if st["group"] == "夜勤系"}
    work_min = {
        st["id"]: st.get("work_min", WORK_H.get(st["id"], 8) * 60)
        for st in sts
    }
    need_raw = req.get("need_per_shift") or {}
    need = {k: need_raw.get(k, 0) for k in work_ids}
    need_by_wd = req.get("need_by_weekday") or {}
    need_by_group = req.get("need_by_group") or {}
    need_max = req.get("need_max") or {}
    need_max_by_wd = req.get("need_max_by_weekday") or {}
    need_mode = req.get("need_mode", "exact")
    holidays = set(req.get("holidays") or [])
    extra = {int(d[8:10]): row for d, row in req.get("extra", {}).items() if d.startswith(month)}
    carry = req.get("carry_in", {})
    history_map = req.get("history") or {}
    cap = req.get("night_max") or DEFAULT_NIGHT_MAX
    max_run = req.get("max_run") or MAX_RUN
    forbid_2, forbid_3 = _interval_forbids(req, sts, ake_ids)
    raw_rules = req.get("rules") or []
    hard: dict[str, int] = {}
    labor: dict[str, int] = {}
    bump = lambda m, k, n=1: m.__setitem__(k, m.get(k, 0) + n)  # noqa: E731
    at = lambda sid, d: (cells[sid][d - 1] or "") if 1 <= d <= N else ""  # noqa: E731

    def day_need(d: int, k: str) -> int:
        if k in need_by_wd:
            w = 0 if d in holidays else (first_wd + d - 1) % 7
            return need_by_wd[k][w]
        return need.get(k, 0)

    def day_max(d: int, k: str) -> int | None:
        if k in need_max_by_wd:
            w = 0 if d in holidays else (first_wd + d - 1) % 7
            return need_max_by_wd[k][w]
        if k in need_max:
            return need_max[k]
        return None

    def day_group_need(d: int, grp: str) -> int:
        spec = need_by_group.get(grp)
        if spec is None:
            return 0
        if isinstance(spec, list):
            w = 0 if d in holidays else (first_wd + d - 1) % 7
            return spec[w]
        return int(spec)

    if set(cells) != set(staff):
        bump(hard, "職員の過不足")
    for sid, row in cells.items():
        if len(row) != N:
            bump(hard, "日数が合わない")
    need_max_over = 0
    has_need_max = bool(need_max or need_max_by_wd)
    group_covered = {st["id"] for st in sts if st["counts"] and st["group"] in need_by_group}
    for d in range(1, N + 1):
        for k in work_ids:
            st = st_map[k]
            n = sum(1 for sid in cells if at(sid, d) == k)
            base = day_need(d, k)
            ex_k = extra.get(d, {}).get(k, 0)
            lo, hi = base, base + ex_k
            has_explicit_need = (k in need_raw) or (k in need_by_wd) or (ex_k > 0)
            has_exp_max = k in need_max or k in need_max_by_wd
            if not st["counts"] and not has_explicit_need and not has_exp_max:
                continue
            if k in group_covered and not has_explicit_need and not has_exp_max:
                continue
            if n < lo:
                bump(hard, "人数不足（必要人数の下限）")
            is_night = k in night_ids
            if k in group_covered:
                # 群の合計で数える区分は、個別指定（D+など）を下限として扱う
                pass
            elif need_mode == "exact" or is_night:
                if n > hi:
                    bump(hard, "人数過剰（必要人数の上限）")
            elif base == 0 and ex_k == 0 and not has_exp_max:
                if n > 0:
                    bump(hard, "人数過剰（必要人数の上限）")
            if has_exp_max:
                mx = day_max(d, k)
                if mx is not None and n > max(mx, hi):
                    need_max_over += 1
        for grp in need_by_group:
            g_need = day_group_need(d, grp)
            if g_need > 0:
                g_ids = {st["id"] for st in sts if st["group"] == grp and st["counts"]}
                gn = sum(1 for sid in cells if at(sid, d) in g_ids)
                if gn < g_need:
                    bump(hard, f"群の人数不足（{grp}）")
    if has_need_max:
        out["need_max_over"] = need_max_over
    any_limits = any(s.get("limits") for s in staff.values())
    limit_max_checked = limit_min_total = limit_min_unmet = 0
    for sid, s in staff.items():
        row = [at(sid, d) for d in range(1, N + 1)]
        lims = s.get("limits") or []
        has_night_cap = any(
            lim.get("unit", "回") == "回" and lim.get("at_most") is not None
            and lim.get("shifts") is not None and set(lim["shifts"]) == night_ids and bool(night_ids)
            for lim in lims
        )
        has_days_cap = any(
            lim.get("unit", "回") == "回" and lim.get("at_most") is not None and lim.get("shifts") is None
            for lim in lims
        )
        h = history_map.get(sid) or []
        last_prev = h[-1] if h else carry.get(sid, "")
        for d, k in enumerate(row, 1):
            if k and k not in s["shifts"]:
                bump(hard, "入れない勤務帯に入れた")
            prev = last_prev if d == 1 else row[d - 2]
            if prev in ake_ids and k:
                bump(hard, "夜勤の翌日に勤務")
            if (prev, k) in forbid_2:
                bump(hard, "遅番の翌日に早番" if (prev, k) == ("遅番", "早番") else "勤務間の間隔が不足")
            if forbid_3:
                prev2 = (h[-2] if len(h) >= 2 else "") if d == 1 else (last_prev if d == 2 else row[d - 3])
                if not prev and (prev2, k) in forbid_3:
                    bump(hard, "勤務間の間隔が不足")
        for d in req.get("unavailable", {}).get(sid, []):
            if 1 <= d <= N and row[d - 1]:
                bump(hard, "入れない日に勤務")
        if night_ids and not has_night_cap and sum(k in night_ids for k in row) > cap:
            bump(hard, f"夜勤が上限{cap}回を超えた")
        for lim in lims:
            target_shifts = set(lim["shifts"]) if lim.get("shifts") is not None else set(work_ids)
            if lim.get("unit", "回") == "時間":
                val_min = sum(work_min.get(k, 0) for k in row if k in target_shifts)
                if lim.get("at_most") is not None:
                    limit_max_checked += 1
                    if val_min > int(round(lim["at_most"] * 60)):
                        bump(hard, "個人の上限を超えた")
                if lim.get("at_least") is not None:
                    limit_min_total += 1
                    if val_min < int(round(lim["at_least"] * 60)):
                        limit_min_unmet += 1
            else:
                val = sum(1 for k in row if k in target_shifts)
                if lim.get("at_most") is not None:
                    limit_max_checked += 1
                    if val > lim["at_most"]:
                        bump(hard, "個人の上限を超えた")
                if lim.get("at_least") is not None:
                    limit_min_total += 1
                    if val < lim["at_least"]:
                        limit_min_unmet += 1
        run = 0
        if h:
            for k in reversed(h):
                if k:
                    run += 1
                else:
                    break
        for k in row:
            run = run + 1 if k else 0
            if run > max_run:
                bump(hard, f"連続勤務が{max_run}日を超えた")
        # 画面の数え方: 明け対象勤務の翌日も勤務日として数える
        cov = [1 if (row[i] or (row[i - 1] if i else last_prev) in ake_ids) else 0 for i in range(N)]
        if h:
            pre_cov = [1 if (h[j] or (j > 0 and h[j - 1] in ake_ids)) else 0 for j in range(len(h))]
            full_cov = pre_cov + cov
            start_i = max(0, len(pre_cov) - max_run)
            for i in range(start_i, len(full_cov) - max_run):
                if sum(full_cov[i:i + max_run + 1]) > max_run:
                    bump(labor, f"明けを含めた連勤が{max_run}日を超えた")
        else:
            for i in range(N - max_run):
                if sum(cov[i:i + max_run + 1]) > max_run:
                    bump(labor, f"明けを含めた連勤が{max_run}日を超えた")
        if not has_days_cap and s.get("employment", "常勤") == "常勤" and not s.get("is_leader") and s["shifts"] and N - sum(cov) < MIN_OFF:
            bump(labor, "常勤の公休が8日未満")
    out["hard"] = hard
    out["labor"] = labor
    if any_limits:
        out["limit_max_checked"] = limit_max_checked
        out["limit_min_unmet"] = [limit_min_unmet, limit_min_total]

    fixed_checked = 0
    for sid, dm in (req.get("fixed") or {}).items():
        if sid not in cells:
            continue
        for raw_d, want in dm.items():
            d = int(raw_d)
            if 1 <= d <= N:
                fixed_checked += 1
                if (at(sid, d) or "休") != want:
                    bump(hard, "固定の割り当てを守れていない")
    if fixed_checked:
        out["fixed_checked"] = fixed_checked

    w_asked = w_got = 0
    for sid, dm in (req.get("shift_wish") or {}).items():
        if sid not in cells:
            continue
        for raw_d, want in dm.items():
            d = int(raw_d)
            if 1 <= d <= N:
                w_asked += 1
                got = at(sid, d)
                w_got += bool(got) if want == "勤務" else (got == want)
    if w_asked:
        out["shift_wish"] = [w_got, w_asked]

    a_asked = a_got = 0
    for sid, dm in (req.get("shift_avoid") or {}).items():
        if sid not in cells:
            continue
        for raw_d, ks in dm.items():
            d = int(raw_d)
            if 1 <= d <= N and ks:
                a_asked += 1
                if at(sid, d) not in ks:
                    a_got += 1
    if a_asked:
        out["shift_avoid"] = [a_got, a_asked]

    # 元データの必要人数（変換で丸める前）に対して
    if meta and meta.get("cover"):
        short = over = slots = 0
        cover_keys = list(work_ids)
        for d in range(1, N + 1):
            for k in cover_keys:
                want = meta["cover"][d - 1].get(k, 0)
                n = sum(1 for sid in cells if at(sid, d) == k)
                short += max(0, want - n)
                over += max(0, n - want)
                slots += want
        out["orig_need"] = slots
        out["orig_short"] = short
        out["orig_over"] = over

    asked = got = 0
    for sid, ds in req.get("day_off", {}).items():
        for d in ds:
            if 1 <= d <= N and sid in cells:
                asked += 1
                got += not at(sid, d)
    out["day_off"] = [got, asked]
    nights = [
        sum(at(sid, d) in night_ids for d in range(1, N + 1))
        for sid, s in staff.items()
        if any(k in night_ids for k in s["shifts"])
    ]
    works = [sum(bool(at(sid, d)) for d in range(1, N + 1)) for sid, s in staff.items() if s["shifts"] and not s.get("is_leader")]
    full_offs = []
    for sid, s in staff.items():
        if s.get("employment", "常勤") != "常勤" or s.get("is_leader") or not s.get("shifts"):
            continue
        h = history_map.get(sid) or []
        last_prev = h[-1] if h else carry.get(sid, "")
        off_cnt = 0
        for d in range(1, N + 1):
            prev = last_prev if d == 1 else at(sid, d - 1)
            if not at(sid, d) and prev not in ake_ids:
                off_cnt += 1
        full_offs.append(off_cnt)
    out["full_off_stats"] = (
        {"min": min(full_offs), "max": max(full_offs), "avg": round(sum(full_offs) / len(full_offs), 1)}
        if full_offs else None
    )
    daily_counts: dict[str, dict[str, int]] = {}
    for k in work_ids:
        day_vals = [sum(1 for sid in cells if at(sid, d) == k) for d in range(1, N + 1)]
        needs_k = [day_need(d, k) for d in range(1, N + 1)]
        if max(day_vals, default=0) > 0 or max(needs_k, default=0) > 0:
            daily_counts[k] = {
                "min": min(day_vals),
                "max": max(day_vals),
                "over_total": sum(max(0, v - nd) for v, nd in zip(day_vals, needs_k)),
            }
    out["daily_counts"] = daily_counts
    # 72時間ルールの独立計算（ward_night_avg_max があるとき、または夜勤系があるとき集計可能）
    if req.get("ward_night_avg_max") is not None:
        win = req.get("night_window") or {}
        w_start = win.get("start", "16:00")
        w_hours = int(win.get("hours", 16))
        if win.get("end"):
            s_w, e_w = _hhmm(w_start), _hhmm(win["end"])
            sp = (e_w - s_w) if e_w > s_w else (1440 - s_w + e_w)
            if sp % 60 == 0 and 60 <= sp <= 1440:
                w_hours = sp // 60
        thresh_min = max(1, int(req.get("night_worker_min_h", 16)) * 60)
        ov_min = {
            st["id"]: _night_overlap_min(st, w_start, w_hours)
            for st in sts
            if st["group"] == "夜勤系" and st["counts"]
        }
        worker_hs: list[float] = []
        for sid in staff:
            m_tot = sum(ov_min.get(at(sid, d), 0) for d in range(1, N + 1))
            if m_tot >= thresh_min:
                worker_hs.append(m_tot / 60.0)
        cap_h = float(req["ward_night_avg_max"])
        total_h = sum(worker_hs)
        avg_h = (total_h / len(worker_hs)) if worker_hs else 0.0
        out["night_avg_stats"] = {
            "workers": len(worker_hs),
            "total_h": round(total_h, 2),
            "avg_h": round(avg_h, 2),
            "min_h": round(min(worker_hs), 2) if worker_hs else 0.0,
            "max_h": round(max(worker_hs), 2) if worker_hs else 0.0,
            "excess_h": round(max(0.0, avg_h - cap_h), 2),
        }
    out["night_range"] = [min(nights), max(nights)] if nights else None
    out["night_spread"] = (max(nights) - min(nights)) if nights else None
    out["work_range"] = [min(works), max(works)] if works else None
    out["soft_broken"] = [f"{x['label']}×{x['count']}" for x in res.get("soft_broken", [])]
    if raw_rules:
        rules_check = _eval_custom_rules(
            raw_rules,
            req=req,
            cells=cells,
            N=N,
            y=y,
            m=m,
            first_wd=first_wd,
            work_ids=work_ids,
            ake_ids=ake_ids,
            work_min=work_min,
            carry=carry,
            history_map=history_map,
            hard=hard,
        )
        out["rules_check"] = rules_check
        out["rules_hard_broken"] = sum(x["broken"] for x in rules_check if x["strength"] == "絶対")
        out["rules_soft_broken"] = sum(x["broken"] for x in rules_check if x["strength"] != "絶対")
    return out
