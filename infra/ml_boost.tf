# 学習サイクルの強化: 学習パイプラインの毎日の自動実行（Cloud Scheduler）と、A/B の腕ごとの応諾率（BigQuery のビュー）
#
#   Cloud Scheduler（毎日 04:00 JST）→ Vertex AI pipelineJobs.create（パイプラインの定義は infra/pipelines/care-learn.json を埋め込む）
#   パイプライン自体は pipeline-sa で動く。起動役の care-learn-scheduler は「起動」と「pipeline-sa として動かす」権限だけを持つ。
#   定義を変えたら: solver-api/.venv/bin/python solver-api/pipelines/pipeline.py compile → terraform apply -target=google_cloud_scheduler_job.care_learn_daily


resource "google_service_account" "learn_scheduler" {
  account_id   = "care-learn-scheduler"
  display_name = "Cloud Scheduler → 学習パイプラインの起動"
}

# パイプラインのジョブを作る
resource "google_project_iam_member" "learn_scheduler_aiplatform" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.learn_scheduler.email}"
}

# ジョブを pipeline-sa で動かす（actAs）
resource "google_service_account_iam_member" "learn_scheduler_act_as_pipeline" {
  service_account_id = google_service_account.pipeline.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.learn_scheduler.email}"
}

# Cloud Scheduler のサービスエージェントが、起動役のアクセストークンを作る
resource "google_service_account_iam_member" "learn_scheduler_token" {
  service_account_id = google_service_account.learn_scheduler.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
}

# BigQuery ML の EXPORT MODEL（Model Registry 用）と CREATE MODEL は、pipeline-sa の既存の権限（care_ml の dataEditor・jobUser・バケットの objectAdmin）で足りる

locals {
  care_learn_body = {
    displayName  = "care-learn-daily"
    pipelineSpec = jsondecode(file("${path.module}/pipelines/care-learn.json"))
    runtimeConfig = {
      gcsOutputDirectory = "gs://${google_storage_bucket.pipeline_root.name}/pipeline_root"
      parameterValues = {
        project      = var.project_id
        root         = "gs://${google_storage_bucket.pipeline_root.name}"
        allow_bqml   = true
        experiment   = "care-acceptance"
        publish      = true
        live_sources = "" # 既定: 実運用（公開 API）のイベントは学習に使わない（main の汚染対策）
      }
    }
    serviceAccount = google_service_account.pipeline.email
    labels         = { trigger = "cloud-scheduler" }
  }
}

resource "google_cloud_scheduler_job" "care_learn_daily" {
  name             = "care-learn-daily"
  description      = "応諾予測の学習パイプライン（extract → train → BigQuery ML 比較 → promote / detect）を毎日実行"
  region           = var.region
  schedule         = "0 4 * * *"
  time_zone        = "Asia/Tokyo"
  attempt_deadline = "60s"
  # 統合担当が一時停止中（main の汚染対策を取り込んだ v3 の確認が済むまで）。再開するときは false にして apply
  paused = true

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-aiplatform.googleapis.com/v1/projects/${var.project_id}/locations/${var.region}/pipelineJobs"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode(local.care_learn_body))
    oauth_token {
      service_account_email = google_service_account.learn_scheduler.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_iam_member.learn_scheduler_aiplatform,
    google_service_account_iam_member.learn_scheduler_act_as_pipeline,
  ]
}

# A/B（AB_CHALLENGER_SHARE）: 打診のイベント（offer_sent の payload.ab）と返事（offer_responded）を突き合わせ、腕ごとの応諾率を出す
resource "google_bigquery_table" "ab_offer_outcomes" {
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = "ab_offer_outcomes"
  deletion_protection = false
  description         = "A/B の腕（champion / challenger）ごとの打診数・応諾率。合成イベントは含めない"
  view {
    use_legacy_sql = false
    query          = <<-SQL
      WITH sent AS (
        SELECT JSON_VALUE(data, '$.facility_id') AS facility_id, JSON_VALUE(data, '$.vacancy_id') AS vacancy_id,
               PARSE_JSON(JSON_VALUE(data, '$.payload')) AS p, publish_time
        FROM `${var.project_id}.${google_bigquery_dataset.analytics.dataset_id}.events_raw`
        WHERE JSON_VALUE(data, '$.synthetic') IS NULL AND JSON_VALUE(data, '$.event_type') = 'offer_sent'
      ),
      resp AS (
        SELECT JSON_VALUE(data, '$.vacancy_id') AS vacancy_id, JSON_VALUE(JSON_VALUE(data, '$.payload'), '$.staff_id') AS staff_id,
               ANY_VALUE(JSON_VALUE(JSON_VALUE(data, '$.payload'), '$.status')) AS status
        FROM `${var.project_id}.${google_bigquery_dataset.analytics.dataset_id}.events_raw`
        WHERE JSON_VALUE(data, '$.synthetic') IS NULL AND JSON_VALUE(data, '$.event_type') = 'offer_responded'
        GROUP BY 1, 2
      )
      SELECT s.facility_id, JSON_VALUE(s.p, '$.ab.arm') AS arm, JSON_VALUE(s.p, '$.ab.model_kind') AS model_kind,
             JSON_VALUE(s.p, '$.ab.model_version') AS model_version,
             COUNT(*) AS offers, COUNT(DISTINCT s.vacancy_id) AS vacancies,
             COUNTIF(r.status IS NOT NULL) AS responded, COUNTIF(r.status = 'accepted') AS accepted,
             SAFE_DIVIDE(COUNTIF(r.status = 'accepted'), COUNTIF(r.status IS NOT NULL)) AS accept_rate,
             COUNTIF(r.status = 'accepted' AND CAST(JSON_VALUE(s.p, '$.rank') AS INT64) = 1) AS accepted_at_first_offer,
             MIN(s.publish_time) AS first_offer_at, MAX(s.publish_time) AS last_offer_at
      FROM sent s
      LEFT JOIN resp r ON r.vacancy_id = s.vacancy_id AND r.staff_id = JSON_VALUE(s.p, '$.staff_id')
      WHERE JSON_VALUE(s.p, '$.ab.arm') IS NOT NULL
      GROUP BY 1, 2, 3, 4
    SQL
  }
}

output "care_learn_scheduler" {
  value = google_cloud_scheduler_job.care_learn_daily.id
}
