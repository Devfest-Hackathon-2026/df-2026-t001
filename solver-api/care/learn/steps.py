"""Vertex AI Pipelines の各ステップの中身。トレーナーイメージの中で動く（GCS / BigQuery / Vertex AI にアクセスする）。

  extract   BigQuery → 学習データ（打診の履歴＋実運用の打診の結果）を GCS に
  train     施設ごとに学習（ロジスティック / XGBoost / プール学習を交差検証で比べる）→ 成果物を GCS に
  compare   BigQuery ML（LOGISTIC_REG / BOOSTED_TREE_CLASSIFIER）を作り、いまのモデルと同じ評価データで比べる → champion / challenger を決める
            （学習データは extract の offers.json。live_sources・上限の条件は extract で効いたものがそのまま使われる）
  promote   champion を置き、challenger も置く（A/B 用）。Model Registry に登録、Vertex AI Experiments に指標、履歴と out-of-fold 予測を BigQuery に
  publish=False（プレビュー）のとき: GCS はすべて root の下だけ、BigQuery は *_preview の表・モデル、Model Registry には登録しない
  detect    手修正のくり返しを検出 → ルール候補を GCS と BigQuery に

成果物は gs://<root>/models/<施設>/champion.json（API が読む）。履歴は history.json、反復検出は learned/<施設>.json。
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone

from .bqml import model_type as bqml_model_type

DATASET = "care_ml"
log = logging.getLogger("care.learn")
# 実運用のイベント（events_raw の synthetic でないもの）は、認証の無い公開デモ API からも書ける（データの汚染）。
# 既定では学習・検出に使わない。使うときは live_sources で出どころ（イベントの data.source）を明示し、1人・1つの IP あたりの件数に上限を付ける。
#   data.source  … 'public_api'（公開デモ API。既定）/ 'trusted'（認証つきの運用）など。値が無いイベントは 'public_api' とみなす
#   data.ip_hash … 送信元 IP のハッシュ（任意）。無いイベントはまとめて 'unknown' として1つの IP と数える（安全側）
DEFAULT_CAP_PER_STAFF = 20
DEFAULT_CAP_PER_IP = 50
_EV = """
  SELECT data, publish_time, COALESCE(JSON_VALUE(data,'$.source'), 'public_api') AS source,
         COALESCE(JSON_VALUE(data,'$.ip_hash'), 'unknown') AS ip_hash
  FROM `{project}.care_analytics.events_raw`
  WHERE JSON_VALUE(data,'$.synthetic') IS NULL
"""
REAL_OFFERS_SQL = """
WITH ev AS (""" + _EV + """),
sent AS (
  SELECT JSON_VALUE(data,'$.facility_id') AS facility_id, JSON_VALUE(data,'$.vacancy_id') AS vacancy_id,
         PARSE_JSON(JSON_VALUE(data,'$.payload')) AS p, publish_time, ip_hash
  FROM ev WHERE source IN ({sources}) AND JSON_VALUE(data,'$.event_type') = 'offer_sent'
),
resp AS (
  SELECT JSON_VALUE(data,'$.vacancy_id') AS vacancy_id, JSON_VALUE(JSON_VALUE(data,'$.payload'),'$.staff_id') AS staff_id,
         JSON_VALUE(JSON_VALUE(data,'$.payload'),'$.status') AS status
  FROM ev WHERE source IN ({sources}) AND JSON_VALUE(data,'$.event_type') = 'offer_responded'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY vacancy_id, staff_id ORDER BY publish_time DESC) = 1
),
joined AS (
SELECT s.facility_id, s.vacancy_id, JSON_VALUE(s.p,'$.staff_id') AS staff_id, r.status,
       CAST(JSON_VALUE(s.p,'$.features.lead_hours') AS FLOAT64) AS lead_hours,
       CAST(JSON_VALUE(s.p,'$.features.weekday') AS INT64) AS weekday, JSON_VALUE(s.p,'$.features.shift') AS shift,
       JSON_VALUE(s.p,'$.features.same_unit') = 'true' AS same_unit, JSON_VALUE(s.p,'$.features.skill_match') = 'true' AS skill_match,
       CAST(JSON_VALUE(s.p,'$.features.consec_before') AS INT64) AS consec_before,
       CAST(JSON_VALUE(s.p,'$.features.month_hours_before') AS FLOAT64) AS month_hours_before,
       CAST(JSON_VALUE(s.p,'$.features.nights_last30') AS INT64) AS nights_last30,
       CAST(JSON_VALUE(s.p,'$.features.offers_last14') AS INT64) AS offers_last14,
       CAST(JSON_VALUE(s.p,'$.features.tenure_years') AS INT64) AS tenure_years, JSON_VALUE(s.p,'$.features.employment') AS employment,
       ROW_NUMBER() OVER (PARTITION BY s.facility_id, JSON_VALUE(s.p,'$.staff_id') ORDER BY s.publish_time DESC) AS n_staff,
       ROW_NUMBER() OVER (PARTITION BY s.ip_hash ORDER BY s.publish_time DESC) AS n_ip
FROM sent s JOIN resp r ON r.vacancy_id = s.vacancy_id AND r.staff_id = JSON_VALUE(s.p,'$.staff_id')
WHERE JSON_VALUE(s.p,'$.features.lead_hours') IS NOT NULL AND r.status IN ('accepted','declined','expired')
)
SELECT * EXCEPT(n_staff, n_ip) FROM joined WHERE n_staff <= {cap_staff} AND n_ip <= {cap_ip}
"""


def parse_sources(live_sources: str | list | None) -> list[str]:
    """'trusted,public_api' → ['trusted', 'public_api']。空なら実運用のイベントは使わない。SQL に入れるので英小文字と _ だけ。"""
    import re

    xs = live_sources if isinstance(live_sources, list) else (live_sources or "").split(",")
    out = [x.strip() for x in xs if x and x.strip()]
    for x in out:
        if not re.fullmatch(r"[a-z_]{1,32}", x):
            raise ValueError(f"live_sources が不正です: {x!r}")
    return out


def _sql_list(xs: list[str]) -> str:
    return ", ".join(f"'{x}'" for x in xs)


SYNTH_OFFERS_SQL = """
SELECT facility_id, vacancy_id, staff_id, status, lead_hours, weekday, shift, same_unit, skill_match, consec_before,
       month_hours_before, nights_last30, offers_last14, tenure_years, employment
