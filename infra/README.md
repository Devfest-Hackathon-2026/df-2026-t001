# infra（Terraform）

GCP プロジェクト `gdgoc-514203` のうち、本製品が使うリソースを Terraform で管理している。**適用済み**（2026-11-09 に P0 の `main.tf`・`ml.tf` を、その後 `solver.tf` を適用）。状態は GCS バケット `gdgoc-514203-tfstate`（prefix `care`）に置く。

| ファイル | 内容 |
|---|---|
| `main.tf` | API の有効化、Firestore、BigQuery `care_analytics`、Pub/Sub `care-events` と BigQuery subscription、`care-api` 用のサービスアカウント、WIF（GitHub Actions）、Cloud Run `care-api`（画面状態の同期用。最大 3 インスタンス・同時実行 40） |
| `ml.tf` | BigQuery `care_ml`、GCS `gdgoc-514203-vertex-pipelines`（30 日で自動削除）、`pipeline-sa` と最小権限（Vertex AI Pipelines の実行用） |
| `solver.tf` | Cloud Run `care-solver-api`（最適化ソルバー・AI・学習。4 vCPU・2GiB・最小 0/最大 3・同時実行 4・タイムアウト 60 秒）と `care-solver-sa` |
| `outputs.tf` / `variables.tf` | 出力（`wif_provider`、`deployer_sa`）と変数 |

```bash
cd infra && terraform init && terraform plan
# 新しいリソースだけを適用するときは -target を付ける（既存の care-api・nurse-shift には触れない）
# 例: terraform apply -target=google_cloud_run_v2_service.solver
```

- 既存の Artifact Registry（`cloud-run-source-deploy`）は管理対象外で、流用している。`nurse-shift`（チームの別メンバーが作成した既存の Cloud Run サービス）には触れない。
- `terraform output` の `wif_provider` と `deployer_sa` は、GitHub の Variables（`WIF_PROVIDER`、`DEPLOYER_SA`）に登録して使う（鍵ファイルなしのデプロイ）。
- 予算アラートは、課金アカウントの権限がないため Terraform では管理していない（課金は手動で確認している）。
