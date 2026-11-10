# 分析用のビュー・時系列予測（BigQuery ML の ARIMA_PLUS）・週次の再学習（スケジュールドクエリ）。
# SQL は infra/sql/*.sql。ビュー名・列名は Looker Studio でそのまま使える分かりやすい名前にしている。
# データは合成（架空）の履歴を含む。既存のテーブル・権限には触れない（足すだけ）。

locals {
  # care_ml（業務の履歴 fact_* / dim_*、学習の記録 model_runs）の上のビュー。依存のあるものは後で別に作る
  ml_views = {
    v_vacancies                = "欠員 1 件ごとの明細（曜日・勤務帯・充足までの分・どう埋まったか）"
    v_offer_acceptance_monthly = "打診の応諾率の推移（月 × 雇用形態 × 勤続年数の帯）"
    v_model_runs               = "応諾予測モデルの学習ごとの精度（AUC・対数損失・昇格）"
    v_vacancy_daily            = "施設 × 日ごとの欠員数（0 埋め）。時系列予測の学習データ"
  }
  ml_views_on_vacancies = {
    v_vacancy_slots   = "施設 × 曜日 × 勤務帯ごとの欠員数と充足までの時間"
    v_vacancy_monthly = "施設 × 月ごとの欠員数と充足までの時間の推移"
    v_vacancy_weekly  = "施設 × 週（日曜始まり）ごとの欠員数。時系列予測の学習データ"
  }
  # care_analytics（Pub/Sub から入る業務イベント events_raw）の上のビュー
  analytics_views = {
    v_ai_usage     = "AI（Gemini）呼び出し 1 回ごとのトークン数と応答時間"
    v_solver_runs  = "ソルバー（CP-SAT）の実行 1 回ごとの所要時間と結果"
    v_events_daily = "業務イベントの日別件数（日 × 施設 × 種類）"
  }
  forecast_model_sql = templatefile("${path.module}/sql/m_vacancy_forecast.sql", { project = var.project_id })
}

resource "google_bigquery_table" "ml_views" {
  for_each            = local.ml_views
  dataset_id          = google_bigquery_dataset.ml.dataset_id
  table_id            = each.key
  description         = "${each.value}（合成データを含む）"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = templatefile("${path.module}/sql/${each.key}.sql", { project = var.project_id })
  }
}

resource "google_bigquery_table" "ml_views_on_vacancies" {
  for_each            = local.ml_views_on_vacancies
  dataset_id          = google_bigquery_dataset.ml.dataset_id
  table_id            = each.key
  description         = "${each.value}（合成データを含む）"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = templatefile("${path.module}/sql/${each.key}.sql", { project = var.project_id })
  }
  depends_on = [google_bigquery_table.ml_views]
}

resource "google_bigquery_table" "analytics_views" {
  for_each            = local.analytics_views
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = each.key
  description         = each.value
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = templatefile("${path.module}/sql/${each.key}.sql", { project = var.project_id })
  }
}

resource "google_bigquery_table" "ai_usage_daily" {
  dataset_id          = google_bigquery_dataset.analytics.dataset_id
  table_id            = "v_ai_usage_daily"
  description         = "AI の利用状況（日 × 機能 × モデル）：回数・トークン・応答時間"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = templatefile("${path.module}/sql/v_ai_usage_daily.sql", { project = var.project_id })
  }
  depends_on = [google_bigquery_table.analytics_views]
}

# --- 時系列予測: 施設ごとの日別の欠員数（ARIMA_PLUS）---
# 初回の学習は Terraform のジョブで行う（SQL を変えると job_id が変わり、学習し直す）。以後は下のスケジュールドクエリが毎週学習し直す。
# 注意: プロバイダーはジョブの完了を待たない。まっさらな環境では v_vacancy_forecast の作成が「Model not found」で失敗するので、
#       学習（数秒〜1 分）が終わってからもう一度 apply する。
resource "google_bigquery_job" "vacancy_forecast_model" {
  job_id   = "tf_vacancy_forecast_${substr(sha1(local.forecast_model_sql), 0, 12)}"
  location = var.region
  query {
    query              = local.forecast_model_sql
    use_legacy_sql     = false
    create_disposition = ""
    write_disposition  = ""
  }
  depends_on = [google_bigquery_table.ml_views_on_vacancies]
}

resource "google_bigquery_table" "vacancy_forecast" {
  dataset_id          = google_bigquery_dataset.ml.dataset_id
  table_id            = "v_vacancy_forecast"
  description         = "施設ごとの今後 8 週の欠員数の予測（週別・80% 予測区間、ARIMA_PLUS）。合成データで学習"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = templatefile("${path.module}/sql/v_vacancy_forecast.sql", { project = var.project_id })
  }
  depends_on = [google_bigquery_job.vacancy_forecast_model]
}

resource "google_bigquery_table" "vacancy_weekly_outlook" {
  dataset_id          = google_bigquery_dataset.ml.dataset_id
  table_id            = "v_vacancy_weekly_outlook"
  description         = "週ごと（日曜始まり）の欠員数：実績（直近 12 週）と予測（今後 8 週）。合成データで学習"
  deletion_protection = false
  view {
    use_legacy_sql = false
    query          = templatefile("${path.module}/sql/v_vacancy_weekly_outlook.sql", { project = var.project_id })
  }
  depends_on = [google_bigquery_table.vacancy_forecast]
}

# 毎週月曜 03:00 JST（日曜 18:00 UTC）に予測モデルを学習し直す。実行は学習用 SA（care_ml の dataEditor・jobUser を持つ）
resource "google_bigquery_data_transfer_config" "vacancy_forecast_retrain" {
  display_name         = "care: 欠員数の予測モデルを週次で再学習"
  location             = var.region
  data_source_id       = "scheduled_query"
  schedule             = "every sunday 18:00"
  service_account_name = google_service_account.pipeline.email
  params = {
    query = local.forecast_model_sql
  }
  depends_on = [google_bigquery_job.vacancy_forecast_model]
}

# --- API（care-solver-sa）が分析ビューを読み取り専用で引く。care_ml の dataViewer は solver.tf で付与済み ---
resource "google_bigquery_dataset_iam_member" "solver_analytics_read" {
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.solver.email}"
}
