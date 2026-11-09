#!/usr/bin/env python3
"""合成データ生成（すべて架空。実在の人物・施設・個人情報は含まない）。標準ライブラリのみ。

3施設 × 約10か月（2026-01〜10）の履歴と、2026-11/12 の提案勤務表を作る。
施設ごとに「癖」を埋め込み、学習で差が出るようにしてある。

  python3 scripts/synth/generate.py --out scripts/synth/out

出力: NDJSON（BigQuery 用）、*.schema.json、seed.json（Firestore 用）、truth.json（検証用の隠れた真値。投入しない）
乱数シード固定なので、同じコマンドで同じデータになる。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))
SEED = 20261109
HIST_START, HIST_END, ROSTER_END = date(2026, 1, 1), date(2026, 10, 31), date(2026, 12, 31)
SHIFT_HOURS = {"早番": (7.0, 16.0), "日勤": (9.0, 18.0), "遅番": (12.0, 21.0), "夜勤": (16.5, 33.5)}
SHIFTS = list(SHIFT_HOURS)
WORK_H = {"早番": 8.0, "日勤": 8.0, "遅番": 8.0, "夜勤": 15.0 - 2.0}  # 拘束から休憩を引いた概算
NIGHT_CAP = 9
OFF = "休"
WD = ["日", "月", "火", "水", "木", "金", "土"]


def wd(d: date) -> int:  # 0=日 .. 6=土
    return d.isoweekday() % 7


def sig(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def utc(dtm: datetime) -> str:
    return dtm.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def daterange(a: date, b: date):
    d = a
    while d <= b:
        yield d
        d += timedelta(days=1)


# ----------------------------------------------------------------- 施設の設定

def _units(code: str, names: list[str], cap: int):
    return [{"id": f"{code}-U{i+1}", "name": n, "floor": 1 + i // 2, "capacity": cap} for i, n in enumerate(names)]


FACILITIES = [
    {
        "id": "fac-sakura", "code": "SKR", "name": "さくら苑", "kind": "特別養護老人ホーム（架空）",
        "units": _units("SKR", ["ひなた", "そよかぜ", "あかり", "つぼみ"], 10),
        "n_staff": 34, "part_ratio": 0.15, "need": {"早番": 4, "日勤": 6, "遅番": 4, "夜勤": 4},
        "abs_base": 0.030, "n_rules": 3, "n_habits": 3,
        # 受諾モデル（施設ごとに係数が違う＝施設ごとに学習する意味がある）
        "acc": {"b0": -0.7, "lead": 0.9, "night": -0.5, "consec": -0.6, "hours": -0.5, "unit": 0.4, "recent": -0.35},
        "profile": "大規模・ユニット型。同僚の結束が強く、同じユニットからの依頼は受けられやすい。",
    },
    {
        "id": "fac-midori", "code": "MDR", "name": "みどりの丘", "kind": "住宅型有料老人ホーム（架空）",
        "units": _units("MDR", ["こもれび", "せせらぎ", "ゆうなぎ"], 8),
        "n_staff": 22, "part_ratio": 0.20, "need": {"早番": 3, "日勤": 4, "遅番": 3, "夜勤": 2},
        "abs_base": 0.035, "n_rules": 4, "n_habits": 2,
        "acc": {"b0": -1.0, "lead": 0.6, "night": -0.9, "consec": -0.9, "hours": -0.3, "unit": 0.1, "recent": -0.6},
        "profile": "個別対応が多い。直前の依頼や夜勤の依頼は断られやすく、連勤中の人は特に厳しい。",
    },
    {
        "id": "fac-hidamari", "code": "HDM", "name": "ひだまりの家", "kind": "認知症対応型グループホーム（架空）",
        "units": _units("HDM", ["さくら", "すみれ"], 9),
        "n_staff": 16, "part_ratio": 0.20, "need": {"早番": 2, "日勤": 2, "遅番": 2, "夜勤": 2},
        "abs_base": 0.040, "n_rules": 2, "n_habits": 2,
        "acc": {"b0": 0.0, "lead": 0.4, "night": -0.3, "consec": -0.3, "hours": -0.2, "unit": 0.0, "recent": -0.2},
        "profile": "少人数で家族的。パート職員が多く、依頼は比較的受けられやすいが人数に余裕がない。",
    },
]

FAMILY = ["青山", "浅野", "石井", "今村", "上田", "大塚", "岡本", "梶原", "川口", "木下", "黒田", "小島", "榊原", "島田", "杉山", "関",
          "武田", "千葉", "辻", "土屋", "出口", "遠藤", "永井", "新田", "野田", "浜田", "平野", "堀", "丸山", "水野", "望月", "安田",
          "柳", "吉村", "和田", "秋山", "桜井", "三宅", "谷口", "宮本"]
GIVEN = ["あおい", "一郎", "えみ", "かずき", "京子", "桂", "さやか", "翔太", "すず", "拓海", "千夏", "culture", "ともえ", "直樹", "のぞみ",
         "葉月", "ひかり", "文子", "まい", "巧", "実", "めぐみ", "康平", "ゆき", "良太", "涼", "れいか", "和也", "歩", "岳", "彩乃", "仁",
         "園子", "透", "奈緒", "宏", "雅", "真央", "弥生", "岬"]
GIVEN = [g for g in GIVEN if g != "culture"]

# 日課テンプレート（施設ごとに違う）: (task, 開始, 終了, 必要人数, 必要スキル, 備考)
TEMPLATES = {
    "SKR": [
        ("handover", "07:00", "07:30", 2, None, "夜勤からの引き継ぎ"),
        ("wake", "07:00", "08:00", 5, None, "起床・整容（ユニット4つ）"),
        ("med", "08:00", "08:30", 1, "medical", "朝の配薬"),
        ("meal", "08:00", "09:00", 6, "swallow", "朝食介助（嚥下配慮1名以上）"),
        ("bath", "10:00", "11:30", 4, "bath", "入浴 第1波"),
        ("excretion", "10:00", "11:00", 4, None, "排泄介助"),
        ("meal", "12:00", "13:00", 6, "swallow", "昼食介助"),
        ("bath", "13:30", "15:00", 4, "bath", "入浴 第2波"),
        ("rec", "14:30", "15:30", 2, None, "レク・機能訓練"),
        ("record", "15:30", "16:30", 2, "ict", "記録"),
        ("meal", "17:30", "18:30", 5, "swallow", "夕食介助"),
        ("bed", "19:30", "21:00", 5, None, "就寝介助"),
        ("round", "22:00", "23:00", 4, None, "夜間巡回（2時間ごと）"),
        ("nap", "01:00", "03:00", 2, None, "仮眠休憩（交代）"),
    ],
    "MDR": [
        ("wake", "07:00", "08:00", 3, None, "起床・整容"),
        ("meal", "08:00", "09:00", 4, "swallow", "朝食介助"),
        ("bath", "09:30", "16:00", 2, "bath", "個別入浴（時間は居住者ごとに分散）"),
        ("meal", "12:00", "13:00", 4, "swallow", "昼食介助"),
        ("rec", "14:00", "15:00", 2, None, "個別レク"),
        ("transport", "10:00", "11:00", 1, "driver", "通院送迎"),
        ("meal", "17:00", "18:30", 3, "swallow", "夕食介助（夕方に業務が集中）"),
        ("excretion", "18:00", "19:00", 2, None, "排泄介助"),
        ("bed", "19:30", "21:00", 3, None, "就寝介助"),
        ("round", "23:00", "00:00", 2, None, "夜間巡回（3時間ごと）"),
    ],
    "HDM": [
        ("wake", "06:30", "08:00", 2, None, "起床・整容"),
        ("meal", "07:30", "09:00", 2, None, "朝食（調理を一緒に）"),
        ("rec", "10:00", "11:30", 1, "dementia", "回想・体操"),
        ("meal", "12:00", "13:30", 2, None, "昼食（調理を一緒に）"),
        ("bath", "14:00", "16:00", 2, "bath", "入浴"),
        ("watch", "09:00", "17:00", 1, "dementia", "見守り"),
        ("meal", "17:30", "19:00", 2, None, "夕食"),
        ("bed", "20:00", "21:00", 2, None, "就寝介助"),
        ("round", "23:00", "00:00", 2, None, "夜間巡回（3時間ごと）"),
    ],
}

REASONS = ["体調不良", "家族の事情", "通院", "子の看病", "忌引", "その他"]


# ----------------------------------------------------------------- スタッフ

def make_staff(rng: random.Random, fc: dict):
    staff, latent = [], {}
    units = [u["id"] for u in fc["units"]]
    for i in range(fc["n_staff"]):
        sid = f"{fc['code']}-{i + 1:03d}"
        if i == 0:
            role = "主任"
        else:
            r = rng.random()
            role = "介護福祉士" if r < 0.55 else "介護職員" if r < 0.88 else "新人"
        part = i > 0 and rng.random() < fc["part_ratio"]
        years = {"主任": rng.randint(15, 25), "介護福祉士": rng.randint(5, 22), "介護職員": rng.randint(1, 9), "新人": rng.randint(0, 1)}[role]
        pool = {"medical": .35, "dementia": .45, "bath": .55, "swallow": .35, "driver": .25, "terminal": .2, "follow": .2, "ict": .2, "preceptor": .12}
        skills = {k for k, p in pool.items() if rng.random() < p * (0.1 if role == "新人" else 1)}
        if role == "主任":
            skills |= {"follow", "medical", "preceptor", "ict"}
        night = (not part) and role not in ("主任", "新人") and rng.random() < 0.95
        if night:
            skills.add("night")
        shifts = ["早番", "日勤", "遅番"] + (["夜勤"] if night else [])
        leave_by = None
        if role == "主任":
            shifts = ["早番", "日勤"]
        elif part:
            shifts = rng.choice([["日勤", "早番"], ["日勤", "遅番"], ["日勤"]])
            if rng.random() < 0.5:
                leave_by, shifts = rng.choice(["15:00", "16:00", "17:00"]), ["日勤", "早番"]
        staff.append({
            "facility_id": fc["id"], "staff_id": sid,
            "name": f"{FAMILY[(i * 7 + fc['n_staff']) % len(FAMILY)]} {GIVEN[(i * 11 + len(fc['code'])) % len(GIVEN)]}",
            "role": role, "employment": "パート" if part else "常勤",
            "license": "初任者研修" if role == "新人" else "実務者研修" if role == "介護職員" else "介護福祉士",
            "years": years, "skills": sorted(skills), "shifts": shifts,
            "home_unit": units[i % len(units)], "leave_by": leave_by, "is_leader": role == "主任",
        })
        latent[sid] = {
            "b_accept": rng.gauss(0, 0.9),
            "wd_pref": [rng.gauss(0, 0.25) for _ in range(7)],
            "shift_pref": {s: rng.gauss(0, 0.3) for s in SHIFTS},
            "prone": rng.gauss(0, 0.3),
            "abs_prop": math.exp(rng.gauss(0, 0.35)),
        }
    return staff, latent


# ----------------------------------------------------------------- 勤務表

class Roster:
    """roster[staff_id][date] = 勤務区分（休みは持たない）"""

    def __init__(self, staff):
        self.r: dict[str, dict[date, str]] = {s["staff_id"]: {} for s in staff}
        self.by = {s["staff_id"]: s for s in staff}

    def get(self, sid, d):
        return self.r[sid].get(d)

    def consec_before(self, sid, d):
        n, x = 0, d - timedelta(days=1)
        while self.r[sid].get(x):
            n += 1
            x -= timedelta(days=1)
        return n

    def can_take(self, sid, d, sh, max_run=5):
        s = self.by[sid]
        if sh not in s["shifts"] or self.get(sid, d):
            return False
        prev, nxt = self.get(sid, d - timedelta(days=1)), self.get(sid, d + timedelta(days=1))
        if prev == "夜勤":  # 明け
            return False
        if prev == "遅番" and sh == "早番":  # 勤務間インターバルが短い（デモ用の仮値）
            return False
        if sh == "夜勤" and nxt:
            return False
        if sh == "遅番" and nxt == "早番":
            return False
        if nxt and sh == "夜勤":
            return False
        run, x = 1, d - timedelta(days=1)
        while self.get(sid, x):
            run += 1
            x -= timedelta(days=1)
        x = d + timedelta(days=1)
        while self.get(sid, x):
            run += 1
            x += timedelta(days=1)
        return run <= max_run

    def month_hours_before(self, sid, d):
        return sum(WORK_H[v] for k, v in self.r[sid].items() if k.year == d.year and k.month == d.month and k < d)

    def nights_last30(self, sid, d):
        return sum(1 for k, v in self.r[sid].items() if v == "夜勤" and d - timedelta(days=30) <= k < d)


def make_requests(rng, fc, staff):
    """希望休。月ごとに1人2〜4日。"""
    req = defaultdict(set)
    for s in staff:
        for ym in sorted({(d.year, d.month) for d in daterange(HIST_START, ROSTER_END)}):
            first = date(ym[0], ym[1], 1)
            days = [first + timedelta(days=k) for k in range(28)]
            for d in rng.sample(days, rng.randint(2, 4) if s["employment"] == "常勤" else rng.randint(3, 6)):
                req[s["staff_id"]].add(d)
    return req


def make_proposals(rng, fc, staff, requests):
    """ルールを知らないソルバー提案の代わりに、貪欲法で作る。希望休はおおむね尊重する。"""
    ro = Roster(staff)
    need = fc["need"]
    n_days = {}
    state = {s["staff_id"]: {"count": 0, "nights": 0, "target": 0} for s in staff}
    short = 0
    for d in daterange(HIST_START, ROSTER_END):
        if d.day == 1:
            for s in staff:
                st = state[s["staff_id"]]
                st["count"], st["nights"] = 0, 0
                st["target"] = (12 if s["employment"] == "パート" else 21) + (rng.randint(-1, 0) if s["employment"] == "常勤" else 0)
        dim = (date(d.year + (d.month == 12), d.month % 12 + 1, 1) - date(d.year, d.month, 1)).days
        left = dim - d.day + 1
        today = set()
        for sh in ["夜勤", "早番", "遅番", "日勤"]:
            cands = []
            for s in staff:
                sid = s["staff_id"]
                if sid in today or not ro.can_take(sid, d, sh):
                    continue
                if d in requests[sid] and rng.random() < 0.95:
                    continue
                st = state[sid]
                if st["count"] >= st["target"] + 1 or (sh == "夜勤" and st["nights"] >= NIGHT_CAP):
                    continue
                urgency = (st["target"] - st["count"]) / max(left, 1)
                cands.append((urgency + rng.random() * 0.35, sid))
            cands.sort(reverse=True)
            pick = [sid for _, sid in cands[: need[sh]]]
            if sh == "夜勤" and pick and not any("medical" in ro.by[p]["skills"] for p in pick):
                alt = [sid for _, sid in cands[need[sh]:] if "medical" in ro.by[sid]["skills"]]
                if alt:
                    pick[-1] = alt[0]
            short += max(0, need[sh] - len(pick))
            for sid in pick:
                ro.r[sid][d] = sh
                today.add(sid)
                state[sid]["count"] += 1
                state[sid]["nights"] += sh == "夜勤"
    return ro, short


def hidden_rules(rng, fc, staff):
    """リーダーの頭の中にだけある癖。毎月くり返し手修正として現れる。"""
    eligible = [s for s in staff if not s["is_leader"]]
    out = []
    for _ in range(fc["n_rules"]):
        s = rng.choice(eligible)
        sh = rng.choice([x for x in s["shifts"] if x != "日勤"] or ["早番"])
        out.append({"staff_id": s["staff_id"], "weekday": rng.randint(0, 6), "shift": sh})
    return out


def apply_leader_edits(rng, fc, staff, ro: Roster, rules):
    """提案に対するリーダーの手修正を追記ログとして作る。"""
    edits = []
    by = ro.by

    def log(month_first, sid, d, frm, to, kind):
        base = datetime(month_first.year, month_first.month, 1, tzinfo=JST) - timedelta(days=10)
        edits.append({
            "edit_id": f"EDIT-{fc['code']}-{len(edits) + 1:05d}", "facility_id": fc["id"], "month": f"{d.year}-{d.month:02d}",
            "staff_id": sid, "date": d.isoformat(), "weekday": wd(d), "from_shift": frm, "to_shift": to,
            "edited_at": utc(base + timedelta(hours=rng.uniform(9, 20), minutes=rng.randint(0, 59))), "synthetic": True,
        })

    def replace(sid, d, sh):
        pool = [x["staff_id"] for x in staff if x["staff_id"] != sid and ro.can_take(x["staff_id"], d, sh)]
        if not pool:
            return None
        pool.sort(key=lambda x: ro.month_hours_before(x, d) + rng.random() * 8)
        return pool[0]

    for d in daterange(HIST_START, HIST_END):
        mfirst = date(d.year, d.month, 1)
        for r in rules:
            sid, sh = r["staff_id"], r["shift"]
            if wd(d) == r["weekday"] and ro.get(sid, d) == sh and rng.random() < 0.9:
                rep = replace(sid, d, sh)
                if rep:
                    del ro.r[sid][d]
                    ro.r[rep][d] = sh
                    log(mfirst, sid, d, sh, OFF, "rule")
                    log(mfirst, rep, d, OFF, sh, "cover")
        if rng.random() < 0.13:  # ルールではない単発の手修正
            sid = rng.choice([x["staff_id"] for x in staff if ro.get(x["staff_id"], d)])
            sh = ro.get(sid, d)
            rep = replace(sid, d, sh)
            if rep:
                del ro.r[sid][d]
                ro.r[rep][d] = sh
                log(mfirst, sid, d, sh, OFF, "noise")
                log(mfirst, rep, d, OFF, sh, "cover")
    return edits


def make_task_edits(rng, fc, staff):
    """日次の手修正（人 × 時間帯 × 業務）。くり返す癖を2〜3件。"""
    blocks = {"午前": "bath", "午後": "bath", "夕方": "meal", "夜間": "round"}
    rows, habits = [], []
    eligible = [s for s in staff if not s["is_leader"]]
    for _ in range(fc["n_habits"]):
        s = rng.choice(eligible)
        blk = rng.choice(list(blocks))
        habits.append({"staff_id": s["staff_id"], "block": blk, "task": blocks[blk]})
    for h in habits:
        for d in daterange(HIST_START, HIST_END):
            if rng.random() < 0.20:  # 月に5〜6日ほど
                t = datetime(d.year, d.month, d.day, 8, tzinfo=JST) + timedelta(minutes=rng.randint(0, 600))
                rows.append({
                    "task_edit_id": f"TEDIT-{fc['code']}-{len(rows) + 1:05d}", "facility_id": fc["id"], "date": d.isoformat(),
                    "staff_id": h["staff_id"], "time_block": h["block"], "from_task": h["task"], "to_task": "watch" if h["task"] != "round" else "record",
                    "edited_at": utc(t), "synthetic": True,
                })
    return rows, habits


# ----------------------------------------------------------------- 欠員・打診・健康

def start_dt(d: date, sh: str) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=JST) + timedelta(hours=SHIFT_HOURS[sh][0])


def simulate(rng, fc, staff, latent, ro: Roster):
    P = fc["acc"]
    by = ro.by
    health, vacs, offers, assigns, events = [], [], [], [], []

    # 最終の勤務表（欠員処理の前）を assignments の元にする
    absences = []
    for d in daterange(HIST_START, HIST_END):
        for sid, tbl in ro.r.items():
            sh = tbl.get(d)
            if not sh:
                continue
            lt = latent[sid]
            consec = ro.consec_before(sid, d)
            fat = lt["prone"] + (0.4 if consec >= 4 else 0) + (0.25 if sh == "夜勤" else 0)
            score = max(1, min(5, round(2.4 + fat * 1.2 + rng.gauss(0, 0.8))))
            if rng.random() < 0.75:  # 前日の自己チェック（観測されるのはこれだけ）
                health.append({
                    "facility_id": fc["id"], "staff_id": sid, "date": (d - timedelta(days=1)).isoformat(), "fatigue": score,
                    "sleep_hours": round(max(3.0, min(9.5, 7.2 - 0.5 * (score - 2.5) + rng.gauss(0, 0.6))), 1),
                    "mood": max(1, min(5, round(3.6 - 0.5 * (score - 2.5) + rng.gauss(0, 0.7)))), "next_shift": sh,
                })
            season = 1.3 if d.month in (1, 2, 12) else 1.1 if d.month in (7, 8) else 1.0
            wdf = 1.25 if wd(d) == 1 else 1.1 if wd(d) == 0 else 1.0
            p = min(0.25, fc["abs_base"] * lt["abs_prop"] * season * wdf * math.exp(0.5 * (score - 2.5)))
            if rng.random() < p:
                absences.append((d, sid, sh))

    # 勤務表の行（欠員の補充は後で反映）
    absent_set = {(d, sid) for d, sid, _ in absences}
    for sid, tbl in ro.r.items():
        for d, sh in tbl.items():
            if d <= HIST_END:
                assigns.append({
                    "facility_id": fc["id"], "date": d.isoformat(), "staff_id": sid, "shift": sh, "unit_id": by[sid]["home_unit"],
                    "status": "absent" if (d, sid) in absent_set else "assigned", "source": "base",
                })

    # 欠員を発生順に処理
    pend = []
    for d, sid, sh in absences:
        r = rng.random()
        lead = rng.uniform(1.5, 8) if r < 0.30 else rng.uniform(8, 30) if r < 0.65 else rng.uniform(30, 160)
        pend.append((start_dt(d, sh) - timedelta(hours=lead), d, sid, sh, lead))
    pend.sort()
    offer_log = defaultdict(list)
    per_day = defaultdict(int)
    for disc, d, absent, sh, lead in pend:
        del ro.r[absent][d]
        unit = by[absent]["home_unit"]
        per_day[d] += 1
        vid = f"VAC-{d:%Y%m%d}-{fc['code']}{per_day[d]:02d}"
        reason = rng.choices(REASONS, [.5, .2, .1, .12, .03, .05])[0]
        need_skills = ["medical"] if (sh == "夜勤" and "medical" in by[absent]["skills"] and rng.random() < 0.5) else []
        start = start_dt(d, sh)
        ev = lambda typ, ts, payload: events.append({  # noqa: E731
            "event_id": str(uuid.UUID(int=rng.getrandbits(128))), "event_type": typ, "vacancy_id": vid, "facility_id": fc["id"],
            "ts": ts, "payload": payload})
        ev("vacancy_created", disc, {"date": d.isoformat(), "shift": sh, "unit_id": unit, "reason": reason, "need_skills": need_skills, "absent_staff_id": absent})

        # 過去の運用の候補順位（同じユニット・スキル・当月勤務時間の少なさ＋ばらつき）
        cands = []
        for s in staff:
            c = s["staff_id"]
            if c == absent or not ro.can_take(c, d, sh):
                continue
            if need_skills and not set(need_skills) <= set(s["skills"]):
                continue
            score = (1.0 if s["home_unit"] == unit else 0) + 0.5 * (1 if "night" in s["skills"] and sh == "夜勤" else 0) \
                - 0.02 * ro.month_hours_before(c, d) + rng.gauss(0, 0.6)
            cands.append((score, c))
        cands.sort(reverse=True)

        t, filled_by, route, n_offers = disc, None, None, 0
        for k, (_, c) in enumerate(cands[:6], start=1):
            if t >= start - timedelta(minutes=45):
                break
            s, lt = by[c], latent[c]
            lead_h = (start - t).total_seconds() / 3600
            same_unit, skill_match = s["home_unit"] == unit, set(need_skills) <= set(s["skills"])
            consec = ro.consec_before(c, d)
            mh = ro.month_hours_before(c, d)
            n30 = ro.nights_last30(c, d)
            recent = sum(1 for x in offer_log[c] if t - timedelta(days=14) <= x <= t)
            logit = (P["b0"] + lt["b_accept"] + P["lead"] * (math.log(max(lead_h, 0.5) / 24) / 1.5)
                     + P["night"] * (sh == "夜勤") + P["consec"] * max(0, consec - 3) / 2 + P["hours"] * (mh - 150) / 40
                     + P["unit"] * same_unit + P["recent"] * recent + lt["wd_pref"][wd(d)] + lt["shift_pref"][sh])
            p = sig(logit)
            wait = timedelta(minutes=rng.uniform(20, 45) if lead_h < 8 else rng.uniform(60, 180))
            u = rng.random()
            offer_log[c].append(t)
            n_offers += 1
            if u < p:
                status, resp = "accepted", rng.lognormvariate(math.log(18), 0.7)
            elif rng.random() < (0.25 if lead_h < 8 else 0.12):
                status, resp = "expired", None
            else:
                status, resp = "declined", rng.lognormvariate(math.log(12), 0.6)
            responded = t + (timedelta(minutes=resp) if resp is not None else wait)
            offers.append({
                "offer_id": f"OFF-{vid}-{k}", "vacancy_id": vid, "facility_id": fc["id"], "staff_id": c, "rank": k,
                "offered_at": utc(t), "responded_at": utc(responded) if resp is not None else None, "status": status,
                "response_min": round(resp, 1) if resp is not None else None, "lead_hours": round(lead_h, 2), "weekday": wd(d),
                "shift": sh, "same_unit": same_unit, "skill_match": skill_match, "consec_before": consec,
                "month_hours_before": round(mh, 1), "nights_last30": n30, "offers_last14": recent,
                "tenure_years": s["years"], "employment": s["employment"],
            })
            ev("offer_sent", t, {"staff_id": c, "rank": k})
            ev("offer_responded", responded, {"staff_id": c, "status": status})
            if status == "accepted":
                filled_by, route = c, "offer"
                ro.r[c][d] = sh
                assigns.append({"facility_id": fc["id"], "date": d.isoformat(), "staff_id": c, "shift": sh, "unit_id": unit, "status": "assigned", "source": "offer"})
                break
            t = responded + timedelta(minutes=2)
        if not filled_by:
            ev("job_posted", t, {"reward": "謝礼あり（架空）"})
            if rng.random() < (0.45 if lead > 24 else 0.15):
                filled_by, route = "applicant", "applicant"
                ev("applicant_applied", t + timedelta(hours=rng.uniform(1, 6)), {})
            else:
                route = "adjusted"  # リーダーの調整（時間のずらし等）
        filled_at = None
        if route == "offer":
            filled_at = next(o["responded_at"] for o in reversed(offers) if o["vacancy_id"] == vid)
        elif route == "applicant":
            filled_at = utc(t + timedelta(hours=rng.uniform(2, 8)))
        else:
            filled_at = utc(min(start - timedelta(minutes=30), t + timedelta(hours=1)))
        ev("vacancy_filled", datetime.fromisoformat(filled_at.replace("Z", "+00:00")), {"by": filled_by, "route": route})
        vacs.append({
            "vacancy_id": vid, "facility_id": fc["id"], "date": d.isoformat(), "shift": sh, "unit_id": unit, "need_skills": need_skills,
            "reason": reason, "absent_staff_id": absent, "discovered_at": utc(disc), "lead_hours": round(lead, 2),
            "final_route": route, "filled_by": filled_by, "filled_at": filled_at, "n_offers": n_offers,
        })
    return health, vacs, offers, assigns, events


# ----------------------------------------------------------------- スキーマ

SCHEMAS = {
    "dim_facility": ["facility_id:STRING", "name:STRING", "kind:STRING", "units:STRING", "n_staff:INTEGER", "profile:STRING", "synthetic:BOOLEAN"],
    "dim_staff": ["facility_id:STRING", "staff_id:STRING", "name:STRING", "role:STRING", "employment:STRING", "license:STRING", "years:INTEGER",
                  "skills:STRING:REPEATED", "shifts:STRING:REPEATED", "home_unit:STRING", "leave_by:STRING", "is_leader:BOOLEAN"],
    "dim_task_templates": ["template_id:STRING", "facility_id:STRING", "task:STRING", "start:STRING", "end:STRING", "headcount:INTEGER", "skill:STRING", "note:STRING"],
    "fact_assignments": ["facility_id:STRING", "date:DATE", "staff_id:STRING", "shift:STRING", "unit_id:STRING", "status:STRING", "source:STRING"],
    "fact_requests": ["facility_id:STRING", "staff_id:STRING", "date:DATE", "kind:STRING", "granted:BOOLEAN"],
    "fact_roster_edits": ["edit_id:STRING", "facility_id:STRING", "month:STRING", "staff_id:STRING", "date:DATE", "weekday:INTEGER", "from_shift:STRING",
                          "to_shift:STRING", "edited_at:TIMESTAMP", "synthetic:BOOLEAN"],
    "fact_task_edits": ["task_edit_id:STRING", "facility_id:STRING", "date:DATE", "staff_id:STRING", "time_block:STRING", "from_task:STRING", "to_task:STRING",
                        "edited_at:TIMESTAMP", "synthetic:BOOLEAN"],
    "fact_health_checks": ["facility_id:STRING", "staff_id:STRING", "date:DATE", "fatigue:INTEGER", "sleep_hours:FLOAT", "mood:INTEGER", "next_shift:STRING"],
    "fact_vacancies": ["vacancy_id:STRING", "facility_id:STRING", "date:DATE", "shift:STRING", "unit_id:STRING", "need_skills:STRING:REPEATED", "reason:STRING",
                       "absent_staff_id:STRING", "discovered_at:TIMESTAMP", "lead_hours:FLOAT", "final_route:STRING", "filled_by:STRING", "filled_at:TIMESTAMP", "n_offers:INTEGER"],
    "fact_offers": ["offer_id:STRING", "vacancy_id:STRING", "facility_id:STRING", "staff_id:STRING", "rank:INTEGER", "offered_at:TIMESTAMP", "responded_at:TIMESTAMP",
                    "status:STRING", "response_min:FLOAT", "lead_hours:FLOAT", "weekday:INTEGER", "shift:STRING", "same_unit:BOOLEAN", "skill_match:BOOLEAN",
                    "consec_before:INTEGER", "month_hours_before:FLOAT", "nights_last30:INTEGER", "offers_last14:INTEGER", "tenure_years:INTEGER", "employment:STRING"],
    "events_raw_synthetic": ["subscription_name:STRING", "message_id:STRING", "publish_time:TIMESTAMP", "data:STRING", "attributes:STRING"],
}


def schema_json(cols):
    out = []
    for c in cols:
        p = c.split(":")
        out.append({"name": p[0], "type": p[1], "mode": p[2] if len(p) > 2 else "NULLABLE"})
    return out


def write_ndjson(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


# ----------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="scripts/synth/out")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    T = defaultdict(list)
    seed, truth = {"facilities": []}, {"facilities": {}}

    for fi, fc in enumerate(FACILITIES):
        rng = random.Random(SEED + fi)
        staff, latent = make_staff(rng, fc)
        requests = make_requests(rng, fc, staff)
        ro, short = make_proposals(rng, fc, staff, requests)
        proposal = {sid: dict(tbl) for sid, tbl in ro.r.items()}  # 提案（手修正前）
        rules = hidden_rules(rng, fc, staff)
        edits = apply_leader_edits(rng, fc, staff, ro, rules)
        current_full = {sid: dict(tbl) for sid, tbl in ro.r.items()}  # 手修正後（欠員処理前）
        task_edits, habits = make_task_edits(rng, fc, staff)
        health, vacs, offers, assigns, events = simulate(rng, fc, staff, latent, ro)

        # 希望休が通ったか
        for sid, ds in requests.items():
            for d in sorted(ds):
                if True:  # 11・12月の希望休も出す（granted は提案での結果）
                    T["fact_requests"].append({"facility_id": fc["id"], "staff_id": sid, "date": d.isoformat(), "kind": "off", "granted": d not in current_full[sid]})

        # 11・12月は提案＝現状（欠員処理なし）。Firestore のシード用
        for sid, tbl in current_full.items():
            for d, sh in tbl.items():
                if d > HIST_END:
                    T["fact_assignments"].append({"facility_id": fc["id"], "date": d.isoformat(), "staff_id": sid, "shift": sh,
                                                  "unit_id": ro.by[sid]["home_unit"], "status": "assigned", "source": "base"})
        T["dim_facility"].append({"facility_id": fc["id"], "name": fc["name"], "kind": fc["kind"], "units": json.dumps(fc["units"], ensure_ascii=False),
                                  "n_staff": fc["n_staff"], "profile": fc["profile"], "synthetic": True})
        T["dim_staff"] += staff
        for i, (task, s, e, hc, skill, note) in enumerate(TEMPLATES[fc["code"]], start=1):
            T["dim_task_templates"].append({"template_id": f"{fc['code']}-T{i:02d}", "facility_id": fc["id"], "task": task, "start": s, "end": e,
                                            "headcount": hc, "skill": skill, "note": note})
        T["fact_assignments"] += assigns
        T["fact_roster_edits"] += edits
        T["fact_task_edits"] += task_edits
        T["fact_health_checks"] += health
        T["fact_vacancies"] += vacs
        T["fact_offers"] += offers

        for e in edits:
            events.append({"event_id": str(uuid.UUID(int=rng.getrandbits(128))), "event_type": "roster_edit", "vacancy_id": None, "facility_id": fc["id"],
                           "ts": datetime.fromisoformat(e["edited_at"].replace("Z", "+00:00")),
                           "payload": {k: e[k] for k in ("staff_id", "date", "from_shift", "to_shift")}})
        for ev in events:
            ts = ev["ts"]
            data = {"event_id": ev["event_id"], "event_type": ev["event_type"], "vacancy_id": ev["vacancy_id"], "facility_id": ev["facility_id"],
                    "ts": ts.timestamp(), "payload": json.dumps(ev["payload"], ensure_ascii=False), "synthetic": True}
            T["events_raw_synthetic"].append({"subscription_name": "synthetic-history", "message_id": ev["event_id"], "publish_time": utc(ts),
                                              "data": json.dumps(data, ensure_ascii=False), "attributes": json.dumps({"synthetic": "true"})})

        # Firestore シード（11・12月の提案と現状）
        months = {}
        for ym in ((2026, 11), (2026, 12)):
            first = date(*ym, 1)
            dim = (date(ym[0] + (ym[1] == 12), ym[1] % 12 + 1, 1) - first).days
            rows = {sid: [current_full[sid].get(first + timedelta(days=k)) or "" for k in range(dim)] for sid in current_full}
            months[f"{ym[0]}-{ym[1]:02d}"] = {"month": f"{ym[0]}-{ym[1]:02d}", "days": dim, "firstWeekday": wd(first), "proposal": rows, "current": rows}
        seed["facilities"].append({"facility": {"id": fc["id"], "name": fc["name"], "kind": fc["kind"], "units": fc["units"], "profile": fc["profile"], "synthetic": True},
                                   "staff": staff, "templates": [t for t in T["dim_task_templates"] if t["facility_id"] == fc["id"]], "rosters": months})
        truth["facilities"][fc["id"]] = {"hidden_rules": rules, "task_habits": habits, "acc": fc["acc"], "understaffed_slots": short,
                                         "latent": {k: {"b_accept": round(v["b_accept"], 3)} for k, v in latent.items()}}

    for name, rows in T.items():
        write_ndjson(os.path.join(a.out, f"{name}.ndjson"), rows)
        with open(os.path.join(a.out, f"{name}.schema.json"), "w") as f:
            json.dump(schema_json(SCHEMAS[name]), f, ensure_ascii=False)
    with open(os.path.join(a.out, "seed.json"), "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False)
    with open(os.path.join(a.out, "truth.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, ensure_ascii=False, indent=1)
    print({k: len(v) for k, v in T.items()})
    print("understaffed slots:", {k: v["understaffed_slots"] for k, v in truth["facilities"].items()})


if __name__ == "__main__":
    main()
