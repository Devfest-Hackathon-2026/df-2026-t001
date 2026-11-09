"""日課テンプレート → 時間帯ごとの必要人数。月次と日次をつなぐ集約制約の元になる。

運用日は 00:00〜24:00 を 30 分の枠（48枠）に分ける。ある運用日に在席しているのは
「その日に始まった勤務」と「前日の夜勤（翌朝 09:30 まで）」。
"""
from __future__ import annotations

from dataclasses import dataclass

from ..dsl import WORK_SHIFTS, TaskTemplate

SLOTS = 48
SHIFT_SPAN: dict[str, tuple[float, float]] = {"早番": (7.0, 16.0), "日勤": (9.0, 18.0), "遅番": (12.0, 21.0), "夜勤": (16.5, 33.5)}
SKIP_TASKS = {"nap", "break"}       # 休憩は人ごとの変数として別に扱う


def hh(s: str) -> float:
    h, m = s.split(":")
    return int(h) + int(m) / 60


def slot_label(k: int) -> str:
    return f"{k // 2:02d}:{'30' if k % 2 else '00'}"


def window(t: TaskTemplate) -> tuple[float, float]:
    s, e = hh(t.start), hh(t.end)
    if e <= s:
        e = 24.0
    return s, e


def presence(shift: str, prev_day: bool) -> frozenset[int]:
    """その勤務が運用日の何枠目に在席しているか。prev_day=True は前日に始まった勤務。"""
    a, b = SHIFT_SPAN[shift]
    if prev_day:
        a, b = a - 24, b - 24
    return frozenset(k for k in range(SLOTS) if a <= k / 2 and k / 2 + 0.5 <= b)


def slots_of(t: TaskTemplate) -> range:
    s, e = window(t)
    return range(int(round(s * 2)), int(round(e * 2)))


def demand(templates: list[TaskTemplate]) -> list[int]:
    d = [0] * SLOTS
    for t in templates:
        if t.task in SKIP_TASKS:
            continue
        for k in slots_of(t):
            d[k] += t.headcount
    return d


def skill_need(t: TaskTemplate) -> int:
    return 2 if (t.skill == "bath" and t.headcount >= 4) else 1


@dataclass
class Sig:
    """在席の顔ぶれが同じ枠をまとめたもの。制約は日ごと・この単位で置く。"""
    today: frozenset[str]
    prev: frozenset[str]
    slots: list[int]
    need: int
    skills: dict[str, int]

    @property
    def label(self) -> str:
        a, b = min(self.slots), max(self.slots) + 1
        return f"{slot_label(a)}〜{slot_label(b)}" if b < SLOTS else f"{slot_label(a)}〜24:00"


def signatures(templates: list[TaskTemplate], boost: dict[int, int] | None = None,
               boost_skill: dict[tuple[int, str], int] | None = None) -> list[Sig]:
    """boost: 枠 → 追加で必要な人数、boost_skill: (枠, 資格) → 追加で必要な資格者数。
    日次で足りなかった分を月次へ戻すときに使う。"""
    dem = demand(templates)
    skl: list[dict[str, int]] = [dict() for _ in range(SLOTS)]
    for t in templates:
        if t.task in SKIP_TASKS or not t.skill:
            continue
        for k in slots_of(t):
            skl[k][t.skill] = skl[k].get(t.skill, 0) + skill_need(t)    # 同時に走る業務の分は足し合わせる
    groups: dict[tuple[frozenset[str], frozenset[str]], Sig] = {}
    for k in range(SLOTS):
        today = frozenset(sh for sh in WORK_SHIFTS if k in presence(sh, False))
        prev = frozenset(sh for sh in WORK_SHIFTS if k in presence(sh, True))
        need = dem[k] + (boost or {}).get(k, 0)
        for (bk, sk), n in (boost_skill or {}).items():
            if bk == k:
                skl[k][sk] = skl[k].get(sk, 0) + n
        if need == 0 and not skl[k]:
            continue
        g = groups.setdefault((today, prev), Sig(today, prev, [], 0, {}))
        g.slots.append(k)
        g.need = max(g.need, need)
        for sk, n in skl[k].items():
            g.skills[sk] = max(g.skills.get(sk, 0), n)
    return [g for g in groups.values() if g.need > 0 or g.skills]


def capacity_report(templates: list[TaskTemplate], need_per_shift: dict[str, int]) -> list[tuple[str, int, int]]:
    """施設の基準人数で、各枠の在席人数が需要を満たすか（時間帯, 需要, 在席）。足りない枠だけ返す。"""
    dem = demand(templates)
    out = []
    for k in range(SLOTS):
        on = sum(need_per_shift.get(sh, 0) for sh in WORK_SHIFTS if k in presence(sh, False) or k in presence(sh, True))
        if dem[k] > on:
            out.append((slot_label(k), dem[k], on))
    return out
