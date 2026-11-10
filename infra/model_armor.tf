# Model Armor: Gemini に渡す前の入力と、返ってきた出力の検査（solver-api/care/ai/armor.py）。
# API 側は環境変数 MODEL_ARMOR_TEMPLATE=care-ai-guard（場所は asia-northeast1）で有効になる。未設定なら使わない。
# 適用: terraform apply -lock-timeout=15m -target=google_project_service.modelarmor -target=google_model_armor_template.care_ai -target=google_project_iam_member.solver_modelarmor

resource "google_project_service" "modelarmor" {
  service            = "modelarmor.googleapis.com"
  disable_on_destroy = false
}

resource "google_model_armor_template" "care_ai" {
  location    = var.region
  template_id = "care-ai-guard"
  labels      = { app = "care-connect", purpose = "gemini-guard" }

  filter_config {
    # プロンプトインジェクション・ジェイルブレイク
    pi_and_jailbreak_filter_settings {
      filter_enforcement = "ENABLED"
      confidence_level   = "MEDIUM_AND_ABOVE"
    }
    # 有害な内容（ヘイト・嫌がらせ・性的・危険）
    rai_settings {
      rai_filters {
        filter_type      = "HATE_SPEECH"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "HARASSMENT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "SEXUALLY_EXPLICIT"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
      rai_filters {
        filter_type      = "DANGEROUS"
        confidence_level = "MEDIUM_AND_ABOVE"
      }
    }
    # 機密データ（認証情報・カード番号など）。氏名・電話・メールなどは、これより前に DLP（privacy.py）で伏せ字にしている
    sdp_settings {
      basic_config {
        filter_enforcement = "ENABLED"
      }
    }
    # 悪意のある URL のフィルタと多言語の検出は、asia-northeast1 では使えない（作成時に 400）。データの所在を優先して東京に置く
  }

  template_metadata {
    # 検査した本文を Cloud Logging に残さない（個人情報を増やさない）
    log_sanitize_operations = false
    log_template_operations = true
  }

  depends_on = [google_project_service.modelarmor]
}

# 実行 SA（care-solver-sa）が検査を呼べるようにする
resource "google_project_iam_member" "solver_modelarmor" {
  project = var.project_id
  role    = "roles/modelarmor.user"
  member  = "serviceAccount:${google_service_account.solver.email}"
}
