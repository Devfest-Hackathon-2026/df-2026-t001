#!/usr/bin/env python3
"""Vertex AI Pipelines の定義（KFP v2）と、コンパイル・実行・スケジュール作成。

  extract ─┬─ train(施設A) ─┐
           ├─ train(施設B) ─┼─ compare（BigQuery ML と同じ評価データで比較）─ promote（champion / challenger・Model Registry・Experiments・BigQuery）
           └─ train(施設C) ─┘
  detect（手修正のくり返し → ルール候補）は extract と並行

  python pipelines/pipeline.py compile [path]          # JSON にコンパイル（既定: infra/pipelines/care-learn.json。Cloud Scheduler が読む）
  python pipelines/pipeline.py run                     # 1回実行（pipeline-sa で）
  python pipelines/pipeline.py schedule                # 旧: Vertex の週次スケジュール。毎日の実行は Cloud Scheduler（infra/ml_boost.tf）
"""
import json
import os
import sys
from datetime import datetime, timezone

from kfp import compiler, dsl

# 既定は今のプロジェクト。環境変数で差し替えられる（別プロジェクトへの再現用）
PROJECT = os.getenv("GOOGLE_CLOUD_PROJECT", "gdgoc-514203")
LOCATION = os.getenv("PIPELINE_LOCATION", "asia-northeast1")
ROOT = os.getenv("PIPELINE_ROOT", f"gs://{PROJECT}-vertex-pipelines")
IMAGE = os.getenv("TRAINER_IMAGE", f"{LOCATION}-docker.pkg.dev/{PROJECT}/cloud-run-source-deploy/care-trainer:v3")
SA = os.getenv("PIPELINE_SA", f"pipeline-sa@{PROJECT}.iam.gserviceaccount.com")
FACILITIES = [f for f in os.getenv("PIPELINE_FACILITIES", "fac-sakura,fac-midori,fac-hidamari").split(",") if f]
TEMPLATE = f"{ROOT}/templates/care-learn.json"
COMPILED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "infra", "pipelines", "care-learn.json")
EXPERIMENT = "care-acceptance"


@dsl.component(base_image=IMAGE)
def extract_op(project: str, root: str, run_id: str, live_sources: str, cap_per_staff: int, cap_per_ip: int, out: dsl.Output[dsl.Dataset]):
    from care.learn import steps

    r = steps.extract(project, root, run_id, live_sources, cap_per_staff, cap_per_ip)
    out.uri = r["uri"]
    out.metadata.update({"synthetic_rows": r["synthetic"], "live_rows": r["live"], "live_sources": live_sources})


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
def compare_op(project: str, root: str, run_id: str, facility_ids: list, allow_bqml: bool, publish: bool, summary: dsl.Output[dsl.Metrics]):
    import json

    from care.learn import steps

    for r in steps.compare(project, root, run_id, facility_ids, allow_bqml=allow_bqml, publish=publish):
        f = r["facility_id"]
        for k, v in r.get("holdout", {}).items():
            summary.log_metric(f"{f}_eval_{k}_logloss", v["logloss"])
        for k, c in r.get("bqml", {}).items():
            summary.log_metric(f"{f}_eval_{k}_logloss", c["holdout"]["logloss"])
            summary.log_metric(f"{f}_eval_{k}_auc", c["holdout"]["auc"])
        summary.metadata[f"{f}_decision"] = json.dumps(r.get("decision"))


@dsl.component(base_image=IMAGE)
def promote_op(project: str, root: str, run_id: str, facility_ids: list, experiment: str, publish: bool, summary: dsl.Output[dsl.Metrics]):
    from care.learn import steps

    res = steps.promote(project, root, run_id, facility_ids, experiment=experiment or None, publish=publish)
    for r in res:
        summary.log_metric(f"promoted_{r['facility_id']}", 1.0 if r["promoted"] else 0.0)
        summary.metadata[f"{r['facility_id']}_champion"] = f"{r['kind']} ({r['source']})"
        summary.metadata[f"{r['facility_id']}_challenger"] = r["challenger"] or "none"


@dsl.component(base_image=IMAGE)
def detect_op(project: str, root: str, facility_ids: list, live_sources: str, cap_per_staff: int, cap_per_ip: int, publish: bool,
              summary: dsl.Output[dsl.Metrics]):
    from care.learn import steps

    for r in steps.detect(project, root, facility_ids, live_sources, cap_per_staff, cap_per_ip, publish=publish):
        summary.log_metric(f"candidates_{r['facility_id']}", float(r["candidates"]))


