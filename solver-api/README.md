# care-solver-api

介護施設の月次シフト・日次スケジュールを CP-SAT で作り、欠員補充までを扱う API（FastAPI）。
設計は `docs/ARCHITECTURE_v0.3_cpsat.md`。

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q tests                                  # 29件（Firestore 不要）
STORE=memory SYNTH_DIR=../scripts/synth/out .venv/bin/uvicorn care.server:app --port 8080   # ローカル（メモリ）
.venv/bin/python -m care.cli --facility fac-sakura --day 12          # 月次＋日次を解いて要約
python scripts/smoke.py https://care-solver-api-h5p5nqo3qa-an.a.run.app fac-hidamari    # 通し確認（Firestore に追記される）
.venv/bin/python scripts/reset_demo.py fac-hidamari                  # デモ状態に戻す
```

合成データの生成は `../scripts/synth/`。ルールの数値はすべてデモ用の仮値で、法令・施設基準の数値ではない。
参考: ben1san/df-hack26 の設計の考え方（コードは複製していない）。

## AI（Gemini）

`care/ai/` に、ルール翻訳（`POST …/rules/translate`）・説明の言い換え（`POST …/explain`）・チャット（`POST …/chat`）。
Vertex AI を ADC で呼ぶ（API キー無し）。入力は仮名化＋ Sensitive Data Protection でマスク。利用上限は全体 300回/日・IP ごと 20回/日。

```bash
.venv/bin/python scripts/eval_ai.py ../scripts/synth/out report.json     # 本物の Gemini で評価（Vertex AI を数十〜百数十回呼ぶ）
```

## 学習（応諾予測・反復検出）

`care/learn/` と `pipelines/`（Vertex AI Pipelines。README あり）。champion モデルは GCS から読み込み、候補の順位に応諾確率を反映する。

```bash
.venv/bin/python -m pytest -q tests/test_learn.py          # 学習・採点・検出・API への反映
.venv/bin/python pipelines/pipeline.py run                 # パイプラインを1回実行（Vertex AI）
```
