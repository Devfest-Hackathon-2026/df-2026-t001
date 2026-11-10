"""BigQuery ML の応諾予測（LOGISTIC_REG / BOOSTED_TREE_CLASSIFIER）を、いまの学習と同じ評価データで比べる。

* 特徴量は Python（features.row_features）で作って BigQuery の表に置く。BigQuery ML は同じ 14 列だけを見る（作り方の食い違いを防ぐ）。
* 評価データは欠員 ID のハッシュで取り置いた 1/5（train.split_holdout）。いまのモデルも同じ学習側で作り直して、同じ行を予測する。
* BigQuery ML が勝っても、API は scikit-learn / BigQuery を呼ばずに純 Python で採点するので、重み・木を成果物（JSON）に移す。
  成果物の kind は既存の採点と同じ "logistic" / "xgboost"（いま動いている API がそのまま読める）。由来は model_type（bqml_*）と source に残す。
  移した成果物の予測が ML.PREDICT と一致した（差が VERIFY_TOL 以下）ときだけ、昇格の候補にする。
"""
from __future__ import annotations

import json
import math

from . import scoring, train
from .features import FEATURES, logit

DATASET = "care_ml"
FEATURE_TABLE = "bqml_offer_features"
KINDS = ("bqml_logistic_reg", "bqml_boosted_tree")
VERIFY_TOL = 1e-3
OPTIONS = {
    # 件数が少ないので、正則化を強めに・浅い木に（Python 側の XGBoost と同じ考え方）
    "bqml_logistic_reg": "model_type='LOGISTIC_REG', input_label_cols=['label'], l2_reg=1.0, max_iterations=50, data_split_method='NO_SPLIT'",
    "bqml_boosted_tree": ("model_type='BOOSTED_TREE_CLASSIFIER', input_label_cols=['label'], booster_type='GBTREE', max_tree_depth=2, max_iterations=50, "
                          "learn_rate=0.15, subsample=0.8, colsample_bytree=0.8, min_tree_child_weight=3, l2_reg=5.0, data_split_method='NO_SPLIT', "
                          "early_stop=FALSE"),
}
TABLE_SCHEMA = [("facility_id", "STRING"), ("split", "STRING"), ("row_id", "INTEGER"), ("version", "STRING"), ("label", "INTEGER"),
                *[(f, "FLOAT") for f in FEATURES]]


def model_id(project: str, kind: str, fid: str, sfx: str = "") -> str:
    return f"{project}.{DATASET}.acc_{kind.removeprefix('bqml_')}_{fid.replace('-', '_')}{sfx}"


def feature_rows(fid: str, version: str, tr: list[dict], ev: list[dict]) -> tuple[list[dict], dict, float]:
    """BigQuery に置く行（学習側＋評価側）と、評価側の特徴量を作った統計（成果物に残す）。"""
    Xtr, Xev, stats, base = train.holdout_matrices(tr, ev)
    out = []
    for split, rows, X in (("train", tr, Xtr), ("eval", ev, Xev)):
        for i, (r, x) in enumerate(zip(rows, X)):
            out.append({"facility_id": fid, "split": split, "row_id": i, "version": version, "label": train.label(r),
                        **{f: float(v) for f, v in zip(FEATURES, x)}})
    return out, stats, base


def create_sql(project: str, kind: str, fid: str, sfx: str = "") -> str:
    cols = ", ".join(FEATURES)
    return (f"CREATE OR REPLACE MODEL `{model_id(project, kind, fid, sfx)}` OPTIONS({OPTIONS[kind]}) AS "
            f"SELECT {cols}, label FROM `{project}.{DATASET}.{FEATURE_TABLE}{sfx}` WHERE facility_id = '{fid}' AND split = 'train'")


def predict_sql(project: str, kind: str, fid: str, sfx: str = "") -> str:
    cols = ", ".join(FEATURES)
    return (f"SELECT row_id, (SELECT prob FROM UNNEST(predicted_label_probs) WHERE label = 1) AS p FROM ML.PREDICT(MODEL `{model_id(project, kind, fid, sfx)}`, "
            f"(SELECT row_id, {cols} FROM `{project}.{DATASET}.{FEATURE_TABLE}{sfx}` WHERE facility_id = '{fid}' AND split = 'eval')) ORDER BY row_id")


def weights_sql(project: str, fid: str, sfx: str = "") -> str:
    return f"SELECT processed_input, weight FROM ML.WEIGHTS(MODEL `{model_id(project, 'bqml_logistic_reg', fid, sfx)}`)"


def lr_artifact(base_art: dict, weights: dict[str, float], stats: dict, base: float, version: str, n_train: int) -> dict:
    """ML.WEIGHTS（標準化しない重み）→ 採点用の成果物（logistic と同じ形。標準化は平均0・幅1で素通し）。"""
    missing = [f for f in FEATURES if f not in weights]
    if missing or "__INTERCEPT__" not in weights:
        raise ValueError(f"重みが足りません: {missing}")
    return {**_common(base_art, stats, base, version, n_train), "kind": "logistic", "model_type": "bqml_logistic_reg",
            "coef": [float(weights[f]) for f in FEATURES], "intercept": float(weights["__INTERCEPT__"]),
            "scaler": {"mean": [0.0] * len(FEATURES), "scale": [1.0] * len(FEATURES)}}


