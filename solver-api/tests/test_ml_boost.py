"""学習サイクルの強化: BigQuery ML との比較（評価データ・変換・選び方）、A/B（腕の割り当て・記録）、Experiments の指標、毎日の実行の定義。GCP は使わない。"""
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.learn import ab, bqml, scoring, steps, train
from care.learn.features import FEATURES
from care.learn.store import MemoryModelStore
from care.service import Svc
from care.store import MemoryRepo

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def offers(synth):
    return [json.loads(line) for line in open(synth / "fact_offers.ndjson", encoding="utf-8")]


def rows_of(offers, fid):
    return [r for r in offers if r["facility_id"] == fid]


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    monkeypatch.delenv("AB_CHALLENGER_SHARE", raising=False)
    yield
    server.set_service(None)


# ---------------------------------------------------------------- 評価データ・BigQuery ML の成果物

def test_holdout_is_deterministic_and_keeps_vacancies_together(offers):
    rows = rows_of(offers, "fac-sakura")
    tr, ev = train.split_holdout(rows)
    assert len(tr) + len(ev) == len(rows) and 0.1 < len(ev) / len(rows) < 0.3
    assert not ({r["vacancy_id"] for r in tr} & {r["vacancy_id"] for r in ev})          # 同じ欠員の打診は同じ側
    assert train.split_holdout(list(reversed(rows)))[1] == list(reversed(ev))           # 並び順に依らない


def test_feature_rows_for_bigquery_match_python_features(offers):
    tr, ev = train.split_holdout(rows_of(offers, "fac-midori"))
    frows, stats, base = bqml.feature_rows("fac-midori", "v1", tr, ev)
    assert len(frows) == len(tr) + len(ev) and {r["split"] for r in frows} == {"train", "eval"}
    assert set(dict(bqml.TABLE_SCHEMA)) == set(frows[0])
    from care.learn.features import row_features

    e0 = next(r for r in frows if r["split"] == "eval" and r["row_id"] == 0)
    assert [e0[f] for f in FEATURES] == pytest.approx(row_features(ev[0], stats, base))   # 評価側は学習側の統計で作る
    sql = bqml.create_sql("p", "bqml_boosted_tree", "fac-midori")
    assert "BOOSTED_TREE_CLASSIFIER" in sql and "split = 'train'" in sql and "acc_boosted_tree_fac_midori" in sql
    assert "split = 'eval'" in bqml.predict_sql("p", "bqml_logistic_reg", "fac-midori")


def test_bqml_logistic_weights_become_a_scorable_artifact(offers):
    """ML.WEIGHTS（標準化しない重み）を移した成果物の純 Python 採点が、同じ重みの予測と一致する。"""
    from sklearn.linear_model import LogisticRegression

    tr, ev = train.split_holdout(rows_of(offers, "fac-sakura"))
    Xtr, Xev, stats, base = train.holdout_matrices(tr, ev)
    m = LogisticRegression(C=1.0, max_iter=3000).fit(Xtr, [train.label(r) for r in tr])
    w = {f: float(c) for f, c in zip(FEATURES, m.coef_[0])} | {"__INTERCEPT__": float(m.intercept_[0])}
    base_art = {"facility_id": "fac-sakura", "trained_at": "2026-11-10T00:00:00Z"}
    art = scoring.load(json.dumps(bqml.lr_artifact(base_art, w, stats, base, "v1", len(tr))))
    probs = m.predict_proba(Xev)[:, 1].tolist()
    assert bqml.verify(art, ev, probs) < 1e-9
    assert art["kind"] == "logistic" and bqml.model_type(art) == "bqml_logistic_reg"
    assert scoring.explain(art, ev[0], 2)                                               # 要因の説明も出る
    with pytest.raises(ValueError):
        bqml.lr_artifact(base_art, {"log_lead": 1.0}, stats, base, "v1", 1)              # 重みが欠けていたら使わない


def test_bqml_boosted_tree_export_becomes_a_scorable_artifact(offers):
    """EXPORT MODEL の model.bst（特徴量名なし・f0..）を、名前つきの木に直して採点できる。"""
    import xgboost as xgb

    tr, ev = train.split_holdout(rows_of(offers, "fac-sakura"))
    Xtr, Xev, stats, base = train.holdout_matrices(tr, ev)
    order = list(reversed(FEATURES))                                                    # 列の順序が違っても名前で合わせる
    idx = [FEATURES.index(f) for f in order]
    booster = xgb.train({"max_depth": 2, "eta": 0.1, "objective": "binary:logistic"}, xgb.DMatrix(Xtr[:, idx], label=[train.label(r) for r in tr]), 30)
    art = bqml.bt_artifact({"facility_id": "fac-sakura"}, booster, order, stats, base, "v1", len(tr))
    probs = booster.predict(xgb.DMatrix(Xev[:, idx])).tolist()
    assert bqml.verify(scoring.load(json.dumps(art)), ev, probs) < 1e-5


