# 施設の運用マニュアル（合成・架空）

Vertex AI Search（Discovery Engine）に取り込み、`POST /api/v1/facilities/{fid}/ask-manual` が根拠として引用する文書。

- **3 施設（さくら苑・みどりの丘・ひだまりの家）はすべて架空**。文書もデモ用に合成したもので、実在の施設・法令・行政の基準を説明するものではない。
- 時刻・回数・人数などの数値は、すべて**デモ用の仮値**。
- 人名は出さず、役割（夜勤リーダー・ユニットリーダー・施設長など）で書く。

| ファイル | 施設 | 内容 |
|---|---|---|
| `fac-sakura/night-handover.html` | さくら苑 | 夜勤の流れと引き継ぎ |
| `fac-sakura/vacancy-emergency.html` | さくら苑 | 欠員時の連絡順・打診のルール・急変時の対応 |
| `fac-midori/night-handover.html` | みどりの丘 | 夜勤の流れと引き継ぎ |
| `fac-midori/vacancy-emergency.html` | みどりの丘 | 欠員時の連絡順・打診のルール・急変時の対応 |
| `fac-hidamari/night-handover.html` | ひだまりの家 | 夜勤の流れと引き継ぎ |
| `fac-hidamari/vacancy-emergency.html` | ひだまりの家 | 欠員時の連絡順・打診のルール・急変時の対応 |

取り込み: `solver-api/scripts/manuals_import.py`（GCS へ置いて、データストアに取り込み、終わるまで待つ）。
データストア・検索アプリ・バケットは `infra/grounding.tf`。
