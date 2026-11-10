"""学習の成果物（champion モデル・履歴・反復検出の候補）の読み込み。Pipelines が GCS に置いたものを API が読む。

  gs://<root>/models/<施設>/champion.json   昇格したモデル（採点に使う）
  gs://<root>/models/<施設>/challenger.json 比較で次点だったモデル（A/B で一部の打診にだけ使う。ab.py）
  gs://<root>/models/<施設>/history.json    学習のたびの記録（件数・AUC・昇格したか）
  gs://<root>/learned/<施設>.json           反復検出のルール候補
読み込みは5分キャッシュ。読めなければ「モデルなし」として、従来の順位付けに戻る（API は止めない）。
"""
from __future__ import annotations

import json
import os
import time

from . import scoring

TTL = 300.0
MISS_TTL = 20.0


class ModelStore:
    def __init__(self, root: str | None = None) -> None:
        self.root = root or os.getenv("MODEL_ROOT", "")
        self._cache: dict[str, tuple[float, object]] = {}

    def _read(self, path: str):
        hit = self._cache.get(path)
        if hit and time.time() - hit[0] < (TTL if hit[1] is not None else MISS_TTL):      # 無かった結果は短くしか覚えない（直後に成果物ができるため）
            return hit[1]
        val = None
        try:
            from google.cloud import storage

            name, _, prefix = self.root[5:].partition("/")
            key = f"{prefix.strip('/')}/{path}" if prefix.strip("/") else path
            blob = storage.Client().bucket(name).blob(key)
            val = blob.download_as_text() if blob.exists() else None
        except Exception as e:  # noqa: BLE001
            print(f"[models] read failed {path}: {e}")
        self._cache[path] = (time.time(), val)
        return val

    def champion(self, fid: str) -> dict | None:
        t = self._read(f"models/{fid}/champion.json")
        return scoring.load(t) if t else None

    def challenger(self, fid: str) -> dict | None:
        t = self._read(f"models/{fid}/challenger.json")
        return scoring.load(t) if t else None

    def history(self, fid: str) -> list[dict]:
        t = self._read(f"models/{fid}/history.json")
        return json.loads(t) if t else []

    def learned(self, fid: str) -> dict | None:
        t = self._read(f"learned/{fid}.json")
        return json.loads(t) if t else None


class MemoryModelStore:
    """テスト用。"""

    def __init__(self, champions: dict | None = None, histories: dict | None = None, learned: dict | None = None,
                 challengers: dict | None = None) -> None:
        self.c, self.h, self.l, self.ch = champions or {}, histories or {}, learned or {}, challengers or {}

    def champion(self, fid):
        return self.c.get(fid)

    def challenger(self, fid):
        return self.ch.get(fid)

    def history(self, fid):
        return self.h.get(fid, [])

    def learned(self, fid):
        return self.l.get(fid)


def public_meta(art: dict | None) -> dict | None:
    """画面・チャットに出してよい要約（係数・木・人ごとの統計は出さない）。"""
    if not art:
        return None
    m = art.get("metrics", {})
    chosen = m.get(art["kind"], {})
    return {"version": art["version"], "kind": art["kind"], "trained_at": art["trained_at"], "rows": art["n_rows"], "auc": chosen.get("auc"),
            "logloss": chosen.get("logloss"), "baseline_logloss": m.get("baseline", {}).get("logloss"), "logloss_gain": m.get("logloss_gain_vs_baseline"),
            "compared": {k: v for k, v in m.items() if isinstance(v, dict)}, "gate": art.get("gate")}
