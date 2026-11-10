# v0.3 P3: CP-SAT ソルバー API（既存の care-api とは別サービス。care-api には触れない）

variable "solver_image" {
  type    = string
  default = "asia-northeast1-docker.pkg.dev/gdgoc-514203/cloud-run-source-deploy/care-solver-api:v7"
}

resource "google_service_account" "solver" {
  account_id   = "care-solver-sa"
  display_name = "care-solver-api runtime"
}

# 最小権限: Firestore の読み書き・業務イベントの発行・Gemini（Vertex AI）・個人情報マスク（Sensitive Data Protection）
# BigQuery は必要になったフェーズ（P5）で足す
resource "google_project_iam_member" "solver_roles" {
  for_each = toset(["roles/datastore.user", "roles/pubsub.publisher", "roles/aiplatform.user", "roles/dlp.user"])
  project  = var.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.solver.email}"
}

resource "google_cloud_run_v2_service" "solver" {
  name                = "care-solver-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  template {
    service_account = google_service_account.solver.email
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    timeout                          = "60s"
    max_instance_request_concurrency = 4
    containers {
      image = var.solver_image
      env {
        name  = "STORE"
        value = "firestore"
      }
      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }
      env {
        name  = "PUBSUB_TOPIC"
        value = google_pubsub_topic.events.name
      }
      env {
        name  = "SOLVER_WORKERS"
        value = "4"
      }
      env {
        name  = "SOLVE_CONCURRENCY"
        value = "2"
      }
      # 学習の成果物（champion モデル・反復検出の候補）の置き場。Pipelines が書き、API が読む
      env {
        name  = "MODEL_ROOT"
        value = "gs://${google_storage_bucket.pipeline_root.name}"
      }
      # AI（Gemini）: 翻訳=Pro、説明・チャット=Flash。モデル ID は preview 系を含むため環境変数で差し替えられる
      env {
        name  = "GEMINI_PRO_MODEL"
        value = "gemini-3.1-pro-preview"
      }
      env {
        name  = "GEMINI_FAST_MODEL"
        value = "gemini-3-flash-preview"
      }
      env {
        name  = "DLP_MODE"
        value = "required"
      }
      env {
        name  = "AI_DAILY_LIMIT"
        value = "600"
      }
      env {
        name  = "AI_IP_DAILY_LIMIT"
        value = "40"
      }
      resources {
        limits            = { cpu = "4", memory = "2Gi" }
        startup_cpu_boost = true
      }
    }
  }
  lifecycle {
    # イメージは CI（deploy-solver.yml）が差し替える。Terraform は戻さない（care-api と同じ扱い）
    ignore_changes = [client, client_version, template[0].containers[0].image]
  }
  depends_on = [google_project_service.apis, google_project_iam_member.solver_roles]
}

# 一般公開（審査用の公開デモ。乱用対策は API 側のレート制限・同時求解の上限・入力サイズの上限）
resource "google_cloud_run_v2_service_iam_member" "solver_public" {
  name     = google_cloud_run_v2_service.solver.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "solver_url" {
  value = google_cloud_run_v2_service.solver.uri
}

# v0.3 P5: 学習の成果物（モデル・反復検出の候補）は GCS から読み、チャットの集計は BigQuery を読み取り専用で引く
resource "google_storage_bucket_iam_member" "solver_models_read" {
  bucket = google_storage_bucket.pipeline_root.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.solver.email}"
}

resource "google_project_iam_member" "solver_bq_jobs" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.solver.email}"
}

resource "google_bigquery_dataset_iam_member" "solver_ml_read" {
  dataset_id = google_bigquery_dataset.ml.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.solver.email}"
}

# GitHub Actions（deploy-solver.yml）のデプロイ用 SA が、実行 SA（care-solver-sa）で Cloud Run を更新できるようにする
resource "google_service_account_iam_member" "deployer_act_as_solver" {
  service_account_id = google_service_account.solver.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
