"""状態ストア。フロントの flowState / monthlySchedule を1ドキュメントとして保持する。

メモリ実装（ローカル/テスト）と Firestore 実装を同じIFで提供する。
"""
import copy
import threading
import time
from typing import Any

from . import config


def deep_merge(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


REPLACE_KEYS = {"app"}  # 現行UIの状態は常に丸ごと置換（削除されたキーも伝わるように）


def apply_patch(old: dict, patch: dict) -> dict:
    new = deep_merge({k: v for k, v in old.items() if k not in patch or k not in REPLACE_KEYS}, {k: v for k, v in patch.items() if k not in REPLACE_KEYS})
    for k in patch:
        if k in REPLACE_KEYS:
            new[k] = copy.deepcopy(patch[k])
    return new


class MemoryStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {}
        self._version = 0

    def get(self) -> tuple[dict, int]:
        with self._lock:
            return copy.deepcopy(self._state), self._version

    def patch(self, patch: dict) -> tuple[dict, dict, int]:
        """(旧状態, 新状態, 新バージョン) を返す。"""
        with self._lock:
            old = copy.deepcopy(self._state)
            self._state = apply_patch(self._state, patch)
            self._version += 1
            return old, copy.deepcopy(self._state), self._version

    def reset(self) -> int:
        with self._lock:
            self._state = {}
            self._version += 1
            return self._version


class FirestoreStore:
    def __init__(self) -> None:
        from google.cloud import firestore  # 遅延import

        self._fs = firestore
        self._db = firestore.Client(project=config.PROJECT)
        self._ref = self._db.collection("facilities").document(config.FACILITY_ID).collection("state").document("current")

    def get(self) -> tuple[dict, int]:
        snap = self._ref.get()
        if not snap.exists:
            return {}, 0
        d = snap.to_dict() or {}
        return d.get("data", {}), int(d.get("version", 0))

    def patch(self, patch: dict) -> tuple[dict, dict, int]:
        fs = self._fs

        @fs.transactional
        def run(tx):
            snap = self._ref.get(transaction=tx)
            d = snap.to_dict() if snap.exists else {}
            old = d.get("data", {}) if d else {}
            ver = int(d.get("version", 0)) + 1 if d else 1
            new = apply_patch(old, patch)
            tx.set(self._ref, {"data": new, "version": ver, "updatedAt": time.time()})
            return old, new, ver

        return run(self._db.transaction())

    def reset(self) -> int:
        _, _, ver = self.patch({})
        self._ref.set({"data": {}, "version": ver + 1, "updatedAt": time.time()})
        return ver + 1


def make_store():
    if config.STORE_BACKEND == "firestore":
        return FirestoreStore()
    return MemoryStore()
