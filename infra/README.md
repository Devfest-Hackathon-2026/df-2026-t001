# infra (Terraform)

GCP `gdgoc-514203`。**未適用**（権限付与後に実施）。plan での検証もまだ行っていない。

```bash
gcloud storage buckets create gs://gdgoc-514203-tfstate -l asia-northeast1   # 初回のみ
cd infra && terraform init && terraform plan
# 既存の Artifact Registry は管理対象外（流用）。nurse-shift は触らない。
```
初回は care-api イメージが無いため、先に `gcloud builds submit api --tag <api_image>` するか、apply を段階的に行う。
適用後 `terraform output` の `wif_provider` / `deployer_sa` を GitHub の Variables
(`WIF_PROVIDER`, `DEPLOYER_SA`) に登録する。