@dsl.pipeline(name="care-learn", description="施設ごとの応諾予測の学習・昇格と、手修正のくり返しの検出")
def care_learn(project: str = PROJECT, root: str = ROOT, live_sources: str = "", cap_per_staff: int = 20, cap_per_ip: int = 50,
               allow_bqml: bool = True, experiment: str = EXPERIMENT, publish: bool = True):
    # live_sources: 実運用イベントの出どころ（data.source）をカンマ区切りで。既定 "" は使わない（公開デモ API からの汚染を防ぐ）。
    # 例 "trusted"（認証つきの運用だけ）/ "trusted,public_api"（公開 API も、上限つきで）
    # BigQuery ML の比較（compare）は extract の出力をそのまま使うので、live_sources・上限の条件が同じく効く。
    # publish=False はプレビュー: root を本番（API の MODEL_ROOT）と別の接頭辞にして使う。BigQuery は *_preview、Model Registry には登録しない
    # 版名には、実行ごとに一意なジョブ ID を使う（週次スケジュールでも成果物を上書きしない）
    run_id = dsl.PIPELINE_JOB_ID_PLACEHOLDER
    data = extract_op(project=project, root=root, run_id=run_id, live_sources=live_sources, cap_per_staff=cap_per_staff, cap_per_ip=cap_per_ip).set_display_name("extract: BigQuery → 学習データ")
    trains = [train_op(project=project, root=root, run_id=run_id, facility_id=f, data=data.outputs["out"]).set_display_name(f"train: {f}")
              .set_cpu_limit("2").set_memory_limit("4G") for f in FACILITIES]
    cmp = compare_op(project=project, root=root, run_id=run_id, facility_ids=FACILITIES, allow_bqml=allow_bqml, publish=publish).after(*trains) \
        .set_display_name("compare: BigQuery ML（LOGISTIC_REG / BOOSTED_TREE）と同じ評価データで比較")
    promote_op(project=project, root=root, run_id=run_id, facility_ids=FACILITIES, experiment=experiment, publish=publish).after(cmp) \
        .set_display_name("promote: champion / challenger → Registry → Experiments → BigQuery")
    detect_op(project=project, root=root, facility_ids=FACILITIES, live_sources=live_sources, cap_per_staff=cap_per_staff, cap_per_ip=cap_per_ip,
              publish=publish).set_display_name("detect: 手修正のくり返し → ルール候補")


def compile_to(path: str) -> None:
    compiler.Compiler().compile(care_learn, path)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "compile"
    if cmd == "compile":
        path = os.path.abspath(COMPILED if len(sys.argv) < 3 else sys.argv[2])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        compile_to(path)
        print("compiled:", path)
    else:
        from google.cloud import aiplatform, storage

        aiplatform.init(project=PROJECT, location=LOCATION, staging_bucket=ROOT)
        local = "/tmp/care-learn.json"
        compile_to(local)
        if cmd != "preview":                       # preview は本番の templates/ に置かない（手元の定義をそのまま使う）
            b, _, key = TEMPLATE[5:].partition("/")
            storage.Client(project=PROJECT).bucket(b).blob(key).upload_from_filename(local)
        job = None if cmd == "preview" else aiplatform.PipelineJob(
            display_name="care-learn", template_path=TEMPLATE, pipeline_root=f"{ROOT}/pipeline_root",
            parameter_values={"project": PROJECT, "root": ROOT, "live_sources": os.getenv("LIVE_SOURCES", "")}, enable_caching=False)
        if cmd == "preview":                       # 本番の champion を書き換えない 1 回実行: python pipelines/pipeline.py preview [gs://…/preview]
            proot = (sys.argv[2] if len(sys.argv) > 2 else f"{ROOT}/preview").rstrip("/")
            if proot.rstrip("/") == ROOT.rstrip("/") or proot.rstrip("/") == os.getenv("MODEL_ROOT", "").rstrip("/"):
                raise SystemExit("preview の root は本番（API の MODEL_ROOT）と別にしてください")
            job = aiplatform.PipelineJob(display_name="care-learn-preview", template_path=local, pipeline_root=f"{proot}/pipeline_root",
                                         parameter_values={"project": PROJECT, "root": proot, "live_sources": os.getenv("LIVE_SOURCES", ""),
                                                           "publish": False}, enable_caching=False)
            job.submit(service_account=SA)
            print(json.dumps({"job": job.resource_name, "root": proot, "console": job._dashboard_uri()}))
        elif cmd == "run":
            job.submit(service_account=SA)
            print(json.dumps({"job": job.resource_name, "console": job._dashboard_uri()}))
        elif cmd == "schedule":
            sch = aiplatform.PipelineJobSchedule(pipeline_job=job, display_name="care-learn-weekly")
            sch.create(cron="TZ=Asia/Tokyo 0 3 * * 1", service_account=SA, max_concurrent_run_count=1, max_run_count=None)
            print("schedule:", sch.resource_name)