def test_bqml_two_class_softprob_export_is_scored_correctly(offers):
    """BigQuery ML の分類は 2 クラスの softprob で書き出される（class_names = ['1', '0'] の順）。"""
    import xgboost as xgb

    tr, ev = train.split_holdout(rows_of(offers, "fac-sakura"))
    Xtr, Xev, stats, base = train.holdout_matrices(tr, ev)
    y = [0 if train.label(r) == 1 else 1 for r in tr]                                  # クラス 0 = 応諾（'1'）
    booster = xgb.train({"max_depth": 2, "eta": 0.2, "objective": "multi:softprob", "num_class": 2}, xgb.DMatrix(Xtr, label=y), 20)
    art = bqml.bt_artifact({"facility_id": "fac-sakura"}, booster, list(FEATURES), stats, base, "v1", len(tr), class_names=["1", "0"])
    probs = booster.predict(xgb.DMatrix(Xev))[:, 0].tolist()
    assert len(art["xgb"]["trees"]) == 40 and art["kind"] == "xgboost" and art["model_type"] == "bqml_boosted_tree"   # いまの API の採点がそのまま読める形
    assert bqml.verify(scoring.load(json.dumps(art)), ev, probs) < 1e-5


def test_decide_prefers_bqml_only_when_it_wins_on_the_same_eval_and_is_verified():
    cur = {"kind": "logistic", "gate_passed": True, "holdout": {"logloss": 0.60, "auc": 0.7}}
    win = {"holdout": {"logloss": 0.55, "auc": 0.75}, "gate": [], "verified": True}
    lose = {"holdout": {"logloss": 0.65, "auc": 0.65}, "gate": [], "verified": True}
    assert bqml.decide(cur, {"bqml_logistic_reg": win, "bqml_boosted_tree": lose}) == {"champion": "bqml_logistic_reg", "challenger": "current"}
    assert bqml.decide(cur, {"bqml_boosted_tree": lose}) == {"champion": "current", "challenger": "bqml_boosted_tree"}
    assert bqml.decide(cur, {"bqml_logistic_reg": {**win, "verified": False}}) == {"champion": "current", "challenger": None}   # 変換が一致しない
    assert bqml.decide(cur, {"bqml_logistic_reg": {**win, "gate": ["AUC"]}}) == {"champion": "current", "challenger": None}     # 基準を満たさない
    assert bqml.decide(cur, {"bqml_logistic_reg": win}, allow_bqml=False) == {"champion": "current", "challenger": None}
    failed = {**cur, "gate_passed": False}
    assert bqml.decide(failed, {}) == {"champion": None, "challenger": None}                                                  # 従来どおり昇格しない
    assert bqml.decide(failed, {"bqml_boosted_tree": lose})["champion"] == "bqml_boosted_tree"


def test_holdout_predict_and_gate_use_same_thresholds(offers):
    tr, ev = train.split_holdout(rows_of(offers, "fac-sakura"))
    y = [train.label(r) for r in ev]
    m = train.score_probs(y, train.holdout_predict("logistic", tr, ev))
    b = train.score_probs(y, np.full(len(ev), sum(train.label(r) for r in tr) / len(tr)))
    assert m["n"] == len(ev) and m["logloss"] < b["logloss"]
    assert bqml.gate(m, b) == []
    assert bqml.gate(b, b)                                                              # 基準そのものは通らない


def test_model_runs_schema_records_comparison():
    s = dict(steps.RUNS_SCHEMA)
    for k in ("champion_source", "challenger_kind", "eval_rows", "eval_logloss", "bqml_lr_eval_logloss", "bqml_bt_eval_logloss", "compare_json"):
        assert k in s
    assert list(s)[:12] == ["facility_id", "version", "rows", "live_rows", "kind", "auc", "logloss", "baseline_logloss", "gate_passed", "promoted",
                            "run_at", "gate_reasons"]                                   # 既存の列は変えない