def bt_artifact(base_art: dict, booster, names: list[str] | None, stats: dict, base: float, version: str, n_train: int,
                class_names: list[str] | None = None) -> dict:
    """EXPORT MODEL した xgboost のブースター → 採点用の成果物。分岐の特徴量は名前に直す（列の順序に依らない）。

    BigQuery ML の分類は 2 クラスの softprob（木が 1 ラウンドに 2 本、クラスの順は class_names）で書き出される。
    そのときは p(応諾) = sigmoid(応諾のクラスの木の和 − もう一方の木の和)。2 クラスで base_score は打ち消し合う。
    """
    names = names or list(FEATURES)
    learner = json.loads(booster.save_config())["learner"]
    cfg = learner["learner_model_param"]["base_score"]
    bs = float(str(cfg).strip("[]").split(",")[0])
    trees = [json.loads(t) for t in booster.get_dump(dump_format="json")]
    n_class = int(learner["learner_model_param"].get("num_class", "0") or 0)

    def rename(n):
        sp = n.get("split")
        if isinstance(sp, str) and sp[0] == "f" and sp[1:].isdigit():
            n["split"] = names[int(sp[1:])]
        for c in n.get("children", []):
            rename(c)
    for t in trees:
        rename(t)
    unknown = {n for n in _splits(trees) if n not in FEATURES}
    if unknown:
        raise ValueError(f"想定外の特徴量: {sorted(unknown)}")
    if n_class == 2:                   # もう一方のクラスの木は葉の符号を反転して足す（sigmoid(a − b) を、既存の採点の「木の和」の形に）
        pos = (class_names or ["0", "1"]).index("1")
        xg = {"base_margin": 0.0, "trees": trees[pos::2] + [_negate(t) for t in trees[1 - pos::2]]}
    elif n_class > 2:
        raise ValueError(f"想定外のクラス数: {n_class}")
    else:
        xg = {"base_margin": logit(bs), "trees": trees}
    return {**_common(base_art, stats, base, version, n_train), "kind": "xgboost", "model_type": "bqml_boosted_tree", "xgb": xg}


def _negate(node: dict) -> dict:
    n = dict(node)
    if "leaf" in n:
        n["leaf"] = -float(n["leaf"])
    if "children" in n:
        n["children"] = [_negate(c) for c in n["children"]]
    return n


def model_type(art: dict) -> str:
    """成果物の種類（BigQuery ML 由来なら bqml_*）。採点の形（kind）とは別。"""
    return art.get("model_type") or art["kind"]


def _splits(trees):
    out = set()
    stack = list(trees)
    while stack:
        n = stack.pop()
        if "split" in n:
            out.add(n["split"])
        stack += n.get("children", [])
    return out


def _common(base_art: dict, stats: dict, base: float, version: str, n_train: int) -> dict:
    return {"schema": 1, "facility_id": base_art["facility_id"], "version": version, "n_rows": n_train, "base_rate": base,
            "features": list(FEATURES), "staff_stats": stats, "trained_at": base_art.get("trained_at"), "source": "bigquery_ml"}


def verify(art: dict, ev: list[dict], probs: list[float]) -> float:
    """成果物の純 Python 採点と ML.PREDICT の最大の差。"""
    if not ev:
        return 0.0
    return max(abs(scoring.predict(art, r) - p) for r, p in zip(ev, probs))


def gate(m: dict, baseline: dict) -> list[str]:
    """評価データでの基準。train.py と同じ数値（AUC と、基準に対する対数損失の改善）。"""
    reasons = []
    if m["auc"] < train.GATE_MIN_AUC:
        reasons.append(f"AUC {m['auc']:.3f} < {train.GATE_MIN_AUC}")
    gain = (baseline["logloss"] - m["logloss"]) / baseline["logloss"] if baseline["logloss"] else 0.0
    if gain < train.GATE_MIN_LOGLOSS_GAIN:
        reasons.append(f"対数損失の改善 {gain * 100:.1f}% < {train.GATE_MIN_LOGLOSS_GAIN * 100:.0f}%（基準に勝てない）")
    return reasons


def decide(current: dict, cands: dict[str, dict], allow_bqml: bool = True) -> dict:
    """champion と challenger を決める。

    current = {"kind", "gate_passed", "holdout": {...}}            いまの学習（交差検証の gate を通ったか）
    cands   = {kind: {"holdout": {...}, "gate": [理由], "verified": bool}}   BigQuery ML
    * BigQuery ML が champion になるのは、評価データの対数損失がいまのモデルより低く、評価データの基準を満たし、
      成果物への変換が ML.PREDICT と一致したときだけ。それ以外は従来どおり（いまのモデルが gate を通れば champion）。
    * challenger は、champion 以外で基準を満たした採点できる候補のうち、評価データの対数損失が最も低いもの。
    """
    ok_bq = {k: c for k, c in cands.items() if allow_bqml and not c["gate"] and c.get("verified")}
    best_bq = min(ok_bq, key=lambda k: ok_bq[k]["holdout"]["logloss"], default=None)
    cur_ll = current["holdout"]["logloss"] if current.get("holdout") else math.inf
    if best_bq and (not current["gate_passed"] or ok_bq[best_bq]["holdout"]["logloss"] < cur_ll):
        champion = best_bq
    elif current["gate_passed"]:
        champion = "current"
    else:
        champion = None
    pool = {**({"current": cur_ll} if current["gate_passed"] else {}), **{k: c["holdout"]["logloss"] for k, c in ok_bq.items()}}
    pool.pop(champion, None)
    challenger = min(pool, key=pool.get, default=None) if champion else None
    return {"champion": champion, "challenger": challenger}
