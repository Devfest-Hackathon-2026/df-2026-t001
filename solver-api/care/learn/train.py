"""施設ごとに応諾予測を学習する。ロジスティック回帰と XGBoost を同じ交差検証で比べ、良い方を選ぶ。

件数が少ない（施設ごとに数百件）ので、複雑なモデルが勝つとは限らない。選ぶ根拠は交差検証の対数損失と AUC。
基準（件数に依らない基本確率だけ）に勝てなければ、昇格させない（gate）。
評価は out-of-fold（学習に使っていない行への予測）で行い、その予測を BigQuery に書いて較正の監視に使う。
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score
from sklearn.model_selection import RepeatedStratifiedKFold
from sklearn.preprocessing import StandardScaler

from .features import FEATURES, logit, row_features

GATE_MIN_AUC = 0.60
GATE_MIN_LOGLOSS_GAIN = 0.02        # 基準より対数損失が 2% 以上よい
MIN_ROWS = 60


def label(r: dict) -> int:
    return int(r["status"] == "accepted")


def _stats(rows: list[dict]) -> tuple[dict[str, list[float]], float]:
    st: dict[str, list[float]] = {}
    for r in rows:
        s = st.setdefault(r["staff_id"], [0, 0])
        s[0] += 1
        s[1] += label(r)
    return st, sum(label(r) for r in rows) / len(rows)


def _matrix(rows: list[dict], stats, base, *, loo: bool) -> np.ndarray:
    return np.array([row_features(r, stats, base, loo_label=label(r) if loo else None) for r in rows], dtype=float)


def _fit_logistic(X, y):
    sc = StandardScaler().fit(X)
    m = LogisticRegression(C=0.5, max_iter=2000).fit(sc.transform(X), y)
    return ("logistic", sc, m)


def _fit_xgb(X, y):
    import xgboost as xgb

    m = xgb.XGBClassifier(n_estimators=120, max_depth=2, learning_rate=0.08, subsample=0.8, colsample_bytree=0.8,
                          min_child_weight=3, reg_lambda=5.0, eval_metric="logloss", random_state=0, n_jobs=1, verbosity=0)
    m.fit(X, y)
    return ("xgboost", None, m)


def _proba(model, X) -> np.ndarray:
    kind, sc, m = model
    return m.predict_proba(sc.transform(X) if sc is not None else X)[:, 1]


FITTERS = {"logistic": _fit_logistic, "xgboost": _fit_xgb}
POOLED = "pooled_logistic"      # 他の施設の打診も学習に使う（件数の少ない施設が、構造の似た他施設から借りる）


def cross_validate(rows: list[dict], seed: int = 0, splits: int = 5, repeats: int = 2, other_rows: list[dict] | None = None) -> dict:
    """{kind: {"oof": 各行の予測の平均, "auc", "logloss", "brier"}, "baseline": {...}}。検証は必ずこの施設の行だけ。"""
    y = np.array([label(r) for r in rows])
    n = len(rows)
    kinds = [*FITTERS, *([POOLED] if other_rows else [])]
    oof = {k: np.zeros(n) for k in kinds} | {"baseline": np.zeros(n)}
    cnt = np.zeros(n)
    for tr, va in RepeatedStratifiedKFold(n_splits=splits, n_repeats=repeats, random_state=seed).split(np.zeros(n), y):
        tr_rows, va_rows = [rows[i] for i in tr], [rows[i] for i in va]
        stats, base = _stats(tr_rows)
        Xtr, Xva = _matrix(tr_rows, stats, base, loo=True), _matrix(va_rows, stats, base, loo=False)
        for k, fit in FITTERS.items():
            oof[k][va] += _proba(fit(Xtr, y[tr]), Xva)
        if other_rows:
            pool = tr_rows + other_rows
            pst, pbase = _stats(pool)
            m = _fit_logistic(_matrix(pool, pst, pbase, loo=True), np.array([label(r) for r in pool]))
            oof[POOLED][va] += _proba(m, _matrix(va_rows, pst, pbase, loo=False))
        oof["baseline"][va] += base
        cnt[va] += 1
    out = {}
    for k, p in oof.items():
        p = np.clip(p / cnt, 1e-4, 1 - 1e-4)
        out[k] = {"oof": p, "auc": float(roc_auc_score(y, p)) if k != "baseline" else 0.5, "logloss": float(log_loss(y, p)),
                  "brier": float(brier_score_loss(y, p))}
    return out


def _xgb_artifact(model) -> dict:
    booster = model.get_booster()
    cfg = json.loads(booster.save_config())["learner"]["learner_model_param"]["base_score"]
    bs = float(str(cfg).strip("[]").split(",")[0])
    return {"base_margin": logit(bs), "trees": [json.loads(t) for t in booster.get_dump(dump_format="json")]}


def train_facility(fid: str, rows: list[dict], *, version: str | None = None, seed: int = 0, other_rows: list[dict] | None = None) -> dict:
    """成果物（JSON にできる dict）と指標を返す。昇格してよいかは artifact["gate"]。"""
    version = version or datetime.now(timezone.utc).strftime("v%Y%m%d%H%M%S")
    stats, base = _stats(rows)
    y = np.array([label(r) for r in rows])
    art: dict = {"schema": 1, "facility_id": fid, "version": version, "n_rows": len(rows), "base_rate": base, "features": FEATURES,
                 "staff_stats": stats, "trained_at": datetime.now(timezone.utc).isoformat(), "kind": "baseline"}
    if len(rows) < MIN_ROWS or len(set(y)) < 2:
        art["gate"] = {"passed": False, "reasons": [f"件数が少なすぎます（{len(rows)}件 < {MIN_ROWS}件）"]}
        art["metrics"] = {}
        return {"artifact": art, "oof": None}
    cv = cross_validate(rows, seed=seed, other_rows=other_rows)
    base_ll = cv["baseline"]["logloss"]
    cands = [*FITTERS, *([POOLED] if other_rows else [])]
    ranked = sorted(cands, key=lambda k: (cv[k]["logloss"], -cv[k]["auc"]))
    best = ranked[0]
    gain = (base_ll - cv[best]["logloss"]) / base_ll
    reasons = []
    if cv[best]["auc"] < GATE_MIN_AUC:
        reasons.append(f"AUC {cv[best]['auc']:.3f} < {GATE_MIN_AUC}")
    if gain < GATE_MIN_LOGLOSS_GAIN:
        reasons.append(f"対数損失の改善 {gain * 100:.1f}% < {GATE_MIN_LOGLOSS_GAIN * 100:.0f}%（基準に勝てない）")
    if best == POOLED:                      # 他施設の行も使って学習。採点で使う統計は、この施設の従業員の分だけを成果物に残す
        pool = rows + (other_rows or [])
        pst, pbase = _stats(pool)
        model = _fit_logistic(_matrix(pool, pst, pbase, loo=True), np.array([label(r) for r in pool]))
        own = {r["staff_id"] for r in rows}
        art["staff_stats"] = {k: v for k, v in pst.items() if k in own}
        art["base_rate"] = pbase
    else:
        model = FITTERS[best](_matrix(rows, stats, base, loo=True), y)
    art["kind"] = best
    if best in ("logistic", POOLED):
        _, sc, m = model
        art.update(coef=[float(c) for c in m.coef_[0]], intercept=float(m.intercept_[0]),
                   scaler={"mean": [float(v) for v in sc.mean_], "scale": [float(v) for v in sc.scale_]})
    else:
        art["xgb"] = _xgb_artifact(model[2])
    sk = None
    if best in ("logistic", POOLED):                # Model Registry 用（sklearn のコンテナが読める形）
        from sklearn.pipeline import Pipeline

        sk = Pipeline([("scaler", model[1]), ("lr", model[2])])
    art["metrics"] = {"chosen": best, "logloss_gain_vs_baseline": round(gain, 4),
                      **{k: {m: round(cv[k][m], 4) for m in ("auc", "logloss", "brier")} for k in (*cands, "baseline")}}
    art["gate"] = {"passed": not reasons, "reasons": reasons}
    return {"artifact": art, "oof": cv[best]["oof"].tolist(), "oof_kind": best, "sk": sk}
