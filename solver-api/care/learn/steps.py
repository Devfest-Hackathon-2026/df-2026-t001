"""Vertex AI Pipelines の各ステップの中身。トレーナーイメージの中で動く（GCS / BigQuery / Vertex AI にアクセスする）。

  extract   BigQuery → 学習データ（打診の履歴＋実運用の打診の結果）を GCS に
  train     施設ごとに学習（ロジスティック / XGBoost / プール学習を交差検証で比べる）→ 成果物を GCS に
  promote   基準を満たした成果物を champion にし、Model Registry に登録、履歴と out-of-fold 予測を BigQuery に
  detect    手修正のくり返しを検出 → ルール候補を GCS と BigQuery に

成果物は gs://<root>/models/<施設>/champion.json（API が読む）。履歴は history.json、反復検出は learned/<施設>.json。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

DATASET = "care_ml"
REAL_OFFERS_SQL = """
WITH sent AS (
  SELECT JSON_VALUE(data,'$.facility_id') AS facility_id, JSON_VALUE(data,'$.vacancy_id') AS vacancy_id,
         PARSE_JSON(JSON_VALUE(data,'$.payload')) AS p, publish_time
  FROM `{project}.care_analytics.events_raw`
  WHERE JSON_VALUE(data,'$.synthetic') IS NULL AND JSON_VALUE(data,'$.event_type') = 'offer_sent'
),
resp AS (
  SELECT JSON_VALUE(data,'$.vacancy_id') AS vacancy_id, JSON_VALUE(JSON_VALUE(data,'$.payload'),'$.staff_id') AS staff_id,
         JSON_VALUE(JSON_VALUE(data,'$.payload'),'$.status') AS status
  FROM `{project}.care_analytics.events_raw`
  WHERE JSON_VALUE(data,'$.synthetic') IS NULL AND JSON_VALUE(data,'$.event_type') = 'offer_responded'
)
SELECT s.facility_id, s.vacancy_id, JSON_VALUE(s.p,'$.staff_id') AS staff_id, r.status,
       CAST(JSON_VALUE(s.p,'$.features.lead_hours') AS FLOAT64) AS lead_hours,
       CAST(JSON_VALUE(s.p,'$.features.weekday') AS INT64) AS weekday, JSON_VALUE(s.p,'$.features.shift') AS shift,
       JSON_VALUE(s.p,'$.features.same_unit') = 'true' AS same_unit, JSON_VALUE(s.p,'$.features.skill_match') = 'true' AS skill_match,
       CAST(JSON_VALUE(s.p,'$.features.consec_before') AS INT64) AS consec_before,
       CAST(JSON_VALUE(s.p,'$.features.month_hours_before') AS FLOAT64) AS month_hours_before,
       CAST(JSON_VALUE(s.p,'$.features.nights_last30') AS INT64) AS nights_last30,
       CAST(JSON_VALUE(s.p,'$.features.offers_last14') AS INT64) AS offers_last14,
       CAST(JSON_VALUE(s.p,'$.features.tenure_years') AS INT64) AS tenure_years, JSON_VALUE(s.p,'$.features.employment') AS employment
