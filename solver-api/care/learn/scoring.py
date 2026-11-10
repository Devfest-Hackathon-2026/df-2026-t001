"""学習済みモデル（JSON の成果物）を純 Python で採点する。API は scikit-learn / xgboost を持たない。

* logistic: 標準化 → 係数 → シグモイド
* BigQuery ML 由来の成果物も kind は logistic / xgboost（model_type に bqml_* が入る。bqml.py）
* xgboost : ブースターを JSON にダンプした木を、そのまま辿って足し合わせる（テストで xgboost 本体の予測と一致を確認）
"""
from __future__ import annotations

import json
import math
import struct

from .features import FEATURES, row_features


def _sig(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(min(x, 35.0), -35.0)))


def _f32(v: float) -> float:
    """xgboost は特徴量・分岐の閾値を 32 ビット浮動小数点で比べる。境界に近い値の分岐を一致させるため、同じ丸めをする。"""
    return struct.unpack("f", struct.pack("f", v))[0]


def _tree(node: dict, x: list[float], names: list[str]) -> float:
    while "leaf" not in node:
        sp = node["split"]
        if isinstance(sp, str) and sp[0] == "f" and sp[1:].isdigit():      # xgboost のダンプは f0, f1, … の番号
            i = int(sp[1:])
        else:
            i = names.index(sp) if isinstance(sp, str) else int(sp)
        nxt = node["yes"] if _f32(x[i]) < _f32(node["split_condition"]) else node["no"]
        node = next(c for c in node["children"] if c["nodeid"] == nxt)
    return float(node["leaf"])


LOGISTIC = ("logistic", "pooled_logistic")


def predict(art: dict, r: dict) -> float:
    x = row_features(r, {k: v for k, v in art["staff_stats"].items()}, art["base_rate"])
    if art["kind"] in LOGISTIC:
        z = art["intercept"] + sum(c * (v - m) / s for c, v, m, s in zip(art["coef"], x, art["scaler"]["mean"], art["scaler"]["scale"]))
        return _sig(z)
    names = art["features"]
    margin = art["xgb"]["base_margin"] + sum(_tree(t, x, names) for t in art["xgb"]["trees"])
    return _sig(margin)


def explain(art: dict, r: dict, top: int = 3) -> list[tuple[str, float]]:
    """logistic のとき、確率への寄与が大きい特徴量（名前, 寄与=係数×標準化した値）。xgboost は空。"""
    if art["kind"] not in LOGISTIC:
        return []
    x = row_features(r, art["staff_stats"], art["base_rate"])
    contrib = [(n, c * (v - m) / s) for n, c, v, m, s in zip(FEATURES, art["coef"], x, art["scaler"]["mean"], art["scaler"]["scale"])]
    return sorted(contrib, key=lambda t: -abs(t[1]))[:top]


def load(text: str) -> dict:
    art = json.loads(text)
    if art.get("schema") != 1:
        raise ValueError("未対応の成果物です")
    return art
