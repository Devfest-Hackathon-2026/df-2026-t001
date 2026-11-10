"""打診の候補の順位付けの A/B（champion / challenger）。

* 環境変数 AB_CHALLENGER_SHARE（0〜1）。未設定・0 なら従来どおり（常に champion。イベントにも何も足さない）。
* 腕は欠員 ID のハッシュで決める（同じ欠員は何度並べ直しても同じ腕。打診の記録と順位付けで食い違わない）。
* challenger は学習パイプラインが置いた models/<施設>/challenger.json。無ければ champion を使い、腕は champion と記録する。
* どちらを使ったかは offer_sent の payload の "ab" に残る（BigQuery の care_analytics.ab_offer_outcomes で腕ごとの応諾率を比べる）。
"""
from __future__ import annotations

import hashlib
import os

CHAMPION, CHALLENGER = "champion", "challenger"


def share() -> float:
    try:
        v = float(os.getenv("AB_CHALLENGER_SHARE", "0") or 0)
    except ValueError:
        return 0.0
    return min(max(v, 0.0), 1.0)


def enabled() -> bool:
    return share() > 0


def bucket(vacancy_id: str) -> float:
    """[0, 1) の決定的な値。"""
    return int(hashlib.sha256(f"ab:{vacancy_id}".encode()).hexdigest()[:12], 16) / float(16 ** 12)


def arm(vacancy_id: str | None, s: float | None = None) -> str:
    s = share() if s is None else s
    if not vacancy_id or s <= 0:
        return CHAMPION
    return CHALLENGER if bucket(vacancy_id) < s else CHAMPION


def choose(models, fid: str, vacancy_id: str | None) -> tuple[dict | None, dict | None]:
    """(使う成果物, イベントに残す情報)。A/B が無効なら (champion, None)。"""
    champ = models.champion(fid) if models else None
    if not enabled():
        return champ, None
    want = arm(vacancy_id)
    art, used = champ, CHAMPION
    if want == CHALLENGER and champ is not None:
        ch = None
        try:
            ch = models.challenger(fid) if hasattr(models, "challenger") else None
        except Exception as e:  # noqa: BLE001  challenger が読めなければ champion に戻る
            print(f"[ab] challenger load failed: {type(e).__name__}")
        if ch is not None:
            art, used = ch, CHALLENGER
    info = {"arm": used, "assigned": want, "share": share(), "model_kind": art["kind"] if art else None,
            "model_version": art["version"] if art else None}
    return art, info
