import os

PROJECT = os.getenv("GOOGLE_CLOUD_PROJECT", "gdgoc-514203")
# STORE_BACKEND=firestore で Firestore、未指定はメモリ（ローカル開発・テスト）
STORE_BACKEND = os.getenv("STORE_BACKEND", "memory")
FACILITY_ID = os.getenv("FACILITY_ID", "demo")
# Vertex AI（Gemini）。モデルIDは公式ドキュメントで最新を確認して環境変数で差し替える
AI_ENABLED = os.getenv("AI_ENABLED", "0") == "1"
VERTEX_LOCATION = os.getenv("VERTEX_LOCATION", "global")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-pro-preview")
GEMINI_FAST_MODEL = os.getenv("GEMINI_FAST_MODEL", "gemini-3.8-flash")
PUBSUB_TOPIC = os.getenv("PUBSUB_TOPIC", "")  # 例: care-events
BQ_DATASET = os.getenv("BQ_DATASET", "care_analytics")
# 公開デモ向けの簡易レート制限（IPあたり/分）。0で無効
# Cloudflare Worker 経由だと多数の利用者が同一の送信元IPになるため、IP上限は粗い防波堤にとどめ、実質の制限は利用者別(uid)で行う
RATE_LIMIT_PER_MIN = int(os.getenv("RATE_LIMIT_PER_MIN", "900"))
REQ_PER_UID_PER_MIN = int(os.getenv("REQ_PER_UID_PER_MIN", "150"))

# --- セキュリティ ---
# 既定で認証必須（Firebase匿名認証のIDトークン）。ローカル開発のみ REQUIRE_AUTH=0
REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "1") == "1"
AI_DAILY_LIMIT = int(os.getenv("AI_DAILY_LIMIT", "300"))       # 全体のAI呼出し/日（課金暴走防止）
AI_PER_UID_PER_MIN = int(os.getenv("AI_PER_UID_PER_MIN", "8"))  # 利用者あたりのAI呼出し/分
MAX_STATE_BYTES = int(os.getenv("MAX_STATE_BYTES", "600000"))
