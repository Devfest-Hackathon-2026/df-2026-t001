# 外部 HTTPS ロードバランサ + Cloud Armor（care-solver-api の前に置く、並行の新しい入口）
# 既存の run.app の URL と公開設定（allUsers の run.invoker・ingress=all）は変えない。画面をこちらへ切り替えるかは後で判断する。
# ドメインが無いので、LB の固定 IP から作る sslip.io のホスト名（例: 34-8-1-2.sslip.io）で Google マネージド証明書を発行する。

resource "google_project_service" "edge" {
  for_each           = toset(["compute.googleapis.com", "networkservices.googleapis.com"])
  service            = each.key
  disable_on_destroy = false
}

resource "google_compute_global_address" "edge" {
  name       = "care-edge-ip"
  depends_on = [google_project_service.edge]
}

locals {
  edge_host = "${replace(google_compute_global_address.edge.address, ".", "-")}.sslip.io"
}

# サーバーレス NEG: 既存の Cloud Run（care-solver-api）を名前で指す（Cloud Run 側の設定は変えない）
resource "google_compute_region_network_endpoint_group" "solver" {
  name                  = "care-solver-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = "care-solver-api"
  }
  depends_on = [google_project_service.edge]
}

# ---------------------------------------------------------------- Cloud Armor

locals {
  # 優先度は小さいほど先。一致して許可（allow・throttle の範囲内）になると以降は評価されないので、OWASP を先、レート制限を後に置く
  # OWASP の事前定義ルール（感度 1 = 誤検知の少ない基本の署名のみ）。AI のチャット・翻訳は日本語の自由文を送るので感度は上げない
  waf_rules = {
    1000 = "sqli-v33-stable"
    1001 = "xss-v33-stable"
    1002 = "lfi-v33-stable"
    1003 = "rfi-v33-stable"
    1004 = "rce-v33-stable"
    1005 = "methodenforcement-v33-stable"
    1006 = "scannerdetection-v33-stable"
    1007 = "protocolattack-v33-stable"
    1008 = "sessionfixation-v33-stable"
  }
}

resource "google_compute_security_policy" "edge" {
  name        = "care-edge-armor"
  description = "care-solver-api の前段: IP ごとのレート制限・OWASP 事前定義ルール・適応型保護"
  type        = "CLOUD_ARMOR"

  adaptive_protection_config {
    layer_7_ddos_defense_config {
      enable          = true
      rule_visibility = "STANDARD"
    }
  }

  advanced_options_config {
    json_parsing = "STANDARD" # JSON の本文を項目ごとに検査する（日本語の自由文の誤検知を減らす）
    log_level    = "VERBOSE"
  }

  # AI（Gemini）の呼び出し: IP ごとに 1 分 20 回まで（アプリ側は 1 分 10 回・1 日の上限あり。こちらは手前の粗い防波堤）
  rule {
    priority    = 2000
    action      = "throttle"
    description = "AI の呼び出し: IP ごとに 20 回/分"
    match {
      expr {
        expression = "request.method == 'POST' && request.path.matches('^/api/v1/.*(?:translate|explain|chat|plan-intent|leader-intent|employee-intent)$')"
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 20
        interval_sec = 60
      }
    }
  }

  # 求解・組み直し（CPU を使う）: IP ごとに 1 分 30 回まで（アプリ側は 6 回/分）
  rule {
    priority    = 2100
    action      = "throttle"
    description = "求解・組み直し: IP ごとに 30 回/分"
    match {
      expr {
        expression = "request.method == 'POST' && request.path.matches('^/api/v1/.*(?:solve|solve-inline|replan|replan-inline)$')"
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 30
        interval_sec = 60
      }
    }
  }

  dynamic "rule" {
    for_each = local.waf_rules
    content {
      priority    = rule.key
      action      = "deny(403)"
      description = "OWASP: ${rule.value}"
      match {
        expr {
          expression = "evaluatePreconfiguredWaf('${rule.value}', {'sensitivity': 1})"
        }
      }
    }
  }

  # 全体: IP ごとに 1 分 300 回を超えたら 429、1 分 1200 回を超えたら 5 分間締め出す
  rule {
    priority    = 9000
    action      = "rate_based_ban"
    description = "全体: IP ごとに 300 回/分で 429、1200 回/分で 5 分 BAN"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = 300
        interval_sec = 60
      }
      ban_threshold {
        count        = 1200
        interval_sec = 60
      }
      ban_duration_sec = 300
    }
  }

  rule {
    priority    = 2147483647
    action      = "allow"
    description = "既定: 許可"
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

# ---------------------------------------------------------------- ロードバランサ

resource "google_compute_backend_service" "solver" {
  name                  = "care-solver-backend"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.edge.id
  backend {
    group = google_compute_region_network_endpoint_group.solver.id
  }
  log_config {
    enable      = true
    sample_rate = 1.0
  }
}

resource "google_compute_url_map" "edge" {
  name            = "care-edge"
  default_service = google_compute_backend_service.solver.id
}

resource "google_compute_managed_ssl_certificate" "edge" {
  name = "care-edge-cert"
  managed {
    domains = [local.edge_host]
  }
  lifecycle { create_before_destroy = true }
}

resource "google_compute_target_https_proxy" "edge" {
  name             = "care-edge-https"
  url_map          = google_compute_url_map.edge.id
  ssl_certificates = [google_compute_managed_ssl_certificate.edge.id]
}

resource "google_compute_global_forwarding_rule" "edge_https" {
  name                  = "care-edge-https"
  ip_address            = google_compute_global_address.edge.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.edge.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# HTTP は HTTPS へ転送する
resource "google_compute_url_map" "edge_redirect" {
  name = "care-edge-redirect"
  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}

resource "google_compute_target_http_proxy" "edge_redirect" {
  name    = "care-edge-http"
  url_map = google_compute_url_map.edge_redirect.id
}

resource "google_compute_global_forwarding_rule" "edge_http" {
  name                  = "care-edge-http"
  ip_address            = google_compute_global_address.edge.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.edge_redirect.id
  load_balancing_scheme = "EXTERNAL_MANAGED"
}

# 新しい入口の死活監視（アラートは run.app 側だけ。こちらは切り替えを決めたらアラートを足す）
resource "google_monitoring_uptime_check_config" "edge_healthz" {
  display_name = "care-solver-api /api/healthz（LB + Cloud Armor）"
  timeout      = "10s"
  period       = "300s"
  http_check {
    path         = "/api/healthz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
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
      host       = local.edge_host
    }
  }
  depends_on = [google_compute_global_forwarding_rule.edge_https]
}

output "edge_url" {
  value = "https://${local.edge_host}"
}
