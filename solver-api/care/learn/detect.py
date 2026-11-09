"""反復検出: リーダーの手修正の「くり返し」から、施設ルールの候補を見つける。

参考: ben1san/df-hack26 の考え方（くり返しを検出して候補を出す。閾値は観測量から計算する）。コードは複製していない。

* 鍵 = (人, 曜日, 外された勤務)。勤務を外した手修正だけを数える。「直した後」は鍵に入れない。
* 閾値は固定の「3回」にしない。鍵の数 K と、1か月あたりの手修正の数から、
  『偶然これだけ重なる鍵が、観測期間に1つ以上出る確率が alpha（既定 1 件/年）未満』になる最小の月数 m を二項分布で求める。
* 検出しても、ルールは作らない。候補（根拠つき）を出し、リーダーが範囲・期限を選んで採否を決める。
日次（人 × 時間帯 × 業務）も同じ方法で検出する。
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timedelta

from .. import vocab
from ..dsl import DaySel, Lifecycle, Origin, PeopleSel, Request, ShiftSel, TaskRequest

WD = ["日", "月", "火", "水", "木", "金", "土"]
BLOCKS = {"午前": (6.0, 12.0), "午後": (12.0, 17.0), "夕方": (17.0, 21.0), "夜間": (21.0, 24.0)}
MIN_MONTHS = 3          # どんなに閾値が低くても、最低これだけの月で繰り返されていること
RECENT_MONTHS = 3       # 最近も続いていること（古い癖は候補にしない）


def binom_tail(n: int, p: float, m: int) -> float:
    """P(X >= m), X ~ Binomial(n, p)"""
    if m <= 0:
        return 1.0
    return sum(math.comb(n, k) * p**k * (1 - p) ** (n - k) for k in range(m, n + 1))


ALPHA = 0.25          # 偶然の候補の期待数（観測期間あたり）。誤った候補は、リーダーが却下できる前提で緩め


def threshold(n_obs: int, n_keys: int, events_per_period: float, *, false_alerts: float = ALPHA) -> int:
    """偶然で重なる鍵の期待数（K × 上側確率）が false_alerts を下回る、最小の回数 m。"""
    if n_keys <= 0 or n_obs <= 0 or events_per_period <= 0:
        return MIN_MONTHS
    p = min(events_per_period / n_keys, 0.999)
    for m in range(1, n_obs + 1):
        if n_keys * binom_tail(n_obs, p, m) < false_alerts:
            return max(m, MIN_MONTHS)
    return n_obs + 1                  # どの回数でも偶然と区別できない → 検出しない


def _months(edits: list[dict]) -> list[str]:
    return sorted({e["month"] if "month" in e else e["date"][:7] for e in edits})


def detect_roster(edits: list[dict], *, n_staff: int, n_shifts: int = 4, now_month: str | None = None) -> list[dict]:
    """edits: {edit_id, staff_id, date(YYYY-MM-DD), weekday, from_shift, to_shift}。勤務を外した修正（to が休）だけを使う。"""
    off = ("", "休")                      # 休みの表記は、合成データでは「休」、API では空文字
    rem = [e for e in edits if e["from_shift"] not in off and e["to_shift"] in off]
    months = sorted({e["date"][:7] for e in edits})
    if not rem or len(months) < MIN_MONTHS:
        return []
    K = n_staff * 7 * n_shifts
    m_min = threshold(len(months), K, len(rem) / len(months))
    by: dict[tuple, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))
    for e in rem:
        by[(e["staff_id"], int(e["weekday"]), e["from_shift"])][e["date"][:7]].append(e)
    last = (now_month or months[-1])
    out = []
    for (sid, wd, sh), pm in by.items():
        m = len(pm)
        if m < m_min or not any(_months_between(mm, last) < RECENT_MONTHS for mm in pm):
            continue
        p0 = min(len(rem) / len(months) / K, 0.999)
        out.append({"kind": "roster", "key": f"roster:{sid}:{wd}:{sh}", "staff_id": sid, "weekday": wd, "shift": sh,
                    "months_observed": len(months), "months_repeated": m, "threshold": m_min, "false_alert_tail": binom_tail(len(months), p0, m) * K,
                    "months": sorted(pm), "edit_ids": [e["edit_id"] for es in pm.values() for e in es][:12],
                    "evidence": f"過去{len(months)}か月のうち{m}か月、{WD[wd]}曜の{sh}を外した（偶然とは考えにくい回数: {m_min}か月以上）"})
    return sorted(out, key=lambda c: (-c["months_repeated"], c["key"]))


def _months_between(a: str, b: str) -> int:
    ya, ma = map(int, a.split("-"))
    yb, mb = map(int, b.split("-"))
    return (yb - ya) * 12 + (mb - ma)


def detect_daily(task_edits: list[dict], *, n_staff: int, n_tasks: int = 8) -> list[dict]:
    """task_edits: {task_edit_id, staff_id, date, time_block, from_task}。同じ日に何度あっても1日と数える。"""
    days = sorted({e["date"] for e in task_edits})
    if not days:
        return []
    span = (date.fromisoformat(days[-1]) - date.fromisoformat(days[0])).days + 1
    K = n_staff * len(BLOCKS) * n_tasks
    keyed: dict[tuple, set[str]] = defaultdict(set)
    ids: dict[tuple, list[str]] = defaultdict(list)
    for e in task_edits:
        k = (e["staff_id"], e["time_block"], e["from_task"])
        keyed[k].add(e["date"])
        ids[k].append(e["task_edit_id"])
    per_day = sum(len(v) for v in keyed.values()) / span
    m_min = max(threshold(span, K, per_day * 1.0), 5)
    out = []
    for (sid, blk, task), ds in keyed.items():
        if len(ds) >= m_min and (date.fromisoformat(days[-1]) - date.fromisoformat(max(ds))).days <= 90:
            out.append({"kind": "daily", "key": f"daily:{sid}:{blk}:{task}", "staff_id": sid, "time_block": blk, "task": task,
                        "days_repeated": len(ds), "days_observed": span, "threshold": m_min, "edit_ids": ids[(sid, blk, task)][:12],
                        "evidence": f"過去{span}日のうち{len(ds)}日、{blk}の{vocab.task(task)}を外した（偶然とは考えにくい回数: {m_min}日以上）"})
    return sorted(out, key=lambda c: (-c["days_repeated"], c["key"]))


def to_rule(c: dict, names: dict[str, str], *, term_months: int | None = None, today: date | None = None) -> dict:
    """候補 → ルール（DSL）。term_months を渡すと、その月数で期限を切る。"""
    org = Origin(kind="反復検出", evidence=c["evidence"], detected_from=c["edit_ids"])
    life = Lifecycle(expires_on=(today or date.today()) + timedelta(days=30 * term_months)) if term_months else Lifecycle()
    name = names.get(c["staff_id"], c["staff_id"])
    if c["kind"] == "roster":
        r = Request(id=f"r-learned-{c['key'].replace(':', '-')}", label=f"{name}は{WD[c['weekday']]}曜の{c['shift']}に入らない", strength="強く",
                    origin=org, lifecycle=life, people=PeopleSel(ids=[c["staff_id"]]), days=DaySel(weekdays=[c["weekday"]]),
                    shifts=ShiftSel(ids=[c["shift"]]), want=False)
    else:
        lo, hi = BLOCKS[c["time_block"]]
        from ..vocab import task as task_ja

        r = TaskRequest(id=f"r-learned-{c['key'].replace(':', '-')}", label=f"{name}は{c['time_block']}の{task_ja(c['task'])}を担当しない", strength="強く",
                        origin=org, lifecycle=life, people=PeopleSel(ids=[c["staff_id"]]), task=c["task"], from_hour=lo, to_hour=hi, want=False)
    return r.model_dump(mode="json")
