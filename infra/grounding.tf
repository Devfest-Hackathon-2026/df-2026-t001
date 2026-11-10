# 施設の運用マニュアル（合成・架空）を根拠にした回答（POST /api/v1/facilities/{fid}/ask-manual）。
# 文書は docs/manuals/** を GCS に置き、Vertex AI Search（Discovery Engine）のデータストアに取り込む。
# 2026-11-10 にバケット・データストア・検索アプリを solver-api/scripts/manuals_import.py（REST）で先に作成済み。
# 下の import ブロックで、次の terraform apply -target=... 時に既存のものを state に取り込む（作り直さない）。
# 取り込み（documents:import）は Terraform では行わない。solver-api/scripts/manuals_import.py で実行し、終わるまで待つ。
# API 側は環境変数 GROUNDING_DATASTORE（下の output）で有効になる。未設定なら 404。

locals {
  manuals_dir  = "${path.module}/../docs/manuals"
  manual_files = toset([for f in fileset(local.manuals_dir, "*/*.html") : f])
  manual_titles = {
    "night-handover"    = "夜勤・引き継ぎマニュアル"
    "vacancy-emergency" = "欠員・急変対応マニュアル"
  }
  facility_names = { "fac-sakura" = "さくら苑", "fac-midori" = "みどりの丘", "fac-hidamari" = "ひだまりの家" }
  # documents:import に渡す1行1文書の JSONL。id は「施設ID--文書名」、facility_id で絞り込む
  manual_docs = [for f in sort(tolist(local.manual_files)) : {
    id = "${dirname(f)}--${trimsuffix(basename(f), ".html")}"
    structData = {
      facility_id   = dirname(f)
      facility_name = local.facility_names[dirname(f)]
      title         = "${local.facility_names[dirname(f)]} ${local.manual_titles[trimsuffix(basename(f), ".html")]}"
      synthetic     = true
    }
    content = { mimeType = "text/html", uri = "gs://${google_storage_bucket.manuals.name}/manuals/${f}" }
  }]
}

resource "google_project_service" "discoveryengine" {
  service            = "discoveryengine.googleapis.com"
  disable_on_destroy = false
}

resource "google_storage_bucket" "manuals" {
  name                        = "${var.project_id}-care-manuals"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = true
}

resource "google_storage_bucket_object" "manual" {
  for_each     = local.manual_files
  bucket       = google_storage_bucket.manuals.name
  name         = "manuals/${each.value}"
  source       = "${local.manuals_dir}/${each.value}"
  content_type = "text/html; charset=utf-8"
}

resource "google_storage_bucket_object" "manual_index" {
  bucket       = google_storage_bucket.manuals.name
  name         = "import/documents.jsonl"
  content      = join("\n", [for d in local.manual_docs : jsonencode(d)])
  content_type = "application/json"
}

resource "google_discovery_engine_data_store" "manuals" {
  location                    = "global"
  data_store_id               = "care-manuals"
  display_name                = "介護施設の運用マニュアル（架空・デモ）"
  industry_vertical           = "GENERIC"
  content_config              = "CONTENT_REQUIRED"
  solution_types              = ["SOLUTION_TYPE_SEARCH"]
  create_advanced_site_search = false
  document_processing_config {
    default_parsing_config {
      layout_parsing_config {}
    }
    chunking_config {
      layout_based_chunking_config {
        chunk_size                = 300
        include_ancestor_headings = true
      }
    }
  }
  depends_on = [google_project_service.discoveryengine]
}

resource "google_discovery_engine_search_engine" "manuals" {
  location          = "global"
  engine_id         = "care-manuals-search"
  collection_id     = "default_collection"
  display_name      = "介護施設の運用マニュアル検索（デモ）"
  data_store_ids    = [google_discovery_engine_data_store.manuals.data_store_id]
  industry_vertical = "GENERIC"
  search_engine_config {
    search_tier    = "SEARCH_TIER_ENTERPRISE"
    search_add_ons = ["SEARCH_ADD_ON_LLM"]
  }
  common_config {
    company_name = "介護施設（架空）"
  }
}

# 実行 SA（care-solver-sa）が検索できるようにする
resource "google_project_iam_member" "solver_discovery_user" {
  project = var.project_id
  role    = "roles/discoveryengine.user"
  member  = "serviceAccount:care-solver-sa@${var.project_id}.iam.gserviceaccount.com"
}

output "grounding_datastore" {
  description = "環境変数 GROUNDING_DATASTORE に入れる値（検索アプリのサービング設定）"
  value       = "projects/${data.google_project.this.number}/locations/global/collections/default_collection/engines/${google_discovery_engine_search_engine.manuals.engine_id}/servingConfigs/default_search"
}

import {
  to = google_storage_bucket.manuals
  id = "gdgoc-514203-care-manuals"
}

import {
  to = google_discovery_engine_data_store.manuals
  id = "projects/gdgoc-514203/locations/global/collections/default_collection/dataStores/care-manuals"
}

import {
  to = google_discovery_engine_search_engine.manuals
  id = "projects/gdgoc-514203/locations/global/collections/default_collection/engines/care-manuals-search"
}
