#!/usr/bin/env python3
"""Vertex AI Pipelines の定義（KFP v2）と、コンパイル・実行・スケジュール作成。

  extract ─┬─ train(施設A) ─┐
           ├─ train(施設B) ─┼─ promote（基準を満たしたものを champion に・Model Registry・BigQuery）
           └─ train(施設C) ─┘
  detect（手修正のくり返し → ルール候補）は extract と並行

  python pipelines/pipeline.py compile                 # JSON にコンパイルして GCS に置く
  python pipelines/pipeline.py run                     # 1回実行（pipeline-sa で）
  python pipelines/pipeline.py schedule                # 週次（月曜 03:00 JST）の実行を作る
"""
import json
import sys
from datetime import datetime, timezone

from kfp import compiler, dsl

PROJECT, LOCATION = "gdgoc-514203", "asia-northeast1"
ROOT = "gs://gdgoc-514203-vertex-pipelines"
IMAGE = f"{LOCATION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/care-trainer:v1"
SA = "pipeline-sa@gdgoc-514203.iam.gserviceaccount.com"
FACILITIES = ["fac-sakura", "fac-midori", "fac-hidamari"]
TEMPLATE = f"{ROOT}/templates/care-learn.json"


@dsl.component(base_image=IMAGE)
def extract_op(project: str, root: str, run_id: str, out: dsl.Output[dsl.Dataset]):
    from care.learn import steps

    r = steps.extract(project, root, run_id)
    out.uri = r["uri"]
    out.metadata.update({"synthetic_rows": r["synthetic"], "live_rows": r["live"]})


@dsl.component(base_image=IMAGE)
def train_op(project: str, root: str, run_id: str, facility_id: str, data: dsl.Input[dsl.Dataset], model: dsl.Output[dsl.Model],
             metrics: dsl.Output[dsl.Metrics]):
    from care.learn import steps

    r = steps.train(project, root, run_id, facility_id)
    model.uri = r["uri"]
    model.metadata.update({"kind": r["kind"], "gate_passed": r["gate"]["passed"], "rows": r["rows"]})
    m = r["metrics"]
    chosen = m.get(r["kind"], {}) if r["kind"] != "baseline" else {}
    for k in ("auc", "logloss", "brier"):
        if k in chosen:
            metrics.log_metric(k, chosen[k])
    if "baseline" in m:
        metrics.log_metric("baseline_logloss", m["baseline"]["logloss"])
        metrics.log_metric("logloss_gain_vs_baseline", m["logloss_gain_vs_baseline"])
    metrics.log_metric("gate_passed", 1.0 if r["gate"]["passed"] else 0.0)


@dsl.component(base_image=IMAGE)
def promote_op(project: str, root: str, run_id: str, facility_ids: list, summary: dsl.Output[dsl.Metrics]):
    from care.learn import steps

    res = steps.promote(project, root, run_id, facility_ids)
    for r in res:
        summary.log_metric(f"promoted_{r['facility_id']}", 1.0 if r["promoted"] else 0.0)


@dsl.component(base_image=IMAGE)
def detect_op(project: str, root: str, facility_ids: list, summary: dsl.Output[dsl.Metrics]):
    from care.learn import steps

    for r in steps.detect(project, root, facility_ids):
        summary.log_metric(f"candidates_{r['facility_id']}", float(r["candidates"]))


@dsl.pipeline(name="care-learn", description="施設ごとの応諾予測の学習・昇格と、手修正のくり返しの検出")
def care_learn(project: str = PROJECT, root: str = ROOT):
    # 版名には、実行ごとに一意なジョブ ID を使う（週次スケジュールでも成果物を上書きしない）
    run_id = dsl.PIPELINE_JOB_ID_PLACEHOLDER
    data = extract_op(project=project, root=root, run_id=run_id).set_display_name("extract: BigQuery → 学習データ")
    trains = [train_op(project=project, root=root, run_id=run_id, facility_id=f, data=data.outputs["out"]).set_display_name(f"train: {f}")
              .set_cpu_limit("2").set_memory_limit("4G") for f in FACILITIES]
    promote_op(project=project, root=root, run_id=run_id, facility_ids=FACILITIES).after(*trains).set_display_name("promote: gate → champion → Registry → BigQuery")
    detect_op(project=project, root=root, facility_ids=FACILITIES).set_display_name("detect: 手修正のくり返し → ルール候補")


def compile_to(path: str) -> None:
    compiler.Compiler().compile(care_learn, path)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "compile"
    if cmd == "compile":
        compile_to("/tmp/care-learn.json") if len(sys.argv) < 3 else compile_to(sys.argv[2])
        print("compiled")
    else:
        from google.cloud import aiplatform, storage

        aiplatform.init(project=PROJECT, location=LOCATION, staging_bucket=ROOT)
        local = "/tmp/care-learn.json"
        compile_to(local)
        b, _, key = TEMPLATE[5:].partition("/")
        storage.Client(project=PROJECT).bucket(b).blob(key).upload_from_filename(local)
        job = aiplatform.PipelineJob(display_name="care-learn", template_path=TEMPLATE, pipeline_root=f"{ROOT}/pipeline_root",
                                     parameter_values={"project": PROJECT, "root": ROOT}, enable_caching=False)
        if cmd == "run":
            job.submit(service_account=SA)
            print(json.dumps({"job": job.resource_name, "console": job._dashboard_uri()}))
        elif cmd == "schedule":
            sch = aiplatform.PipelineJobSchedule(pipeline_job=job, display_name="care-learn-weekly")
            sch.create(cron="TZ=Asia/Tokyo 0 3 * * 1", service_account=SA, max_concurrent_run_count=1, max_run_count=None)
            print("schedule:", sch.resource_name)
