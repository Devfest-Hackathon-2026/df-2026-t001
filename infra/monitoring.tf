# 監視（Cloud Monitoring）: care-solver-api の稼働目標（SLO）・アラート・ログベースの指標・ダッシュボード・Uptime check
# 通知チャネルは作らない（宛先は未定）。アラートはコンソールの「インシデント」に出る。チャネルを足すときは notification_channels に追記する。

# 既存の Cloud Run・サブスクリプションは名前で参照する（resource を参照すると -target の適用で既存のサービスまで更新対象に入るため）
data "google_cloud_run_v2_service" "solver_live" {
  name     = "care-solver-api"
  location = var.region
}

locals {
  solver_service = data.google_cloud_run_v2_service.solver_live.name
  solver_host    = trimprefix(data.google_cloud_run_v2_service.solver_live.uri, "https://")
  events_sub     = "care-events-to-bq"
  # Cloud Run の指標の共通の絞り込み
  solver_run_filter = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"care-solver-api\""
  # AI の呼び出し（翻訳・説明・チャット・意図の解釈）。solver-api/care/guard.py の is_ai と同じ
  ai_path_regex = "/(rules/translate|explain|chat|plan-intent|leader-intent|employee-intent)$"
}

resource "google_project_service" "monitoring" {
  for_each           = toset(["monitoring.googleapis.com", "logging.googleapis.com"])
  service            = each.key
  disable_on_destroy = false
}

# ---------------------------------------------------------------- ログベースの指標

# AI の呼び出しが 429（上限）・503（Gemini・DLP の失敗）で終わった回数。Cloud Run のリクエストログから数える
resource "google_logging_metric" "ai_rejected" {
  name        = "care_solver_ai_rejected"
  description = "care-solver-api の AI 呼び出しのうち 429（利用上限）・503（Gemini・DLP の失敗）で終わったもの"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.solver_service}"
    logName="projects/${var.project_id}/logs/run.googleapis.com%2Frequests"
    httpRequest.requestMethod="POST"
    httpRequest.requestUrl=~"${local.ai_path_regex}"
    (httpRequest.status=429 OR httpRequest.status=503)
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "HTTP ステータス"
    }
  }
  label_extractors = { status = "EXTRACT(httpRequest.status)" }
  depends_on       = [google_project_service.monitoring]
}

# 個人情報マスク（DLP）の失敗。アプリのログ（標準出力・標準エラー）にマスク失敗の文言か DLP のエラーが出たもの。
# 注: 現行のアプリは DLP の失敗を 503 の本文で返すだけでログに出さないことがある。API 側の失敗は下の dlp_api_errors（消費側の指標）でも見る。
resource "google_logging_metric" "dlp_failures" {
  name        = "care_solver_dlp_failures"
  description = "care-solver-api のログに出た、個人情報マスク（Sensitive Data Protection）の失敗"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.solver_service}"
    NOT logName="projects/${var.project_id}/logs/run.googleapis.com%2Frequests"
    (textPayload:"個人情報のマスクに失敗" OR jsonPayload.message:"個人情報のマスクに失敗" OR textPayload=~"(?i)dlp.*(error|denied|exhausted|unavailable)")
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
  depends_on = [google_project_service.monitoring]
}

# 求解の混雑（同時求解の上限で 503 を返した回数）。スケールの目安
resource "google_logging_metric" "solver_busy" {
  name        = "care_solver_busy"
  description = "care-solver-api が求解・組み直しの同時実行の上限で 503 を返した回数"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name="${local.solver_service}"
    logName="projects/${var.project_id}/logs/run.googleapis.com%2Frequests"
    httpRequest.status=503
    httpRequest.requestUrl=~"/(solve|solve-inline|replan|replan-inline)$"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
  depends_on = [google_project_service.monitoring]
}

# ---------------------------------------------------------------- 稼働目標（SLO）

resource "google_monitoring_service" "solver" {
  service_id   = "care-solver-api"
  display_name = "care-solver-api（Cloud Run）"
  basic_service {
    service_type = "CLOUD_RUN"
    service_labels = {
      service_name = local.solver_service
      location     = var.region
    }
  }
  depends_on = [google_project_service.monitoring]
}

# 可用性: 5xx 以外の応答の割合が 7 日間で 99% 以上
resource "google_monitoring_slo" "solver_availability" {
  service             = google_monitoring_service.solver.service_id
  slo_id              = "availability-99"
  display_name        = "可用性 99%（7 日間・5xx 以外）"
  goal                = 0.99
  rolling_period_days = 7
  request_based_sli {
    good_total_ratio {
      total_service_filter = "metric.type=\"run.googleapis.com/request_count\" ${local.solver_run_filter}"
      bad_service_filter   = "metric.type=\"run.googleapis.com/request_count\" ${local.solver_run_filter} metric.labels.response_code_class=\"5xx\""
    }
  }
}

