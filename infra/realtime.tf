# リアルタイムの学習データ: Firestore の欠員・打診の書き込み → Eventarc（Firestore トリガー）→ Cloud Run 関数 care-ml-stream → BigQuery *_stream
# 週次の学習（Vertex AI Pipelines）は従来どおり fact_offers（合成）+ events_raw（ライブ）を読む。*_stream は学習の入力にはまだ使っていない
# （fact_* に直接書くと、SYNTH_OFFERS_SQL がライブの行まで synthetic として読むため、別の表にしている）。
# 関数のコードは functions/ml_stream/。イメージは README の手順で Cloud Build から作る（Terraform はイメージを戻さない）。

variable "ml_stream_image" {
  type    = string
  default = "asia-northeast1-docker.pkg.dev/gdgoc-514203/cloud-run-source-deploy/care-ml-stream:v1"
}

resource "google_project_service" "realtime" {
  for_each           = toset(["eventarc.googleapis.com", "eventarcpublishing.googleapis.com"])
  service            = each.key
  disable_on_destroy = false
}

locals {
  ml_dataset = "care_ml" # ml.tf の google_bigquery_dataset.ml（参照すると -target でデータセットまで対象に入るので名前で書く）
  stream_extra_cols = [
    { name = "state", type = "STRING", mode = "NULLABLE", description = "Firestore の文書の状態（欠員: open/offering/filled/replanned、打診: status）" },
    { name = "source", type = "STRING", mode = "REQUIRED", description = "live（API・画面からの実運用）/ synthetic（文書に synthetic が付いたもの）。steps.py と同じ区別" },
    { name = "op", type = "STRING", mode = "REQUIRED", description = "created / updated / deleted" },
    { name = "doc_path", type = "STRING", mode = "REQUIRED", description = "Firestore の文書のパス（facilities/...）" },
    { name = "event_id", type = "STRING", mode = "REQUIRED", description = "CloudEvent の id（重複除去のキー）" },
    { name = "event_time", type = "TIMESTAMP", mode = "NULLABLE", description = "Firestore の書き込みの時刻" },
    { name = "ingested_at", type = "TIMESTAMP", mode = "REQUIRED", description = "BigQuery に追記した時刻" },
  ]
  # fact_vacancies / fact_offers と同じ列（2026-11-10 に bq show で確認）
  fact_vacancies_cols = [
    { name = "vacancy_id", type = "STRING", mode = "NULLABLE" }, { name = "facility_id", type = "STRING", mode = "NULLABLE" },
    { name = "date", type = "DATE", mode = "NULLABLE" }, { name = "shift", type = "STRING", mode = "NULLABLE" },
    { name = "unit_id", type = "STRING", mode = "NULLABLE" }, { name = "need_skills", type = "STRING", mode = "REPEATED" },
    { name = "reason", type = "STRING", mode = "NULLABLE" }, { name = "absent_staff_id", type = "STRING", mode = "NULLABLE" },
    { name = "discovered_at", type = "TIMESTAMP", mode = "NULLABLE" }, { name = "lead_hours", type = "FLOAT", mode = "NULLABLE" },
    { name = "final_route", type = "STRING", mode = "NULLABLE" }, { name = "filled_by", type = "STRING", mode = "NULLABLE" },
    { name = "filled_at", type = "TIMESTAMP", mode = "NULLABLE" }, { name = "n_offers", type = "INTEGER", mode = "NULLABLE" },
  ]
  fact_offers_cols = [
    { name = "offer_id", type = "STRING", mode = "NULLABLE" }, { name = "vacancy_id", type = "STRING", mode = "NULLABLE" },
    { name = "facility_id", type = "STRING", mode = "NULLABLE" }, { name = "staff_id", type = "STRING", mode = "NULLABLE" },
    { name = "rank", type = "INTEGER", mode = "NULLABLE" }, { name = "offered_at", type = "TIMESTAMP", mode = "NULLABLE" },
    { name = "responded_at", type = "TIMESTAMP", mode = "NULLABLE" }, { name = "status", type = "STRING", mode = "NULLABLE" },
    { name = "response_min", type = "FLOAT", mode = "NULLABLE" }, { name = "lead_hours", type = "FLOAT", mode = "NULLABLE" },
    { name = "weekday", type = "INTEGER", mode = "NULLABLE" }, { name = "shift", type = "STRING", mode = "NULLABLE" },
    { name = "same_unit", type = "BOOLEAN", mode = "NULLABLE" }, { name = "skill_match", type = "BOOLEAN", mode = "NULLABLE" },
    { name = "consec_before", type = "INTEGER", mode = "NULLABLE" }, { name = "month_hours_before", type = "FLOAT", mode = "NULLABLE" },
    { name = "nights_last30", type = "INTEGER", mode = "NULLABLE" }, { name = "offers_last14", type = "INTEGER", mode = "NULLABLE" },
    { name = "tenure_years", type = "INTEGER", mode = "NULLABLE" }, { name = "employment", type = "STRING", mode = "NULLABLE" },
  ]
  streams = {
    vacancies = { table = "fact_vacancies_stream", cols = local.fact_vacancies_cols, key = "vacancy_id", pattern = "facilities/{fid}/vacancies/{vid}" }
    offers    = { table = "fact_offers_stream", cols = local.fact_offers_cols, key = "offer_id", pattern = "facilities/{fid}/vacancies/{vid}/offers/{oid}" }
  }
}

