"""応諾予測の特徴量。学習（pandas）と API の採点（純 Python）で同じ関数を使い、食い違いを防ぐ。

特徴量は「打診の時点で分かること」だけ。結果（応諾・辞退）や、打診より後の情報は使わない。
"""
from __future__ import annotations

import math

FEATURES = ["log_lead", "is_night", "is_early", "is_late", "same_unit", "skill_match", "consec_excess", "hours_dev",
            "nights_last30", "offers_last14", "tenure", "part_time", "is_weekend", "staff_prior"]
PRIOR_K = 5.0       # 人ごとの応諾率は、施設全体の応諾率に向けて縮める（件数が少ない人の外れ値を避ける）


def logit(p: float) -> float:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def staff_prior(n: int, acc: int, base: float, k: float = PRIOR_K) -> float:
    """その人の過去の応諾率（縮約）。学習では自分自身を除いて（leave-one-out）計算する。"""
    return (acc + k * base) / (n + k)


def row_features(r: dict, stats: dict[str, list[float]], base: float, *, loo_label: int | None = None) -> list[float]:
    """r は打診1件（fact_offers の列）。stats は {staff_id: [件数, 応諾数]}。loo_label を渡すと、その1件を統計から除く。"""
    n, acc = stats.get(r["staff_id"], [0, 0])
    if loo_label is not None:
        n, acc = n - 1, acc - loo_label
    prior = staff_prior(max(n, 0), max(acc, 0), base)
    sh = r["shift"]
    return [math.log(max(float(r["lead_hours"]), 0.5) / 24.0), float(sh == "夜勤"), float(sh == "早番"), float(sh == "遅番"),
            float(bool(r["same_unit"])), float(bool(r["skill_match"])), float(max(0, int(r["consec_before"]) - 3)),
            (float(r["month_hours_before"]) - 150.0) / 40.0, float(r["nights_last30"]), float(r["offers_last14"]),
            float(r["tenure_years"]) / 10.0, float(r["employment"] == "パート"), float(int(r["weekday"]) in (0, 6)), logit(prior)]