# 応答時間: 95% のリクエストが 8 秒以内（7 日間）。実測（2 日間）は p50 0.07 秒・p95 4.4 秒・p99 18 秒（AI と求解が長い）
resource "google_monitoring_slo" "solver_latency" {
  service             = google_monitoring_service.solver.service_id
  slo_id              = "latency-8s-95"
  display_name        = "応答時間 95% が 8 秒以内（7 日間）"
  goal                = 0.95
  rolling_period_days = 7
  request_based_sli {
    distribution_cut {
      distribution_filter = "metric.type=\"run.googleapis.com/request_latencies\" ${local.solver_run_filter}"
      range {
        min = 0
        max = 8000
      }
    }
  }
}

# ---------------------------------------------------------------- Uptime check

resource "google_monitoring_uptime_check_config" "solver_healthz" {
  display_name = "care-solver-api /api/healthz（run.app）"
  timeout      = "10s"
  period       = "300s"
  http_check {
    path           = "/api/healthz"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }
  content_matchers {
    content = "\"ok\":true"
    matcher = "CONTAINS_STRING"
  }
  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.solver_host
    }
  }
  depends_on = [google_project_service.monitoring]
}

# ---------------------------------------------------------------- アラート（通知チャネルなし）

locals {
  alert_doc_suffix = "対象: Cloud Run care-solver-api（${var.region}）。設計: infra/monitoring.tf。デモ中は公開 URL（run.app）を優先して確認する。"
}