# 変更の履歴（1 書き込み = 1 行）
resource "google_bigquery_table" "stream" {
  for_each            = local.streams
  dataset_id          = local.ml_dataset
  table_id            = each.value.table
  description         = "Firestore の ${each.key} の書き込みの履歴（Eventarc → care-ml-stream）。最新の状態は ${each.value.table}_latest"
  deletion_protection = false
  time_partitioning {
    type  = "DAY"
    field = "ingested_at"
  }
  clustering = ["facility_id", "source"]
  schema     = jsonencode(concat(each.value.cols, local.stream_extra_cols))
}

# 文書ごとの最新の状態（削除されたものは除く）。学習に使うときは source = 'live' で絞る
resource "google_bigquery_table" "stream_latest" {
  for_each            = local.streams
  dataset_id          = local.ml_dataset
  table_id            = "${each.value.table}_latest"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = <<-SQL
      SELECT * EXCEPT (rn) FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY doc_path ORDER BY event_time DESC, ingested_at DESC) AS rn
        FROM `${var.project_id}.${local.ml_dataset}.${each.value.table}`
      )
      WHERE rn = 1 AND op != 'deleted'
    SQL
  }
  depends_on = [google_bigquery_table.stream]
}

# ---------------------------------------------------------------- 関数（Cloud Run）

resource "google_service_account" "ml_stream" {
  account_id   = "care-ml-stream-sa"
  display_name = "care-ml-stream runtime（Firestore → BigQuery *_stream）"
}

# 最小権限: 2 つの *_stream 表への追記だけ（データセットの他の表には書けない）
resource "google_bigquery_table_iam_member" "ml_stream_write" {
  for_each   = local.streams
  dataset_id = local.ml_dataset
  table_id   = google_bigquery_table.stream[each.key].table_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.ml_stream.email}"
}

resource "google_cloud_run_v2_service" "ml_stream" {
  name                = "care-ml-stream"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY" # Eventarc（Pub/Sub の push）からだけ受ける
  deletion_protection = false
  template {
    service_account = google_service_account.ml_stream.email
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    timeout                          = "30s"
    max_instance_request_concurrency = 20
    containers {
      image = var.ml_stream_image
      env {
        name  = "BQ_PROJECT"
        value = var.project_id
      }
      env {
        name  = "BQ_DATASET"
        value = local.ml_dataset
      }
      resources {
        limits   = { cpu = "1", memory = "512Mi" }
        cpu_idle = true
      }
    }
  }
  lifecycle {
    ignore_changes = [client, client_version, scaling]
  }
  depends_on = [google_bigquery_table_iam_member.ml_stream_write]
}

# ---------------------------------------------------------------- Eventarc（Firestore トリガー・asia-northeast1）

resource "google_service_account" "ml_stream_trigger" {
  account_id   = "care-ml-stream-trigger"
  display_name = "Eventarc → care-ml-stream の呼び出し"
}

resource "google_project_iam_member" "ml_stream_trigger_receiver" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.ml_stream_trigger.email}"
}

resource "google_cloud_run_v2_service_iam_member" "ml_stream_invoker" {
  name     = google_cloud_run_v2_service.ml_stream.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.ml_stream_trigger.email}"
}

resource "google_eventarc_trigger" "ml_stream" {
  for_each        = local.streams
  name            = "care-ml-stream-${each.key}"
  location        = var.region # Firestore（asia-northeast1）と同じ場所でないと作れない
  service_account = google_service_account.ml_stream_trigger.email
  matching_criteria {
    attribute = "type"
    value     = "google.cloud.firestore.document.v1.written"
  }
  matching_criteria {
    attribute = "database"
    value     = "(default)"
  }
  matching_criteria {
    attribute = "document"
    value     = each.value.pattern
    operator  = "match-path-pattern"
  }
  event_data_content_type = "application/protobuf"
  destination {
    cloud_run_service {
      service = google_cloud_run_v2_service.ml_stream.name
      region  = var.region
      path    = "/"
    }
  }
  depends_on = [google_project_service.realtime, google_project_iam_member.ml_stream_trigger_receiver, google_cloud_run_v2_service_iam_member.ml_stream_invoker]
}

# ---------------------------------------------------------------- 監視

resource "google_logging_metric" "ml_stream_errors" {
  name        = "care_ml_stream_errors"
  description = "care-ml-stream が BigQuery に書けなかった（対象外のパス・列の不一致・一時的な失敗）"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="care-ml-stream"
    severity>=ERROR
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "ml_stream_errors" {
  display_name = "care-ml-stream: BigQuery への追記の失敗"
  combiner     = "OR"
  conditions {
    display_name = "エラーのログ > 0（10 分）"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ml_stream_errors.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "3600s" }
  documentation {
    content   = "Firestore → BigQuery（care_ml.*_stream）の追記が失敗している。学習の週次パイプラインには影響しない（*_stream はまだ学習の入力ではない）。設計: infra/realtime.tf、functions/ml_stream。"
    mime_type = "text/markdown"
  }
}

output "ml_stream_tables" {
  value = [for k, v in local.streams : "${var.project_id}.${local.ml_dataset}.${v.table}"]
}
