output "wif_provider" {
  value = google_iam_workload_identity_pool_provider.gh.name
}
output "deployer_sa" {
  value = google_service_account.deployer.email
}
output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}
output "pipeline_sa" {
  value = google_service_account.pipeline.email
}
output "pipeline_root" {
  value = "gs://${google_storage_bucket.pipeline_root.name}"
}
output "ml_dataset" {
  value = google_bigquery_dataset.ml.dataset_id
}
