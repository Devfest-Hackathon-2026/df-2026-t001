terraform {
  required_version = ">= 1.9"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
  # state用バケットは手動で先に作成: gcloud storage buckets create gs://gdgoc-514203-tfstate -l asia-northeast1
  backend "gcs" {
    bucket = "gdgoc-514203-tfstate"
    prefix = "care"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  apis = [
    "aiplatform.googleapis.com", "firestore.googleapis.com", "firebase.googleapis.com",
    "firebasehosting.googleapis.com", "secretmanager.googleapis.com", "sts.googleapis.com",
    "pubsub.googleapis.com", "bigquery.googleapis.com", "run.googleapis.com",
    "artifactregistry.googleapis.com", "cloudbuild.googleapis.com", "iamcredentials.googleapis.com",
    "cloudresourcemanager.googleapis.com", "billingbudgets.googleapis.com",
    # v0.2: 学習パイプライン（週次起動）と個人情報マスク
    "cloudscheduler.googleapis.com", "dlp.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.key
  disable_on_destroy = false
}

# --- Firestore（業務データの正本）---
resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.apis]
}

# --- BigQuery（分析）+ Pub/Sub BigQuery subscription ---
resource "google_bigquery_dataset" "analytics" {
  dataset_id = "care_analytics"
  location   = var.region
  depends_on = [google_project_service.apis]
}

# Pub/Sub BigQuery subscription は topic schema 無しの場合 data 列にJSON文字列を書く。
# 生テーブル events_raw と、JSONを展開した分析用ビュー events を分ける。
resource "google_bigquery_table" "events_raw" {
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = "events_raw"
  deletion_protection = false
  time_partitioning {
    type  = "DAY"
    field = "publish_time"
  }
  schema = jsonencode([
    { name = "subscription_name", type = "STRING", mode = "NULLABLE" },
    { name = "message_id", type = "STRING", mode = "NULLABLE" },
    { name = "publish_time", type = "TIMESTAMP", mode = "NULLABLE" },
    { name = "data", type = "STRING", mode = "NULLABLE" },
    { name = "attributes", type = "STRING", mode = "NULLABLE" },
  ])
}

resource "google_bigquery_table" "events" {
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = "events"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = <<-SQL
      SELECT
        JSON_VALUE(data, '$.event_id')    AS event_id,
        JSON_VALUE(data, '$.event_type')  AS event_type,
        JSON_VALUE(data, '$.vacancy_id')  AS vacancy_id,
        JSON_VALUE(data, '$.facility_id') AS facility_id,
        publish_time                      AS ts,
        JSON_VALUE(data, '$.payload')     AS payload
      FROM `${var.project_id}.${google_bigquery_dataset.analytics.dataset_id}.events_raw`
    SQL
  }
  depends_on = [google_bigquery_table.events_raw]
}

resource "google_pubsub_topic" "events" {
  name       = "care-events"
  depends_on = [google_project_service.apis]
}

# Pub/Sub サービスエージェントに BigQuery 書き込み権限
data "google_project" "this" {}
resource "google_bigquery_dataset_iam_member" "pubsub_writer" {
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "events_to_bq" {
  name  = "care-events-to-bq"
  topic = google_pubsub_topic.events.id
  bigquery_config {
    table            = "${var.project_id}.${google_bigquery_dataset.analytics.dataset_id}.${google_bigquery_table.events_raw.table_id}"
    use_topic_schema = false
    write_metadata   = true
  }
  depends_on = [google_bigquery_dataset_iam_member.pubsub_writer]
}

# --- Cloud Run 実行SA（最小権限）---
resource "google_service_account" "api" {
  account_id   = "care-api-sa"
  display_name = "care-api runtime"
}

resource "google_project_iam_member" "api_roles" {
  for_each = toset(["roles/datastore.user", "roles/aiplatform.user", "roles/pubsub.publisher", "roles/bigquery.jobUser"])
  project  = var.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.api.email}"
}

resource "google_bigquery_dataset_iam_member" "api_read" {
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.api.email}"
}

# --- Cloud Run care-api（イメージはCIが更新するため ignore）---
resource "google_cloud_run_v2_service" "api" {
  name                = "care-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  template {
    service_account = google_service_account.api.email
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    timeout                          = "60s"
    max_instance_request_concurrency = 40
    containers {
      image = var.api_image
      env {
        name  = "STORE_BACKEND"
        value = "firestore"
      }
      env {
        name  = "AI_ENABLED"
        value = "1"
      }
      env {
        name  = "PUBSUB_TOPIC"
        value = google_pubsub_topic.events.name
      }
      env {
        name  = "REQUIRE_AUTH"
        value = "1"
      }
      env {
        name  = "AI_DAILY_LIMIT"
        value = tostring(var.ai_daily_limit)
      }
      env {
        name  = "GEMINI_MODEL"
        value = var.gemini_model
      }
      env {
        name  = "GEMINI_FAST_MODEL"
        value = var.gemini_fast_model
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
  depends_on = [google_project_service.apis]
}

# 一般公開（ハッカソンデモ・ユーザー確認済み）
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- GitHub Actions 用 Workload Identity Federation（鍵なし）---
resource "google_service_account" "deployer" {
  account_id   = "gh-deployer"
  display_name = "GitHub Actions deployer"
}

resource "google_iam_workload_identity_pool" "gh" {
  workload_identity_pool_id = "github"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "gh" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.gh.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  # 指定リポジトリの main ブランチからの実行のみ許可（PRや他ブランチは不可）
  attribute_condition = "assertion.repository == '${var.github_repo}' && assertion.ref == 'refs/heads/main'"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.gh.name}/attribute.repository/${var.github_repo}"
}

resource "google_project_iam_member" "deployer_roles" {
  # 最小権限: run.developer（IAM変更不可）、serviceAccountUser/ソースバケットは対象を限定
  for_each = toset(["roles/run.developer", "roles/artifactregistry.writer", "roles/cloudbuild.builds.editor", "roles/firebasehosting.admin", "roles/serviceusage.serviceUsageConsumer", "roles/firebaserules.admin"])
  project  = var.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_service_account_iam_member" "deployer_act_as_api" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# Cloud Build のソースアップロード先バケットのみに書き込み権限を限定
resource "google_storage_bucket_iam_member" "deployer_cloudbuild_src" {
  bucket = "${var.project_id}_cloudbuild"
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deployer.email}"
}

# gcloud builds submit はバケットのメタデータ取得(buckets.get)も必要
resource "google_storage_bucket_iam_member" "deployer_cloudbuild_src_read" {
  bucket = "${var.project_id}_cloudbuild"
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.deployer.email}"
}