def test_experiment_metrics_are_numbers_only(offers):
    out = train.train_facility("fac-sakura", rows_of(offers, "fac-sakura"), version="t1")
    art = out["artifact"]
    cmp = {"eval_rows": 80, "holdout": {"current": {"auc": 0.7, "logloss": 0.6}, "baseline": {"auc": 0.5, "logloss": 0.69}},
           "bqml": {"bqml_logistic_reg": {"holdout": {"auc": 0.71, "logloss": 0.59}}}, "decision": {"champion": "current", "challenger": "bqml_logistic_reg"}}
    params, met = steps.experiment_metrics(art, art, cmp, True)
    assert all(isinstance(v, float) for v in met.values())
    assert met["rows"] == len(rows_of(offers, "fac-sakura")) and met["eval_bqml_logistic_reg_logloss"] == 0.59 and "cv_logistic_auc" in met
    assert params["challenger"] == "bqml_logistic_reg" and not any("staff" in k for k in (*params, *met))


def test_registry_artifact_paths():
    cur = {"kind": "xgboost"}
    assert steps._registry_artifact("gs://b", "r1", "f", cur, None) == ("gs://b/runs/r1/registry/f/model.bst", "xgboost")
    assert steps._registry_artifact("gs://b", "r1", "f", {"kind": "baseline"}, None) == (None, "")
    bq = {"kind": "logistic", "model_type": "bqml_logistic_reg", "source": "bigquery_ml"}
    cmp = {"bqml": {"bqml_logistic_reg": {"export_uri": "gs://b/x/model"}}}
    assert steps._registry_artifact("gs://b", "r1", "f", bq, cmp) == ("gs://b/x/model/saved_model.pb", "tensorflow")
    assert steps.suffix(True) == "" and steps.suffix(False) == "_preview"
    assert bqml.model_id("p", "bqml_boosted_tree", "fac-a", "_preview").endswith("acc_boosted_tree_fac_a_preview")
    assert "bqml_offer_features_preview" in bqml.create_sql("p", "bqml_logistic_reg", "fac-a", "_preview")


# ---------------------------------------------------------------- A/B

def test_ab_is_off_by_default(monkeypatch):
    ms = MemoryModelStore({"f": {"kind": "logistic", "version": "c"}}, challengers={"f": {"kind": "xgboost", "version": "x"}})
    assert ab.share() == 0 and not ab.enabled()
    art, info = ab.choose(ms, "f", "VAC-1")
    assert art["version"] == "c" and info is None
    monkeypatch.setenv("AB_CHALLENGER_SHARE", "abc")
    assert ab.share() == 0
    monkeypatch.setenv("AB_CHALLENGER_SHARE", "5")
    assert ab.share() == 1.0


def test_ab_arms_are_deterministic_and_follow_the_share(monkeypatch):
    monkeypatch.setenv("AB_CHALLENGER_SHARE", "0.3")
    vids = [f"VAC-202611{d:02d}-SKR{i:02d}" for d in range(1, 31) for i in range(1, 11)]
    arms = [ab.arm(v) for v in vids]
    assert arms == [ab.arm(v) for v in vids]                                            # 何度並べ直しても同じ
    assert 0.2 < arms.count("challenger") / len(arms) < 0.4
    ms = MemoryModelStore({"f": {"kind": "logistic", "version": "c"}}, challengers={"f": {"kind": "xgboost", "version": "x"}})
    v = next(v for v in vids if ab.arm(v) == "challenger")
    art, info = ab.choose(ms, "f", v)
    assert art["version"] == "x" and info["arm"] == "challenger" and info["model_version"] == "x"
    art, info = ab.choose(MemoryModelStore({"f": {"kind": "logistic", "version": "c"}}), "f", v)        # challenger が無ければ champion
    assert art["version"] == "c" and info["arm"] == "champion" and info["assigned"] == "challenger"


def _client(synth, offers, challengers=True):
    guard.reset()
    a = scoring.load(json.dumps(train.train_facility("fac-sakura", rows_of(offers, "fac-sakura"), version="champ")["artifact"]))
    b = scoring.load(json.dumps({**train.train_facility("fac-sakura", rows_of(offers, "fac-sakura")[:300], version="chall")["artifact"]}))
    svc = Svc(MemoryRepo.from_synth(synth), models=MemoryModelStore({"fac-sakura": a}, challengers={"fac-sakura": b} if challengers else {}))
    server.set_service(svc)
    return TestClient(server.app), svc


def _offer(client, svc):
    cur = client.get("/api/v1/facilities/fac-sakura/rosters/2026-11").json()["current"]
    sid = next(s for s, row in cur.items() if row[11] == "日勤")
    j = client.post("/api/v1/facilities/fac-sakura/vacancies", json={"date": "2026-11-12", "shift": "日勤", "absent_staff_id": sid}).json()
    vid, c = j["vacancy"]["vacancy_id"], j["candidates"]
    client.post(f"/api/v1/facilities/fac-sakura/vacancies/{vid}/offers", json={"staff_id": c[0]["staff_id"]})
    ev = [e for e in svc.events.local if e["event_type"] == "offer_sent"][-1]
    return vid, c, json.loads(ev["payload"])


