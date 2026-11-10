#!/usr/bin/env python3
"""施設の初期ルール（DSL の形）を Firestore に書く。デモ用の仮値で、法令・施設基準の数値ではない。

何度実行しても同じ結果（初期ルールの id だけを上書きする）。API から追加したルールには触れない。
  solver-api/.venv/bin/python solver-api/scripts/seed_rules.py [project]

project は引数 > 環境変数 GOOGLE_CLOUD_PROJECT > CARE_PROJECT > gdgoc-514203 の順で決まる。
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from care.defaults import default_rules  # noqa: E402
from care.service import Svc, month_obj  # noqa: E402
from care.store import FirestoreRepo  # noqa: E402

project = (sys.argv[1] if len(sys.argv) > 1 else None) or os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("CARE_PROJECT") or "gdgoc-514203"
repo = FirestoreRepo(project)
svc = Svc(repo)
n = 0
for f in repo.list_facilities():
    fid = f["id"]
    if not f.get("synthetic"):
        continue
    for r in default_rules(svc.facility(fid), month_obj("2026-11")):
        repo.db.collection("facilities").document(fid).collection("rules").document(r.id).set(r.model_dump(mode="json"))
        n += 1
print(f"wrote {n} rules")