FROM `{project}.care_ml.fact_offers` WHERE status IN ('accepted','declined','expired')
"""


def _bucket(root: str):
    from google.cloud import storage

    assert root.startswith("gs://")
    name, _, prefix = root[5:].partition("/")
    return storage.Client().bucket(name), prefix.strip("/")


def read_text(root: str, path: str) -> str | None:
    b, p = _bucket(root)
    blob = b.blob(_key(p, path))
    return blob.download_as_text() if blob.exists() else None


def _key(prefix: str, path: str) -> str:
    return f"{prefix}/{path}" if prefix else path            # root にフォルダが無いときに先頭が「/」にならないようにする


def write_file(root: str, path: str, local: str) -> str:
    b, p = _bucket(root)
    b.blob(_key(p, path)).upload_from_filename(local)
    return f"gs://{b.name}/{_key(p, path)}"


def write_text(root: str, path: str, text: str) -> str:
    b, p = _bucket(root)
    key = _key(p, path)
    b.blob(key).upload_from_string(text, content_type="application/json")
    return f"gs://{b.name}/{key}"


def _rows(project: str, sql: str) -> list[dict]:
    from google.cloud import bigquery

    return [dict(r) for r in bigquery.Client(project=project).query(sql.format(project=project)).result()]


def rid(run_id: str) -> str:
    """版名。パイプラインのジョブ ID は数字だけなので、接頭辞を付けて文字列として扱う（BigQuery が整数と誤判定しない）。"""
    return run_id if not run_id.isdigit() else f"run-{run_id}"


RUNS_SCHEMA = [("facility_id", "STRING"), ("version", "STRING"), ("rows", "INTEGER"), ("live_rows", "INTEGER"), ("kind", "STRING"),
               ("auc", "FLOAT"), ("logloss", "FLOAT"), ("baseline_logloss", "FLOAT"), ("gate_passed", "BOOLEAN"), ("promoted", "BOOLEAN"),
               ("run_at", "TIMESTAMP"), ("gate_reasons", "STRING"),
               # BigQuery ML との比較（compare）。列は後から足した（既存の行は NULL）
               ("champion_source", "STRING"), ("challenger_kind", "STRING"), ("eval_rows", "INTEGER"), ("eval_logloss", "FLOAT"),
               ("eval_auc", "FLOAT"), ("bqml_lr_eval_logloss", "FLOAT"), ("bqml_bt_eval_logloss", "FLOAT"), ("compare_json", "STRING")]
SCORES_SCHEMA = [("facility_id", "STRING"), ("vacancy_id", "STRING"), ("staff_id", "STRING"), ("model_version", "STRING"), ("model_kind", "STRING"),
                 ("p_accept", "FLOAT"), ("label", "INTEGER"), ("scored_at", "TIMESTAMP")]
CANDIDATES_SCHEMA = [("facility_id", "STRING"), ("key", "STRING"), ("kind", "STRING"), ("staff_id", "STRING"), ("evidence", "STRING"),
                     ("repeated", "INTEGER"), ("threshold", "INTEGER"), ("detected_at", "TIMESTAMP")]


def _schema(cols):
    from google.cloud import bigquery

    return [bigquery.SchemaField(n, t) for n, t in cols]


# ------------------------------------------------------------------ extract
def real_offers_sql(sources: list[str], cap_per_staff: int = DEFAULT_CAP_PER_STAFF, cap_per_ip: int = DEFAULT_CAP_PER_IP) -> str | None:
    if not sources:
        return None
    return REAL_OFFERS_SQL.replace("{sources}", _sql_list(sources)).replace("{cap_staff}", str(int(cap_per_staff))).replace(
        "{cap_ip}", str(int(cap_per_ip)))


def extract(project: str, root: str, run_id: str, live_sources: str = "", cap_per_staff: int = DEFAULT_CAP_PER_STAFF,
            cap_per_ip: int = DEFAULT_CAP_PER_IP) -> dict:
    """既定（live_sources=""）は合成データだけで学習する。公開 API のイベントは、明示したときだけ上限つきで混ぜる。"""
    run_id = rid(run_id)
    synth = _rows(project, SYNTH_OFFERS_SQL)
    sql = real_offers_sql(parse_sources(live_sources), cap_per_staff, cap_per_ip)
    real = _rows(project, sql) if sql else []
    for r in synth:
        r["source"] = "synthetic"
    for r in real:
        r["source"] = "live"
    rows = synth + real
    uri = write_text(root, f"runs/{run_id}/offers.json", json.dumps(rows, ensure_ascii=False, default=str))
    return {"uri": uri, "synthetic": len(synth), "live": len(real), "live_sources": parse_sources(live_sources)}


# ------------------------------------------------------------------ train
REGISTRY_FILES = {"sklearn": "model.joblib", "xgboost": "model.bst"}
SERVING_IMAGES = {"sklearn": os.getenv("REGISTRY_SKLEARN_IMAGE", "us-docker.pkg.dev/vertex-ai/prediction/sklearn-cpu.1-5:latest"),
                  "xgboost": os.getenv("REGISTRY_XGBOOST_IMAGE", "us-docker.pkg.dev/vertex-ai/prediction/xgboost-cpu.2-1:latest")}


def save_registry_model(fmt: str, obj) -> tuple[str, str]:
    """(一時ファイルのパス, Model Registry のファイル名)。sklearn は joblib、XGBoost は booster を model.bst に。"""
    import tempfile

    name = REGISTRY_FILES[fmt]
    fd, path = tempfile.mkstemp(suffix="-" + name)
    os.close(fd)
    if fmt == "sklearn":
        import joblib

        joblib.dump(obj, path)
    else:
        obj.get_booster().save_model(path) if hasattr(obj, "get_booster") else obj.save_model(path)
    return path, name


def train(project: str, root: str, run_id: str, facility_id: str) -> dict:
    from .train import train_facility

    run_id = rid(run_id)

    rows = json.loads(read_text(root, f"runs/{run_id}/offers.json"))
    own = [r for r in rows if r["facility_id"] == facility_id]
    other = [r for r in rows if r["facility_id"] != facility_id]
    out = train_facility(facility_id, own, version=run_id, other_rows=other)
    art = out["artifact"]
    art["data"] = {"rows": len(own), "live_rows": sum(1 for r in own if r.get("source") == "live"), "pooled_extra_rows": len(other)}
    uri = write_text(root, f"runs/{run_id}/models/{facility_id}.json", json.dumps(art, ensure_ascii=False))
    if out.get("registry_model") is not None:      # Model Registry 用: 勝ったモデルの形式で保存し、API が読む JSON を同じディレクトリに
        fmt, obj = out["registry_model"]
        local, name = save_registry_model(fmt, obj)
        try:
            write_file(root, f"runs/{run_id}/registry/{facility_id}/{name}", local)
        finally:
            os.unlink(local)
        write_text(root, f"runs/{run_id}/registry/{facility_id}/champion.json", json.dumps(art, ensure_ascii=False))
    if out.get("oof"):
        oof = [{"facility_id": facility_id, "vacancy_id": r["vacancy_id"], "staff_id": r["staff_id"], "model_version": run_id,
                "model_kind": out["oof_kind"], "p_accept": round(p, 5), "label": int(r["status"] == "accepted"), "scored_at": datetime.now(timezone.utc).isoformat()}
               for r, p in zip(own, out["oof"])]
        write_text(root, f"runs/{run_id}/oof/{facility_id}.json", json.dumps(oof))
    return {"facility_id": facility_id, "uri": uri, "kind": art["kind"], "gate": art["gate"], "metrics": art.get("metrics", {}), "rows": len(own)}


# ------------------------------------------------------------------ compare（BigQuery ML）
def compare(project: str, root: str, run_id: str, facility_ids: list[str], allow_bqml: bool = True, publish: bool = True) -> list[dict]:
    """BigQuery ML の 2 種を作り、いまのモデル（train の kind を学習側で作り直す）と同じ評価データで比べる。

    結果は runs/<版>/compare/<施設>.json。BigQuery ML が champion / challenger になるときは、その成果物を runs/<版>/bqml/<施設>/ に置く。
    BigQuery ML が失敗しても（権限・クォータなど）、いまのモデルの昇格は従来どおり進む。
    """
    import numpy as np
    from google.cloud import bigquery

    from . import bqml
    from .train import MIN_ROWS, holdout_predict, label, score_probs, split_holdout

    run_id = rid(run_id)
    sfx = suffix(publish)
    bq = bigquery.Client(project=project)
    rows = json.loads(read_text(root, f"runs/{run_id}/offers.json"))      # extract の出力（live_sources・上限の条件はここで効いている）
    plan, table_rows = {}, []
    for fid in facility_ids:
        own = [r for r in rows if r["facility_id"] == fid]
        tr, ev = split_holdout(own)
        if len(tr) < MIN_ROWS or len(ev) < 20 or len({label(r) for r in ev}) < 2:
            plan[fid] = None
            continue
        frows, stats, base = bqml.feature_rows(fid, run_id, tr, ev)
        table_rows += frows
        plan[fid] = (own, tr, ev, stats, base)
    if table_rows:
        bq.load_table_from_json(table_rows, f"{project}.{DATASET}.{bqml.FEATURE_TABLE}{sfx}", job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_TRUNCATE", schema=_schema(bqml.TABLE_SCHEMA))).result()
    jobs = {}                                 # BigQuery ML の学習は数分かかるので、施設・種類ごとの CREATE MODEL を先に全部投げて並行させる
    for fid in facility_ids:
        if plan.get(fid) is not None:
            for kind in bqml.KINDS:
                try:
                    jobs[(fid, kind)] = bq.query(bqml.create_sql(project, kind, fid, sfx))
                except Exception as e:  # noqa: BLE001
                    jobs[(fid, kind)] = e
    out = []
    for fid in facility_ids:
        art = json.loads(read_text(root, f"runs/{run_id}/models/{fid}.json"))
        res = {"facility_id": fid, "version": run_id, "current_kind": art["kind"], "current_gate_passed": art["gate"]["passed"], "holdout": {}, "bqml": {},
               "errors": {}, "decision": {"champion": "current" if art["gate"]["passed"] else None, "challenger": None}}
        if plan.get(fid) is None:
            res["skipped"] = "評価データが足りません"
            write_text(root, f"runs/{run_id}/compare/{fid}.json", json.dumps(res, ensure_ascii=False))
            out.append(res)
            continue
        own, tr, ev, stats, base = plan[fid]
        other = [r for r in rows if r["facility_id"] != fid]
        y = [label(r) for r in ev]
        res.update(train_rows=len(tr), eval_rows=len(ev))
        res["holdout"]["baseline"] = score_probs(y, np.full(len(ev), sum(label(r) for r in tr) / len(tr)))
        cur_kind = art["kind"] if art["kind"] != "baseline" else "logistic"
        res["holdout"]["current"] = {**score_probs(y, holdout_predict(cur_kind, tr, ev, other)), "kind": cur_kind}
        for kind in bqml.KINDS:
            try:
                job = jobs[(fid, kind)]
                if isinstance(job, Exception):
                    raise job
                _wait(job)
                probs = [r.p for r in bq.query(bqml.predict_sql(project, kind, fid, sfx)).result()]
                m = score_probs(y, probs)
                c = {"holdout": m, "gate": bqml.gate(m, res["holdout"]["baseline"]), "model": bqml.model_id(project, kind, fid, sfx), "verified": False}
                export = f"{root}/runs/{run_id}/bqml/{fid}/{kind}"
                bq.query(f"EXPORT MODEL `{c['model']}` OPTIONS(URI='{export}/model')").result()      # Model Registry 用にも使う
                c["export_uri"] = f"{export}/model"
                if kind == "bqml_logistic_reg":
                    w = {r.processed_input: r.weight for r in bq.query(bqml.weights_sql(project, fid, sfx)).result()}
                    ba = bqml.lr_artifact(art, w, stats, base, run_id, len(tr))
                else:
                    ba = _bt_from_export(root, f"runs/{run_id}/bqml/{fid}/{kind}/model", art, stats, base, run_id, len(tr))
                c["verify_max_diff"] = round(bqml.verify(ba, ev, probs), 6)
                c["verified"] = c["verify_max_diff"] <= bqml.VERIFY_TOL
                ba["metrics"] = {"chosen": kind, kind: m, "baseline": res["holdout"]["baseline"], "current_on_eval": res["holdout"]["current"],
                                 "logloss_gain_vs_baseline": round((res["holdout"]["baseline"]["logloss"] - m["logloss"]) / res["holdout"]["baseline"]["logloss"], 4),
                                 "evaluated_on": f"評価データ {len(ev)} 件（欠員 ID のハッシュで取り置き）"}
                ba["gate"] = {"passed": not c["gate"] and c["verified"], "reasons": c["gate"] + ([] if c["verified"] else ["採点の変換が ML.PREDICT と一致しない"])}
                write_text(root, f"runs/{run_id}/bqml/{fid}/{kind}.json", json.dumps(ba, ensure_ascii=False))
                res["bqml"][kind] = c
            except Exception as e:  # noqa: BLE001  BigQuery ML が使えなくても、いまのモデルの昇格は止めない
                res["errors"][kind] = f"{type(e).__name__}: {str(e)[:300]}"
                print(f"[compare] {fid} {kind} failed: {e}")
        res["decision"] = bqml.decide({"kind": cur_kind, "gate_passed": art["gate"]["passed"], "holdout": res["holdout"]["current"]},
                                      res["bqml"], allow_bqml=allow_bqml)
        write_text(root, f"runs/{run_id}/compare/{fid}.json", json.dumps(res, ensure_ascii=False))
        out.append(res)
    return out


def _wait(job, limit: float = 1800.0) -> None:
    """BigQuery ML の学習は長い。状態を自分で問い合わせて待つ（クライアントの長い待ちに頼らない）。"""
    import time

    t0 = time.time()
    while not job.done(reload=True):
        if time.time() - t0 > limit:
            raise TimeoutError(f"{job.job_id} が {limit:.0f} 秒で終わりませんでした")
        time.sleep(10)
    job.result()


def _bt_from_export(root: str, path: str, art: dict, stats: dict, base: float, run_id: str, n_train: int) -> dict:
    import tempfile

    import xgboost as xgb

    from . import bqml

    b, p = _bucket(root)
    with tempfile.TemporaryDirectory() as d:
        b.blob(_key(p, f"{path}/model.bst")).download_to_filename(f"{d}/model.bst")
        booster = xgb.Booster()
        booster.load_model(f"{d}/model.bst")
    names, classes = None, None
    meta = read_text(root, f"{path}/assets/model_metadata.json")
    if meta:
        md = json.loads(meta)
        names, classes = md.get("feature_names") or None, md.get("class_names") or None
    return bqml.bt_artifact(art, booster, names, stats, base, run_id, n_train, class_names=classes)


# ------------------------------------------------------------------ promote
CONTAINERS = {**SERVING_IMAGES,          # BigQuery ML のロジスティック回帰は TensorFlow の SavedModel で書き出される
              "tensorflow": os.getenv("REGISTRY_TF_IMAGE", "us-docker.pkg.dev/vertex-ai/prediction/tf2-cpu.2-15:latest")}


def suffix(publish: bool) -> str:
    """プレビュー（publish=False）の BigQuery の表・モデルの接尾辞。本番の表には書かない。"""
    return "" if publish else "_preview"


def _choose(root: str, run_id: str, fid: str, art: dict) -> tuple[dict, dict | None, dict | None]:
    """(champion にする成果物, challenger の成果物, 比較結果)。比較結果が無ければ従来どおり（いまのモデルだけ）。"""
    t = read_text(root, f"runs/{run_id}/compare/{fid}.json")
    cmp = json.loads(t) if t else None
    if not cmp:
        return art, None, None

    def load(k):
        if k == "current":
            return art
        x = read_text(root, f"runs/{run_id}/bqml/{fid}/{k}.json")
        return json.loads(x) if x else None
    dec = cmp.get("decision") or {}
    champ = load(dec["champion"]) if dec.get("champion") else art
    chall = load(dec["challenger"]) if dec.get("challenger") else None
    return champ or art, chall, cmp


def promote(project: str, root: str, run_id: str, facility_ids: list[str], location: str = "asia-northeast1",
            experiment: str | None = "care-acceptance", strict_registry: bool = True, publish: bool = True) -> list[dict]:
    """publish=False（プレビュー）: champion などは root の下にだけ書く（API が読む本番の root を指さないこと）。
    BigQuery は *_preview の表、Model Registry には登録しない、Experiments は実行名に preview を付ける。"""
    from google.cloud import bigquery

    run_id = rid(run_id)
    bq = bigquery.Client(project=project)
    results, runs, scores, failures = [], [], [], []
    sfx = suffix(publish)
    for fid in facility_ids:
        cur = json.loads(read_text(root, f"runs/{run_id}/models/{fid}.json"))
        art, chall, cmp = _choose(root, run_id, fid, cur)
        passed = art["gate"]["passed"]
        hist = json.loads(read_text(root, f"models/{fid}/history.json") or "[]")
        m = art.get("metrics", {})
        mt = bqml_model_type(art)
        chosen = m.get(mt, m.get(art["kind"], {})) if art["kind"] != "baseline" else {}
        source = "bigquery_ml" if art.get("source") == "bigquery_ml" else "python"
        entry = {"version": run_id, "trained_at": art["trained_at"], "rows": art["n_rows"], "live_rows": cur.get("data", {}).get("live_rows", 0),
                 "kind": mt, "auc": chosen.get("auc"), "logloss": chosen.get("logloss"), "baseline_logloss": m.get("baseline", {}).get("logloss"),
                 "logloss_gain": m.get("logloss_gain_vs_baseline"), "gate_passed": passed, "gate_reasons": art["gate"]["reasons"], "promoted": passed,
                 "champion_source": source, "challenger_kind": bqml_model_type(chall) if chall else None}
        if cmp and cmp.get("holdout"):
            entry["compared_on_eval"] = {"current": cmp["holdout"].get("current"), "baseline": cmp["holdout"].get("baseline"),
                                         **{k: v["holdout"] for k, v in cmp.get("bqml", {}).items()}}
        hist.append(entry)
        write_text(root, f"models/{fid}/history.json", json.dumps(hist, ensure_ascii=False))
        registry, reg_error = None, None
        if passed:
            write_text(root, f"models/{fid}/champion.json", json.dumps(art, ensure_ascii=False))
        # challenger（A/B 用）。無ければ消す（古い challenger を使い続けない）
        if passed and chall and chall.get("gate", {}).get("passed"):
            write_text(root, f"models/{fid}/challenger.json", json.dumps(chall, ensure_ascii=False))
        else:
            delete(root, f"models/{fid}/challenger.json")
        # Model Registry: 基準を満たしたものは champion、満たさなかったものも candidate として残す（履歴として比べられるように）
        uri, fmt = _registry_artifact(root, run_id, fid, art, cmp)
        if uri and publish:
            try:
                registry = register(project, location, fid, art, uri, run_id, fmt=fmt, champion=passed)
            except Exception as e:  # noqa: BLE001  champion と履歴は書き終えてから、最後に失敗として伝える
                log.exception("[register] %s failed", fid)
                reg_error = f"{type(e).__name__}: {str(e)[:300]}"
                if passed:                          # champion の登録の失敗は実行を失敗にする（candidate の失敗は記録だけ）
                    failures.append((fid, reg_error))
        h = (cmp or {}).get("holdout", {})
        bqm = (cmp or {}).get("bqml", {})
        runs.append({**{k: entry[k] for k in ("version", "rows", "live_rows", "kind", "auc", "logloss", "baseline_logloss", "gate_passed")},
                     "facility_id": fid, "promoted": passed, "run_at": datetime.now(timezone.utc).isoformat(), "gate_reasons": "; ".join(art["gate"]["reasons"]),
                     "champion_source": source, "challenger_kind": entry["challenger_kind"], "eval_rows": (cmp or {}).get("eval_rows"),
                     "eval_logloss": (h.get("current") or {}).get("logloss"), "eval_auc": (h.get("current") or {}).get("auc"),
                     "bqml_lr_eval_logloss": (bqm.get("bqml_logistic_reg") or {}).get("holdout", {}).get("logloss"),
                     "bqml_bt_eval_logloss": (bqm.get("bqml_boosted_tree") or {}).get("holdout", {}).get("logloss"),
                     "compare_json": json.dumps({"holdout": h, "bqml": {k: {x: v.get(x) for x in ("holdout", "gate", "verified", "verify_max_diff")}
                                                                         for k, v in bqm.items()},
                                                 "errors": (cmp or {}).get("errors"), "decision": (cmp or {}).get("decision")}, ensure_ascii=False) if cmp else None})
        oof = read_text(root, f"runs/{run_id}/oof/{fid}.json")
        if oof:
            scores += json.loads(oof)
        results.append({"facility_id": fid, "promoted": passed, "kind": mt, "source": source, "challenger": entry["challenger_kind"], "registry": registry,
                        "registry_error": reg_error})
        log_experiment(project, location, experiment, run_id + ("" if publish else "-preview"), fid, cur, art, cmp, passed)
    if runs:                                  # スキーマは明示する（型の自動判定に頼らない）。比較の列は後から足したので、列の追加を許す
        bq.load_table_from_json(runs, f"{project}.{DATASET}.model_runs{sfx}", job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_APPEND", schema=_schema(RUNS_SCHEMA),
            schema_update_options=["ALLOW_FIELD_ADDITION"])).result()
    if scores:
        bq.load_table_from_json(scores, f"{project}.{DATASET}.offer_scores{sfx}", job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_APPEND", schema=_schema(SCORES_SCHEMA))).result()
    if failures and strict_registry:                # 黙って失敗しない。パイプラインの実行を失敗にして気づけるようにする（champion は更新済み）
        raise RuntimeError(f"Model Registry への登録に失敗: {failures}")
    return results


def delete(root: str, path: str) -> None:
    if read_text(root, path) is None:
        return
    try:
        b, p = _bucket(root)
        blob = b.blob(_key(p, path))
        if blob.exists():
            blob.delete()
    except Exception as e:  # noqa: BLE001
        print(f"[delete] {path}: {e}")


def _registry_artifact(root: str, run_id: str, fid: str, art: dict, cmp: dict | None) -> tuple[str | None, str]:
    """(Model Registry に渡すファイル, 形式)。register はそのファイルのディレクトリを渡す。"""
    if art.get("source") == "bigquery_ml":
        c = (cmp or {}).get("bqml", {}).get(bqml_model_type(art), {})
        if not c.get("export_uri"):
            return None, ""
        fmt = "xgboost" if art["kind"] == "xgboost" else "tensorflow"
        return f"{c['export_uri']}/{'model.bst' if fmt == 'xgboost' else 'saved_model.pb'}", fmt
    if art["kind"] == "baseline":                # 件数が少なすぎてモデルが無い
        return None, ""
    fmt = "xgboost" if art["kind"] == "xgboost" else "sklearn"
    return f"{root}/runs/{run_id}/registry/{fid}/{REGISTRY_FILES[fmt]}", fmt


def register(project: str, location: str, fid: str, art: dict, artifact_uri: str, run_id: str, fmt: str = "sklearn", *,
             champion: bool = True) -> str:
    """Vertex AI Model Registry に登録（モデルは API が読み込むのでデプロイはしない）。失敗は例外で呼び出し側に伝える。

    champion=False（基準を満たさない）でも candidate として版を残す。既定の版にはしない（champion の版を動かさない）。
    """
    from google.cloud import aiplatform

    aiplatform.init(project=project, location=location)
    existing = aiplatform.Model.list(filter=f'display_name="care-acceptance-{fid}"')
    gate = art.get("metrics", {})
    model = aiplatform.Model.upload(
        display_name=f"care-acceptance-{fid}", artifact_uri=artifact_uri.rsplit("/", 1)[0], serving_container_image_uri=CONTAINERS[fmt],
        parent_model=existing[0].resource_name if existing else None, is_default_version=champion or not existing,
        version_aliases=["champion"] if champion else ["candidate"],
        version_description=(f"{bqml_model_type(art)} / rows={art['n_rows']} / logloss_gain={gate.get('logloss_gain_vs_baseline')}"
                             + ("" if champion else " / 基準を満たさず（API では使わない）")),
        labels={"facility": fid.replace("fac-", ""), "kind": bqml_model_type(art).replace("_", "-"), "run": run_id.lower().replace("_", "-")[:60],
                "gate": "passed" if champion else "failed", "source": "bqml" if art.get("source") == "bigquery_ml" else "python"})
    return model.versioned_resource_name


def experiment_metrics(cur: dict, art: dict, cmp: dict | None, passed: bool) -> tuple[dict, dict]:
    """Vertex AI Experiments に記録する (params, metrics)。数値だけ（個人の情報は入れない）。"""
    m = cur.get("metrics", {})
    params = {"current_kind": cur["kind"], "champion_kind": bqml_model_type(art), "champion_source": art.get("source", "python"),
              "challenger": ((cmp or {}).get("decision") or {}).get("challenger") or "none"}
    met: dict[str, float] = {"rows": float(cur["n_rows"]), "live_rows": float(cur.get("data", {}).get("live_rows", 0)),
                             "gate_passed": 1.0 if passed else 0.0}
    for k in ("logistic", "xgboost", "pooled_logistic", "baseline"):
        for x in ("auc", "logloss", "brier"):
            if isinstance(m.get(k), dict) and m[k].get(x) is not None:
                met[f"cv_{k}_{x}"] = float(m[k][x])
    if m.get("logloss_gain_vs_baseline") is not None:
        met["cv_logloss_gain_vs_baseline"] = float(m["logloss_gain_vs_baseline"])
    if cmp and cmp.get("holdout"):
        met["eval_rows"] = float(cmp.get("eval_rows") or 0)
        for k, v in [*cmp["holdout"].items(), *((k, c["holdout"]) for k, c in cmp.get("bqml", {}).items())]:
            for x in ("auc", "logloss"):
                if v.get(x) is not None:
                    met[f"eval_{k}_{x}"] = float(v[x])
    return params, met


def log_experiment(project: str, location: str, experiment: str | None, run_id: str, fid: str, cur: dict, art: dict, cmp: dict | None, passed: bool) -> None:
    """Vertex AI Experiments に、施設ごとに 1 つの実行として指標を残す。失敗しても昇格は止めない。"""
    if not experiment:
        return
    try:
        from google.cloud import aiplatform

        params, met = experiment_metrics(cur, art, cmp, passed)
        aiplatform.init(project=project, location=location, experiment=experiment,
                        experiment_description="施設ごとの応諾予測（交差検証・BigQuery ML との比較）")
        name = f"{run_id}-{fid}".lower().replace("_", "-")[:120]
        with aiplatform.start_run(name, resume=False) as r:
            r.log_params({**params, "facility_id": fid, "version": run_id})
            r.log_metrics(met)
    except Exception as e:  # noqa: BLE001
        print(f"[experiment] skipped: {e}")


# ------------------------------------------------------------------ detect
SYNTH_EDITS_SQL = """
SELECT edit_id, staff_id, CAST(date AS STRING) AS date, weekday, from_shift, to_shift FROM `{project}.care_ml.fact_roster_edits` WHERE facility_id = '{fid}'
"""
# 実運用の手修正（公開 API から書ける）。live_sources を明示したときだけ、IP・人ごとの上限つきで足す
LIVE_EDITS_SQL = """
SELECT * EXCEPT(n_ip, n_staff) FROM (
SELECT JSON_VALUE(data,'$.event_id'), JSON_VALUE(p,'$.staff_id'), FORMAT('%s-%02d', JSON_VALUE(p,'$.month'), CAST(JSON_VALUE(p,'$.day') AS INT64)),
       CAST(JSON_VALUE(p,'$.weekday') AS INT64), JSON_VALUE(p,'$.from_shift'), JSON_VALUE(p,'$.to_shift')
       , ROW_NUMBER() OVER (PARTITION BY ip_hash ORDER BY publish_time DESC) AS n_ip
       , ROW_NUMBER() OVER (PARTITION BY JSON_VALUE(p,'$.staff_id') ORDER BY publish_time DESC) AS n_staff
FROM (SELECT data, publish_time, ip_hash, PARSE_JSON(JSON_VALUE(data,'$.payload')) AS p FROM (""" + _EV + """)
      WHERE source IN ({sources}) AND JSON_VALUE(data,'$.event_type') = 'roster_edit' AND JSON_VALUE(data,'$.facility_id') = '{fid}')
WHERE JSON_VALUE(p,'$.kind') = 'manual' AND JSON_VALUE(p,'$.weekday') IS NOT NULL
) WHERE n_ip <= {cap_ip} AND n_staff <= {cap_staff}
"""


def edits_sql(fid: str, sources: list[str], cap_per_staff: int = DEFAULT_CAP_PER_STAFF, cap_per_ip: int = DEFAULT_CAP_PER_IP) -> str:
    sql = SYNTH_EDITS_SQL
    if sources:
        sql += "UNION ALL\n" + LIVE_EDITS_SQL.replace("{sources}", _sql_list(sources)).replace("{cap_ip}", str(int(cap_per_ip))).replace(
            "{cap_staff}", str(int(cap_per_staff)))
    return sql.replace("{fid}", fid)
TASK_EDITS_SQL = """SELECT task_edit_id, staff_id, CAST(date AS STRING) AS date, time_block, from_task FROM `{project}.care_ml.fact_task_edits` WHERE facility_id = '{fid}'"""


def detect(project: str, root: str, facility_ids: list[str], live_sources: str = "", cap_per_staff: int = DEFAULT_CAP_PER_STAFF,
           cap_per_ip: int = DEFAULT_CAP_PER_IP, publish: bool = True) -> list[dict]:
    from google.cloud import bigquery

    from .detect import detect_daily, detect_roster

    bq = bigquery.Client(project=project)
    staff = {}
    for r in bq.query(f"SELECT facility_id, COUNT(*) n FROM `{project}.care_ml.dim_staff` GROUP BY 1").result():
        staff[r.facility_id] = r.n
    all_rows, out = [], []
    for fid in facility_ids:
        edits = _rows(project, edits_sql(fid, parse_sources(live_sources), cap_per_staff, cap_per_ip))
        tasks = _rows(project, TASK_EDITS_SQL.replace("{fid}", fid))
        cands = [*detect_roster(edits, n_staff=staff.get(fid, 20)), *detect_daily(tasks, n_staff=staff.get(fid, 20))]
        write_text(root, f"learned/{fid}.json", json.dumps({"facility_id": fid, "detected_at": datetime.now(timezone.utc).isoformat(),
                                                           "edits_seen": len(edits), "task_edits_seen": len(tasks), "candidates": cands}, ensure_ascii=False))
        all_rows += [{"facility_id": fid, "key": c["key"], "kind": c["kind"], "staff_id": c["staff_id"], "evidence": c["evidence"],
                      "repeated": c.get("months_repeated") or c.get("days_repeated"), "threshold": c["threshold"],
                      "detected_at": datetime.now(timezone.utc).isoformat()} for c in cands]
        out.append({"facility_id": fid, "candidates": len(cands), "edits": len(edits)})
    if all_rows:
        bq.load_table_from_json(all_rows, f"{project}.{DATASET}.learned_rule_candidates{suffix(publish)}", job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_TRUNCATE", schema=_schema(CANDIDATES_SCHEMA))).result()
    return out


if __name__ == "__main__":                       # 手元・コンテナでの単発実行: python -m care.learn.steps <step> <args...>
    import sys

    step, args = sys.argv[1], sys.argv[2:]
    fn = {"extract": extract, "train": train, "compare": compare, "promote": promote, "detect": detect}[step]
    print(json.dumps(fn(*[json.loads(a) if a.startswith("[") else a for a in args]), ensure_ascii=False, default=str))