def test_offer_event_has_no_ab_when_disabled(synth, offers):
    client, svc = _client(synth, offers)
    _, c, payload = _offer(client, svc)
    assert "ab" not in payload and all("model_arm" not in x for x in c)                 # 従来どおり


def test_offer_event_records_the_arm_used_for_ranking(synth, offers, monkeypatch):
    monkeypatch.setenv("AB_CHALLENGER_SHARE", "1")                                      # すべて challenger
    client, svc = _client(synth, offers)
    vid, c, payload = _offer(client, svc)
    assert payload["ab"]["arm"] == "challenger" and payload["ab"]["model_version"] == "chall"
    assert all(x["model_arm"] == "challenger" for x in c)
    assert payload["features"]                                                          # 学習に使う特徴量はそのまま


def test_inline_rank_returns_arm_only_when_enabled(synth, offers, monkeypatch):
    from tests.test_inline_rank import body

    monkeypatch.delenv("MODEL_ROOT", raising=False)
    monkeypatch.delenv("RANK_PRIOR_FACILITY", raising=False)
    client, _ = _client(synth, offers)
    j = client.post("/api/v1/rank-candidates", json=body(vacancy_id="VAC-20261120-X01")).json()
    assert "ab" not in j and j["model"] == "champion"
    monkeypatch.setenv("AB_CHALLENGER_SHARE", "1")
    j = client.post("/api/v1/rank-candidates", json=body(vacancy_id="VAC-20261120-X01")).json()
    assert j["ab"]["arm"] == "challenger" and j["model"] == "champion" and j["candidates"]
    assert client.post("/api/v1/rank-candidates", json=body(vacancy_id="bad id!")).status_code == 422


# ---------------------------------------------------------------- 毎日の実行（Cloud Scheduler）

def test_compiled_pipeline_for_scheduler_has_compare_step():
    p = ROOT / "infra" / "pipelines" / "care-learn.json"
    spec = json.loads(p.read_text(encoding="utf-8"))
    tasks = spec["root"]["dag"]["tasks"]
    assert {"extract-op", "compare-op", "promote-op", "detect-op"} <= set(tasks)
    assert "compare-op" in tasks["promote-op"]["dependentTasks"]
    tf = (ROOT / "infra" / "ml_boost.tf").read_text(encoding="utf-8")
    assert "pipelines/care-learn.json" in tf and "google_cloud_scheduler_job" in tf and "ab_offer_outcomes" in tf


def test_preview_promote_writes_only_under_root_and_preview_tables(monkeypatch):
    """publish=False: Model Registry には登録せず、BigQuery は *_preview の表だけ（本番の model_runs に書かない）。"""
    import sys
    import types as t

    art = {"gate": {"passed": True, "reasons": []}, "kind": "logistic", "trained_at": "x", "n_rows": 10, "metrics": {}}
    store = {"runs/r1/models/fac-a.json": json.dumps(art)}
    monkeypatch.setattr(steps, "read_text", lambda root, p: store.get(f"{root}|{p}") or store.get(p) if root == "gs://b/preview" else None)
    writes = []
    monkeypatch.setattr(steps, "write_text", lambda root, p, txt: writes.append((root, p)))
    monkeypatch.setattr(steps, "register", lambda *a, **k: pytest.fail("プレビューで Registry に登録した"))
    monkeypatch.setattr(steps, "log_experiment", lambda *a, **k: None)
    tables = []
    fake_bq = t.SimpleNamespace(Client=lambda project: t.SimpleNamespace(
        load_table_from_json=lambda rows, table, **k: tables.append(table) or t.SimpleNamespace(result=lambda: None)),
        LoadJobConfig=lambda **k: None, SchemaField=lambda *a: None)
    monkeypatch.setitem(sys.modules, "google.cloud.bigquery", fake_bq)
    import google.cloud
    monkeypatch.setattr(google.cloud, "bigquery", fake_bq, raising=False)
    steps.promote("p", "gs://b/preview", "r1", ["fac-a"], publish=False)
    assert {r for r, _ in writes} == {"gs://b/preview"} and ("gs://b/preview", "models/fac-a/champion.json") in writes
    assert tables == ["p.care_ml.model_runs_preview"]