resource "google_monitoring_alert_policy" "uptime" {
  display_name = "care-solver-api: /api/healthz が応答しない"
  combiner     = "OR"
  conditions {
    display_name = "Uptime check の失敗（2 地域以上・10 分）"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" resource.type=\"uptime_url\" metric.labels.check_id=\"${google_monitoring_uptime_check_config.solver_healthz.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "1200s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.*"]
      }
      trigger { count = 1 }
    }
  }
  documentation {
    content   = "ヘルスチェック（/api/healthz）が複数の地域から失敗している。Cloud Run のリビジョンとログを確認する。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "error_ratio" {
  display_name = "care-solver-api: 5xx の割合が 5% を超えた"
  combiner     = "OR"
  conditions {
    display_name = "5xx / 全リクエスト > 5%（5 分）"
    condition_threshold {
      filter             = "metric.type=\"run.googleapis.com/request_count\" ${local.solver_run_filter} metric.labels.response_code_class=\"5xx\""
      denominator_filter = "metric.type=\"run.googleapis.com/request_count\" ${local.solver_run_filter}"
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.05
      duration           = "300s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "1800s" }
  documentation {
    content   = "5xx が増えている。503 は求解の混雑（care_solver_busy）か AI（care_solver_ai_rejected）のことが多い。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "latency_p95" {
  display_name = "care-solver-api: p95 応答時間が 15 秒を超えた"
  combiner     = "OR"
  conditions {
    display_name = "p95 > 15 秒（10 分）"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_latencies\" ${local.solver_run_filter}"
      comparison      = "COMPARISON_GT"
      threshold_value = 15000
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "1800s" }
  documentation {
    content   = "応答が遅い。求解（最大 10 秒）と AI（Gemini）が長い呼び出し。コールドスタートと同時求解の上限を確認する。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "instances_at_max" {
  display_name = "care-solver-api: インスタンス数が上限（3）に達した"
  combiner     = "OR"
  conditions {
    display_name = "インスタンス数 >= 3（5 分）"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/container/instance_count\" ${local.solver_run_filter}"
      comparison      = "COMPARISON_GT"
      threshold_value = 2.5
      duration        = "300s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "1800s" }
  documentation {
    content   = "最大インスタンス数（solver.tf の max_instance_count = 3）に張り付いている。混雑の 503 が増える。上限を上げるかは統合担当が判断する。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "ai_rejected" {
  display_name = "care-solver-api: AI の 429/503 が続いている"
  combiner     = "OR"
  conditions {
    display_name = "AI 呼び出しの 429/503 > 5 回（10 分）"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_rejected.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 5
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
    content   = "AI が上限（AI_DAILY_LIMIT / AI_IP_DAILY_LIMIT）か Gemini・DLP の失敗で断っている。status ラベルで 429 と 503 を見分ける。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "dlp_failures" {
  display_name = "care-solver-api: 個人情報マスク（DLP）の失敗"
  combiner     = "OR"
  conditions {
    display_name = "マスク失敗のログ > 0（5 分）"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.dlp_failures.name}\" resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
  conditions {
    display_name = "DLP API の 4xx/5xx > 0（5 分・消費側の指標）"
    condition_threshold {
      filter          = "metric.type=\"serviceruntime.googleapis.com/api/request_count\" resource.type=\"consumed_api\" resource.labels.service=\"dlp.googleapis.com\" metric.labels.response_code_class=one_of(\"4xx\",\"5xx\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "3600s" }
  documentation {
    content   = "DLP が失敗すると AI は呼ばれない（fail closed）。AI 画面は定型文に落ちる。DLP の API の有効化・権限（roles/dlp.user）・割り当てを確認する。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "pubsub_backlog" {
  display_name = "care-events: BigQuery への未配信がたまっている"
  combiner     = "OR"
  conditions {
    display_name = "未配信メッセージ > 100（10 分）"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" resource.type=\"pubsub_subscription\" resource.labels.subscription_id=\"${local.events_sub}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 100
      duration        = "600s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger { count = 1 }
    }
  }
  conditions {
    display_name = "最古の未確認メッセージが 15 分以上前"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/oldest_unacked_message_age\" resource.type=\"pubsub_subscription\" resource.labels.subscription_id=\"${local.events_sub}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 900
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "3600s" }
  documentation {
    content   = "業務イベント（care-events）が care_analytics.events_raw に書けていない。学習（REAL_OFFERS_SQL）が新しい打診を拾えなくなる。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "bq_subscription_failed" {
  display_name = "care-events-to-bq: BigQuery サブスクリプションの失敗"
  combiner     = "OR"
  conditions {
    display_name = "サブスクリプションの状態が ACTIVE 以外（権限・表の不一致など）"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/export_push_subscription_details\" resource.type=\"pubsub_subscription\" resource.labels.subscription_id=\"${local.events_sub}\" metric.labels.subscription_state!=\"ACTIVE\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger { count = 1 }
    }
  }
  conditions {
    display_name = "BigQuery への書き込みの失敗（ack 以外）> 0（5 分）"
    condition_threshold {
      filter          = "metric.type=\"pubsub.googleapis.com/subscription/push_request_count\" resource.type=\"pubsub_subscription\" resource.labels.subscription_id=\"${local.events_sub}\" metric.labels.response_class!=\"ack\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "3600s" }
  documentation {
    content   = "Pub/Sub の BigQuery サブスクリプション（care-events-to-bq）が書けていない。Pub/Sub サービスエージェントの権限と events_raw の列を確認する。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

# SLO の消費速度（1 時間で 7 日分の予算の 2% 以上を使う速さ = 消費速度 > 約 3.4 倍）
resource "google_monitoring_alert_policy" "slo_burn" {
  display_name = "care-solver-api: 稼働目標（SLO）の予算を急速に消費している"
  combiner     = "OR"
  conditions {
    display_name = "可用性 SLO の消費速度 > 4 倍（1 時間）"
    condition_threshold {
      filter          = "select_slo_burn_rate(\"${google_monitoring_slo.solver_availability.id}\", \"3600s\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 4
      duration        = "0s"
      trigger { count = 1 }
    }
  }
  conditions {
    display_name = "応答時間 SLO の消費速度 > 4 倍（1 時間）"
    condition_threshold {
      filter          = "select_slo_burn_rate(\"${google_monitoring_slo.solver_latency.id}\", \"3600s\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 4
      duration        = "0s"
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "3600s" }
  documentation {
    content   = "稼働目標の予算が速く減っている。5xx・応答時間のアラートとあわせて原因を見る。${local.alert_doc_suffix}"
    mime_type = "text/markdown"
  }
}

# ---------------------------------------------------------------- ダッシュボード

locals {
  dash_xy = {
    requests = {
      title   = "リクエスト数（応答コードの種類別・1 分あたり）"
      filter  = "metric.type=\"run.googleapis.com/request_count\" ${local.solver_run_filter}"
      aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group = ["metric.label.response_code_class"], plot = "STACKED_BAR"
    }
    latency = {
      title   = "応答時間 p50 / p95 / p99（ミリ秒）"
      filter  = "metric.type=\"run.googleapis.com/request_latencies\" ${local.solver_run_filter}"
      aligner = "ALIGN_DELTA", reducer = "REDUCE_PERCENTILE_95", group = [], plot = "LINE"
    }
    instances = {
      title   = "インスタンス数（上限 3）"
      filter  = "metric.type=\"run.googleapis.com/container/instance_count\" ${local.solver_run_filter}"
      aligner = "ALIGN_MAX", reducer = "REDUCE_SUM", group = ["metric.label.state"], plot = "STACKED_AREA"
    }
    cpu = {
      title   = "CPU 使用率（p95）"
      filter  = "metric.type=\"run.googleapis.com/container/cpu/utilizations\" ${local.solver_run_filter}"
      aligner = "ALIGN_PERCENTILE_95", reducer = "REDUCE_MAX", group = [], plot = "LINE"
    }
    ai = {
      title   = "AI の 429 / 503（10 分ごと）"
      filter  = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_rejected.name}\" resource.type=\"cloud_run_revision\""
      aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group = ["metric.label.status"], plot = "STACKED_BAR"
    }
    busy = {
      title   = "求解の混雑で 503（10 分ごと）"
      filter  = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.solver_busy.name}\" resource.type=\"cloud_run_revision\""
      aligner = "ALIGN_DELTA", reducer = "REDUCE_SUM", group = [], plot = "STACKED_BAR"
    }
    dlp = {
      title   = "DLP API の呼び出し（応答コードの種類別）"
      filter  = "metric.type=\"serviceruntime.googleapis.com/api/request_count\" resource.type=\"consumed_api\" resource.labels.service=\"dlp.googleapis.com\""
      aligner = "ALIGN_RATE", reducer = "REDUCE_SUM", group = ["metric.label.response_code_class"], plot = "STACKED_BAR"
    }
    pubsub = {
      title   = "care-events-to-bq の未配信メッセージ"
      filter  = "metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" resource.type=\"pubsub_subscription\" resource.labels.subscription_id=\"${local.events_sub}\""
      aligner = "ALIGN_MAX", reducer = "REDUCE_MAX", group = [], plot = "LINE"
    }
  }
  dash_order = ["requests", "latency", "instances", "cpu", "ai", "busy", "dlp", "pubsub"]
  dash_tiles = [for i, k in local.dash_order : {
    xPos   = (i % 2) * 24
    yPos   = 8 + floor(i / 2) * 16
    width  = 24
    height = 16
    widget = {
      title = local.dash_xy[k].title
      xyChart = {
        # API は空の legendTemplate・groupByFields を省いて返すので、空のときは書かない（書くと毎回の plan に差分が出る）
        dataSets = [for p in(k == "latency" ? ["50", "95", "99"] : ["-"]) : { for dk, dv in {
          plotType       = local.dash_xy[k].plot
          legendTemplate = p == "-" ? "" : "p${p}"
          timeSeriesQuery = { timeSeriesFilter = {
            filter = local.dash_xy[k].filter
            aggregation = { for ak, av in {
              alignmentPeriod    = contains(["ai", "busy"], k) ? "600s" : "60s"
              perSeriesAligner   = local.dash_xy[k].aligner
              crossSeriesReducer = p == "-" ? local.dash_xy[k].reducer : "REDUCE_PERCENTILE_${p}"
              groupByFields      = local.dash_xy[k].group
            } : ak => av if ak != "groupByFields" || length(av) > 0 }
          } }
        } : dk => dv if dk != "legendTemplate" || dv != "" }]
      }
    }
  }]
}

resource "google_monitoring_dashboard" "solver" {
  dashboard_json = jsonencode({
    displayName = "care-solver-api（夜勤欠員補充デモ）"
    mosaicLayout = {
      columns = 48
      # API は 0 の xPos・yPos を省いて返すので、0 の位置は書かない（書くと毎回の plan に差分が出る）
      tiles = [for t in concat([
        {
          xPos = 0, yPos = 0, width = 16, height = 8
          widget = { title = "可用性 SLO（残りの予算）", scorecard = {
            timeSeriesQuery = { timeSeriesFilter = { filter = "select_slo_budget_fraction(\"${google_monitoring_slo.solver_availability.id}\")" } }
            thresholds      = [{ value = 0.2, color = "YELLOW", direction = "BELOW" }, { value = 0.01, color = "RED", direction = "BELOW" }]
          } }
        },
        {
          xPos = 16, yPos = 0, width = 16, height = 8
          widget = { title = "応答時間 SLO（残りの予算）", scorecard = {
            timeSeriesQuery = { timeSeriesFilter = { filter = "select_slo_budget_fraction(\"${google_monitoring_slo.solver_latency.id}\")" } }
            thresholds      = [{ value = 0.2, color = "YELLOW", direction = "BELOW" }, { value = 0.01, color = "RED", direction = "BELOW" }]
          } }
        },
        {
          xPos   = 32, yPos = 0, width = 16, height = 8
          widget = { title = "アラート", alertChart = { name = google_monitoring_alert_policy.error_ratio.name } }
        },
      ], local.dash_tiles) : { for k, v in t : k => v if !contains(["xPos", "yPos"], k) || v != 0 }]
    }
  })
}

output "monitoring_dashboard" {
  value = "https://console.cloud.google.com/monitoring/dashboards/builder/${element(split("/", google_monitoring_dashboard.solver.id), 3)}?project=${var.project_id}"
}
