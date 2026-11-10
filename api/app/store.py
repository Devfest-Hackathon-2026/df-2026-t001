"""状態ストア。現行UIの状態（localStorage 'kana-care-state-v8' の中身）を data.app として1ドキュメントで保持する。

更新はバージョンによる楽観的排他制御: クライアントは手元の基準バージョン(base)を添えて送り、
サーバーの現在バージョンと一致したときだけ置換する。不一致なら現在の状態を返し、クライアントが3方向マージして再送する。
メモリ実装（ローカル/テスト）と Firestore 実装を同じIFで提供する。
"""
import copy
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from . import config


@dataclass
class PutResult:
    ok: bool  # False = 基準バージョン不一致（競合）
    version: int  # 成功時は新バージョン、競合時は現在のバージョン
    old: dict = field(default_factory=dict)  # 更新前（競合時は現在）の data
    new: dict = field(default_factory=dict)  # 更新後の data（競合時は空）


def _apply(old: dict, app: dict) -> dict:
    new = copy.deepcopy(old)
    new["app"] = copy.deepcopy(app)
    return new


class MemoryStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict[str, Any] = {}
        self._version = 0

    def get(self) -> tuple[dict, int]:
        with self._lock:
            return copy.deepcopy(self._state), self._version

    def put_app(self, app: dict, base: int) -> PutResult:
        with self._lock:
            if base != self._version:
                return PutResult(False, self._version, copy.deepcopy(self._state))
            old = self._state
            self._state = _apply(old, app)
            self._version += 1
            return PutResult(True, self._version, copy.deepcopy(old), copy.deepcopy(self._state))

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

    def _read(self, tx) -> tuple[dict, int]:
        snap = self._ref.get(transaction=tx)
        d = (snap.to_dict() or {}) if snap.exists else {}
        return d.get("data", {}) or {}, int(d.get("version", 0))

    def put_app(self, app: dict, base: int) -> PutResult:
        fs = self._fs

        @fs.transactional
        def run(tx):
            old, ver = self._read(tx)
            if base != ver:
                return PutResult(False, ver, old)
            new = _apply(old, app)
            tx.set(self._ref, {"data": new, "version": ver + 1, "updatedAt": time.time()})
            return PutResult(True, ver + 1, old, new)

        return run(self._db.transaction())

    def reset(self) -> int:
        """1回のトランザクションで空にしてバージョンを1つ進める（重複バージョンを作らない）。"""
        fs = self._fs

        @fs.transactional
        def run(tx):
            _, ver = self._read(tx)
            tx.set(self._ref, {"data": {}, "version": ver + 1, "updatedAt": time.time()})
            return ver + 1

        return run(self._db.transaction())


def make_store():
    if config.STORE_BACKEND == "firestore":
        return FirestoreStore()
    return MemoryStore()
