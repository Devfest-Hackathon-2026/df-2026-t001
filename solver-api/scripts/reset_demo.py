#!/usr/bin/env python3
"""施設のデモ状態を初期（P1 のシード）に戻す。API が追記した提案・手修正・欠員・ルールの履歴を消す。

  api/.venv/bin/python api/scripts/reset_demo.py fac-hidamari [project]

初期ルール（defaults.py の id）と、シードした従業員・日課・勤務表は消さない。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from care.defaults import default_rules  # noqa: E402
from care.service import Svc, month_obj  # noqa: E402
from care.store import FirestoreRepo  # noqa: E402

fid = sys.argv[1]
repo = FirestoreRepo(sys.argv[2] if len(sys.argv) > 2 else "gdgoc-514203")
ref = repo.db.collection("facilities").document(fid)
keep = {r.id for r in default_rules(Svc(repo).facility(fid), month_obj("2026-11"))}
n = 0
for sub in ("proposals", "edits", "vacancies", "ruleEvents"):
    for d in ref.collection(sub).stream():
        repo.db.recursive_delete(d.reference)
        n += 1
for d in ref.collection("rules").stream():
    if d.id not in keep:
        d.reference.delete()
        n += 1
print(f"{fid}: deleted {n} documents")