FROM sent s JOIN resp r ON r.vacancy_id = s.vacancy_id AND r.staff_id = JSON_VALUE(s.p,'$.staff_id')
WHERE JSON_VALUE(s.p,'$.features.lead_hours') IS NOT NULL AND r.status IN ('accepted','declined','expired')
"""
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
               ("run_at", "TIMESTAMP"), ("gate_reasons", "STRING")]
SCORES_SCHEMA = [("facility_id", "STRING"), ("vacancy_id", "STRING"), ("staff_id", "STRING"), ("model_version", "STRING"), ("model_kind", "STRING"),
                 ("p_accept", "FLOAT"), ("label", "INTEGER"), ("scored_at", "TIMESTAMP")]
CANDIDATES_SCHEMA = [("facility_id", "STRING"), ("key", "STRING"), ("kind", "STRING"), ("staff_id", "STRING"), ("evidence", "STRING"),
                     ("repeated", "INTEGER"), ("threshold", "INTEGER"), ("detected_at", "TIMESTAMP")]


def _schema(cols):
    from google.cloud import bigquery

    return [bigquery.SchemaField(n, t) for n, t in cols]


# ------------------------------------------------------------------ extract
def extract(project: str, root: str, run_id: str) -> dict:
    run_id = rid(run_id)
    synth = _rows(project, SYNTH_OFFERS_SQL)
    real = _rows(project, REAL_OFFERS_SQL)
    for r in synth:
        r["source"] = "synthetic"
    for r in real:
        r["source"] = "live"
    rows = synth + real
    uri = write_text(root, f"runs/{run_id}/offers.json", json.dumps(rows, ensure_ascii=False, default=str))
    return {"uri": uri, "synthetic": len(synth), "live": len(real)}


# ------------------------------------------------------------------ train
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
    if out.get("sk") is not None:                  # Model Registry 用: sklearn 形式（model.joblib）と、API が読む JSON を同じディレクトリに
        import joblib
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".joblib") as f:
            joblib.dump(out["sk"], f.name)
            write_file(root, f"runs/{run_id}/registry/{facility_id}/model.joblib", f.name)
        write_text(root, f"runs/{run_id}/registry/{facility_id}/champion.json", json.dumps(art, ensure_ascii=False))
    if out.get("oof"):
        oof = [{"facility_id": facility_id, "vacancy_id": r["vacancy_id"], "staff_id": r["staff_id"], "model_version": run_id,
                "model_kind": out["oof_kind"], "p_accept": round(p, 5), "label": int(r["status"] == "accepted"), "scored_at": datetime.now(timezone.utc).isoformat()}
               for r, p in zip(own, out["oof"])]
        write_text(root, f"runs/{run_id}/oof/{facility_id}.json", json.dumps(oof))
    return {"facility_id": facility_id, "uri": uri, "kind": art["kind"], "gate": art["gate"], "metrics": art.get("metrics", {}), "rows": len(own)}


# ------------------------------------------------------------------ promote
def promote(project: str, root: str, run_id: str, facility_ids: list[str], location: str = "asia-northeast1") -> list[dict]:
    from google.cloud import bigquery

    run_id = rid(run_id)
    bq = bigquery.Client(project=project)
    results, runs, scores = [], [], []
    for fid in facility_ids:
        art = json.loads(read_text(root, f"runs/{run_id}/models/{fid}.json"))
        passed = art["gate"]["passed"]
        hist = json.loads(read_text(root, f"models/{fid}/history.json") or "[]")
        m = art.get("metrics", {})
        chosen = m.get(art["kind"], {}) if art["kind"] != "baseline" else {}
        entry = {"version": run_id, "trained_at": art["trained_at"], "rows": art["n_rows"], "live_rows": art.get("data", {}).get("live_rows", 0),
                 "kind": art["kind"], "auc": chosen.get("auc"), "logloss": chosen.get("logloss"), "baseline_logloss": m.get("baseline", {}).get("logloss"),
                 "logloss_gain": m.get("logloss_gain_vs_baseline"), "gate_passed": passed, "gate_reasons": art["gate"]["reasons"], "promoted": passed}
        hist.append(entry)
        write_text(root, f"models/{fid}/history.json", json.dumps(hist, ensure_ascii=False))
        registry = None
        if passed:
            write_text(root, f"models/{fid}/champion.json", json.dumps(art, ensure_ascii=False))
            registry = register(project, location, fid, art, f"{root}/runs/{run_id}/registry/{fid}/model.joblib", run_id)
        runs.append({**{k: entry[k] for k in ("version", "rows", "live_rows", "kind", "auc", "logloss", "baseline_logloss", "gate_passed")},
                     "facility_id": fid, "promoted": passed, "run_at": datetime.now(timezone.utc).isoformat(), "gate_reasons": "; ".join(art["gate"]["reasons"])})
        oof = read_text(root, f"runs/{run_id}/oof/{fid}.json")
        if oof:
            scores += json.loads(oof)
        results.append({"facility_id": fid, "promoted": passed, "kind": art["kind"], "registry": registry})
    if runs:                                  # スキーマは明示する（型の自動判定に頼らない）
        bq.load_table_from_json(runs, f"{project}.{DATASET}.model_runs", job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_APPEND", schema=_schema(RUNS_SCHEMA))).result()
    if scores:
        bq.load_table_from_json(scores, f"{project}.{DATASET}.offer_scores", job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_APPEND", schema=_schema(SCORES_SCHEMA))).result()
    return results


def register(project: str, location: str, fid: str, art: dict, artifact_uri: str, run_id: str) -> str | None:
    """Vertex AI Model Registry に登録（モデルは API が読み込むのでデプロイはしない）。失敗しても学習の成果は失わない。"""
    try:
        from google.cloud import aiplatform

        aiplatform.init(project=project, location=location)
        existing = aiplatform.Model.list(filter=f'display_name="care-acceptance-{fid}"')
        gate = art.get("metrics", {})
        model = aiplatform.Model.upload(
            display_name=f"care-acceptance-{fid}", artifact_uri=artifact_uri.rsplit("/", 1)[0],
            serving_container_image_uri="us-docker.pkg.dev/vertex-ai/prediction/sklearn-cpu.1-5:latest",
            parent_model=existing[0].resource_name if existing else None, is_default_version=True, version_aliases=["champion"],
            version_description=f"{art['kind']} / rows={art['n_rows']} / logloss_gain={gate.get('logloss_gain_vs_baseline')}",
            labels={"facility": fid.replace("fac-", ""), "kind": art["kind"].replace("_", "-"), "run": run_id.lower().replace("_", "-")[:60]})
        return model.versioned_resource_name
    except Exception as e:  # noqa: BLE001
        print(f"[register] skipped: {e}")
        return None


# ------------------------------------------------------------------ detect
EDITS_SQL = """
SELECT edit_id, staff_id, CAST(date AS STRING) AS date, weekday, from_shift, to_shift FROM `{project}.care_ml.fact_roster_edits` WHERE facility_id = '{fid}'
UNION ALL
SELECT JSON_VALUE(data,'$.event_id'), JSON_VALUE(p,'$.staff_id'), FORMAT('%s-%02d', JSON_VALUE(p,'$.month'), CAST(JSON_VALUE(p,'$.day') AS INT64)),
       CAST(JSON_VALUE(p,'$.weekday') AS INT64), JSON_VALUE(p,'$.from_shift'), JSON_VALUE(p,'$.to_shift')
