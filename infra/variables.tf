variable "project_id" {
  type    = string
  default = "gdgoc-514203"
}
variable "region" {
  type    = string
  default = "asia-northeast1"
}
variable "github_repo" {
  type    = string
  default = "32Lwk/gdgoc-care-connect"
}
variable "api_image" {
  type    = string
  default = "asia-northeast1-docker.pkg.dev/gdgoc-514203/cloud-run-source-deploy/care-api:latest"
}
# Geminiのモデルは公式ドキュメントで最新を確認して差し替える
variable "gemini_model" {
  type    = string
  default = "gemini-3.1-pro-preview"
}
variable "gemini_fast_model" {
  type    = string
  default = "gemini-3-flash-preview"
}
variable "ai_daily_limit" {
  type        = number
  default     = 300
  description = "全体のAI呼出し/日の上限（課金暴走防止）"
}
