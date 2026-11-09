# v0.2 P0: 学習ループ基盤（Vertex AI Pipelines / 特徴量・予測・埋め込み用データセット）

# 特徴量・予測・埋め込みは分析イベントと分けて管理する
resource "google_bigquery_dataset" "ml" {
  dataset_id  = "care_ml"
  location    = var.region
  description = "features / predictions / embeddings（学習・推論用）"
  depends_on  = [google_project_service.apis]
}

# Pipelines のルート。ステージングのみで、古い成果物は自動削除する
resource "google_storage_bucket" "pipeline_root" {
  name                        = "${var.project_id}-vertex-pipelines"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
  # 実行ごとの中間成果物だけを30日で消す。champion モデル（models/）と反復検出の候補（learned/）は残す
  lifecycle_rule {
    condition {
      age            = 30
      matches_prefix = ["runs/", "pipeline_root/"]
    }
    action { type = "Delete" }
  }
  depends_on = [google_project_service.apis]
}

resource "google_service_account" "pipeline" {
  account_id   = "pipeline-sa"
  display_name = "Vertex AI Pipelines runner"
}

resource "google_project_iam_member" "pipeline_roles" {
  for_each = toset(["roles/aiplatform.user", "roles/bigquery.jobUser"])
  project  = var.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.pipeline.email}"
}

resource "google_bigquery_dataset_iam_member" "pipeline_ml_write" {
  dataset_id = google_bigquery_dataset.ml.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:${google_service_account.pipeline.email}"
}

# 特徴量の元になるイベントは読み取りのみ
resource "google_bigquery_dataset_iam_member" "pipeline_analytics_read" {
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.pipeline.email}"
}

resource "google_storage_bucket_iam_member" "pipeline_root_admin" {
  bucket = google_storage_bucket.pipeline_root.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.pipeline.email}"
}

# API が予測結果を読み、Gemini 用の記憶に使う
resource "google_bigquery_dataset_iam_member" "api_ml_read" {
  dataset_id = google_bigquery_dataset.ml.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.api.email}"
}

# Pipelines のコンポーネント（トレーナーイメージ）を Artifact Registry から取得する
resource "google_project_iam_member" "pipeline_ar_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.pipeline.email}"
}

# 個人情報マスク（Sensitive Data Protection）を API から呼ぶ
resource "google_project_iam_member" "api_dlp" {
  project = var.project_id
  role    = "roles/dlp.user"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# Scheduler → Pipelines 起動用。pipeline-sa に成り代わる権限
resource "google_service_account_iam_member" "pipeline_self_act_as" {
  service_account_id = google_service_account.pipeline.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.pipeline.email}"
}