FROM (SELECT data, PARSE_JSON(JSON_VALUE(data,'$.payload')) AS p FROM `{project}.care_analytics.events_raw`
      WHERE JSON_VALUE(data,'$.synthetic') IS NULL AND JSON_VALUE(data,'$.event_type') = 'roster_edit' AND JSON_VALUE(data,'$.facility_id') = '{fid}')
WHERE JSON_VALUE(p,'$.kind') = 'manual' AND JSON_VALUE(p,'$.weekday') IS NOT NULL
"""
TASK_EDITS_SQL = """SELECT task_edit_id, staff_id, CAST(date AS STRING) AS date, time_block, from_task FROM `{project}.care_ml.fact_task_edits` WHERE facility_id = '{fid}'"""


def detect(project: str, root: str, facility_ids: list[str]) -> list[dict]:
    from google.cloud import bigquery

    from .detect import detect_daily, detect_roster

    bq = bigquery.Client(project=project)
    staff = {}
    for r in bq.query(f"SELECT facility_id, COUNT(*) n FROM `{project}.care_ml.dim_staff` GROUP BY 1").result():
        staff[r.facility_id] = r.n
    all_rows, out = [], []
    for fid in facility_ids:
        edits = _rows(project, EDITS_SQL.replace("{fid}", fid))
        tasks = _rows(project, TASK_EDITS_SQL.replace("{fid}", fid))
        cands = [*detect_roster(edits, n_staff=staff.get(fid, 20)), *detect_daily(tasks, n_staff=staff.get(fid, 20))]
        write_text(root, f"learned/{fid}.json", json.dumps({"facility_id": fid, "detected_at": datetime.now(timezone.utc).isoformat(),
                                                           "edits_seen": len(edits), "task_edits_seen": len(tasks), "candidates": cands}, ensure_ascii=False))
        all_rows += [{"facility_id": fid, "key": c["key"], "kind": c["kind"], "staff_id": c["staff_id"], "evidence": c["evidence"],
                      "repeated": c.get("months_repeated") or c.get("days_repeated"), "threshold": c["threshold"],
                      "detected_at": datetime.now(timezone.utc).isoformat()} for c in cands]
        out.append({"facility_id": fid, "candidates": len(cands), "edits": len(edits)})
    if all_rows:
        bq.load_table_from_json(all_rows, f"{project}.{DATASET}.learned_rule_candidates", job_config=bigquery.LoadJobConfig(
            write_disposition="WRITE_TRUNCATE", schema=_schema(CANDIDATES_SCHEMA))).result()
    return out


if __name__ == "__main__":                       # 手元・コンテナでの単発実行: python -m care.learn.steps <step> <args...>
    import sys

    step, args = sys.argv[1], sys.argv[2:]
    fn = {"extract": extract, "train": train, "detect": detect}[step]
    print(json.dumps(fn(*[json.loads(a) if a.startswith("[") else a for a in args]), ensure_ascii=False, default=str))
