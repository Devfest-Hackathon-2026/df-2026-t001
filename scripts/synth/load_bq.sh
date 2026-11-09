#!/usr/bin/env bash
# 合成データを BigQuery に投入する（何度実行しても同じ結果になる）。
#   care_ml.<table>                 … --replace で全置換
#   care_analytics.events_raw       … 本物のイベントを消さず、合成分（data.synthetic=true）だけ消して追記
#
# 使い方: scripts/synth/load_bq.sh [project] [out_dir]
set -euo pipefail
PROJECT="${1:-gdgoc-514203}"
OUT="${2:-$(dirname "$0")/out}"
LOC=asia-northeast1

for t in dim_facility dim_staff dim_task_templates fact_assignments fact_requests fact_roster_edits \
         fact_task_edits fact_health_checks fact_vacancies fact_offers; do
  bq --project_id="$PROJECT" --location="$LOC" load --replace --source_format=NEWLINE_DELIMITED_JSON \
    --schema="$OUT/$t.schema.json" "care_ml.$t" "$OUT/$t.ndjson" >/dev/null
  echo "loaded care_ml.$t"
done

# 合成イベント: 既存の合成分だけ削除してから追記（本物のイベントには触れない）
bq --project_id="$PROJECT" --location="$LOC" query --use_legacy_sql=false --quiet \
  "DELETE FROM care_analytics.events_raw WHERE JSON_VALUE(data, '\$.synthetic') = 'true'" >/dev/null
bq --project_id="$PROJECT" --location="$LOC" load --source_format=NEWLINE_DELIMITED_JSON \
  --schema="$OUT/events_raw_synthetic.schema.json" care_analytics.events_raw "$OUT/events_raw_synthetic.ndjson" >/dev/null
echo "appended synthetic events to care_analytics.events_raw"
