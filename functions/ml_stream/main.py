"""Firestore の欠員・打診の書き込みを、BigQuery care_ml の *_stream 表にほぼリアルタイムで追記する（Cloud Run 関数・Eventarc の受け手）。

  facilities/{fid}/vacancies/{vid}              → care_ml.fact_vacancies_stream
  facilities/{fid}/vacancies/{vid}/offers/{oid} → care_ml.fact_offers_stream

* 1 回の書き込み（作成・更新・削除）= 1 行の追記（変更の履歴）。最新の状態は *_stream_latest ビューで見る。
* 列は fact_vacancies / fact_offers と同じ名前・型に、source・op・state・doc_path・event_id・event_time・ingested_at を足したもの。
  既存の fact_* 表には書かない: fact_offers は学習（solver-api/care/learn/steps.py の SYNTH_OFFERS_SQL）で
  丸ごと「synthetic」扱いになるため、ライブの行を混ぜると合成データとして学習を汚す。
* source は steps.py と同じ考え方: 文書に synthetic が付いていれば "synthetic"、無ければ（API・画面からの実運用の書き込み）"live"。
* insertId に CloudEvent の id を使い、Eventarc の再送で重複しにくくする。
"""
from __future__ import annotations

import json
import os
import re
from datetime import date, datetime, timedelta, timezone

PROJECT = os.getenv("BQ_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT", "")
DATASET = os.getenv("BQ_DATASET", "care_ml")
VACANCY_TABLE = os.getenv("VACANCY_TABLE", "fact_vacancies_stream")
OFFER_TABLE = os.getenv("OFFER_TABLE", "fact_offers_stream")

VAC_RE = re.compile(r"(?:^|/)facilities/(?P<fid>[^/]+)/vacancies/(?P<vid>[^/]+)$")
OFF_RE = re.compile(r"(?:^|/)facilities/(?P<fid>[^/]+)/vacancies/(?P<vid>[^/]+)/offers/(?P<oid>[^/]+)$")

# solver-api/care/service.py の Svc.SHIFT_START と同じ（JST の開始時刻）
SHIFT_START = {"早番": 7.0, "日勤": 9.0, "遅番": 12.0, "夜勤": 16.5}
# 欠員の状態 → fact_vacancies.final_route の語彙（合成データは offer / adjusted / applicant）
ROUTE = {"filled": "offer", "replanned": "adjusted"}
FEATURES = ("lead_hours", "weekday", "shift", "same_unit", "skill_match", "consec_before", "month_hours_before",
            "nights_last30", "offers_last14", "tenure_years", "employment")


class BadEvent(ValueError):
    """再送しても直らない（対象外のパス・壊れた文書）。ログに出して 200 で返す。"""


# ---------------------------------------------------------------- Firestore の値 → Python

def _ts(dt) -> str:
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    return str(dt)


def decode_value(v) -> object:
    """google.events.cloud.firestore の Value（proto-plus）を Python の値にする。"""
    pb = type(v).pb(v)
    kind = pb.WhichOneof("value_type")
    if kind in (None, "null_value"):
        return None
    if kind == "string_value":
        return v.string_value
    if kind == "integer_value":
        return int(v.integer_value)
    if kind == "double_value":
        return float(v.double_value)
    if kind == "boolean_value":
        return bool(v.boolean_value)
    if kind == "timestamp_value":
        return _ts(v.timestamp_value)
    if kind == "array_value":
        return [decode_value(x) for x in v.array_value.values]
    if kind == "map_value":
        return {k: decode_value(x) for k, x in v.map_value.fields.items()}
    if kind == "reference_value":
        return v.reference_value
    if kind == "geo_point_value":
        return {"latitude": v.geo_point_value.latitude, "longitude": v.geo_point_value.longitude}
    if kind == "bytes_value":
        return None                                          # 学習には使わない
    return None


def decode_document(doc) -> dict | None:
    if doc is None or not getattr(doc, "name", ""):
        return None
    return {k: decode_value(x) for k, x in doc.fields.items()}


# ---------------------------------------------------------------- 文書 → 行

def _parse_ts(s) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _date(s) -> str | None:
    try:
        return date.fromisoformat(str(s)[:10]).isoformat() if s else None
    except ValueError:
        return None


def _num(x, cast):
    if x is None or x == "":
        return None
    try:
        return cast(x)
    except (TypeError, ValueError):
        return None


def _bool(x):
    if isinstance(x, bool) or x is None:
        return x
    if isinstance(x, str):
        return x.lower() == "true"
    return bool(x)


def source_of(doc: dict) -> str:
    """steps.py と同じ区別: synthetic が付いた文書だけ合成、ほかはライブ。"""
    return "synthetic" if doc.get("synthetic") else "live"


def vacancy_lead_hours(doc: dict) -> float | None:
    """欠員の勤務の開始（JST）まで、発見から何時間あったか。"""
    d, shift = _date(doc.get("date")), doc.get("shift")
    t0 = _parse_ts(doc.get("discovered_at") or doc.get("created_at"))
    if not d or shift not in SHIFT_START or t0 is None:
        return None
    y, m, day = map(int, d.split("-"))
    start = datetime(y, m, day, tzinfo=timezone.utc) + timedelta(hours=SHIFT_START[shift] - 9)
    return round(max((start - t0).total_seconds() / 3600, 0.0), 2)


def vacancy_row(doc: dict, ids: dict) -> dict:
    skills = doc.get("need_skills") or []
    return {
        "vacancy_id": doc.get("vacancy_id") or ids["vid"],
        "facility_id": doc.get("facility_id") or ids["fid"],
        "date": _date(doc.get("date")),
        "shift": doc.get("shift"),
        "unit_id": doc.get("unit_id"),
        "need_skills": [str(s) for s in skills] if isinstance(skills, list) else [str(skills)],
        "reason": doc.get("reason"),
        "absent_staff_id": doc.get("absent_staff_id"),
        "discovered_at": _ts(_parse_ts(doc.get("discovered_at"))) if _parse_ts(doc.get("discovered_at")) else None,
        "lead_hours": vacancy_lead_hours(doc),
        "final_route": ROUTE.get(doc.get("state")),
        "filled_by": doc.get("filled_by"),
        "filled_at": _ts(_parse_ts(doc.get("filled_at"))) if _parse_ts(doc.get("filled_at")) else None,
        "n_offers": _num(doc.get("n_offers"), int),
        "state": doc.get("state"),
    }


def offer_row(doc: dict, ids: dict) -> dict:
    f = doc.get("features") or {}
    sent, resp = _parse_ts(doc.get("offered_at")), _parse_ts(doc.get("responded_at"))
    return {
        "offer_id": doc.get("offer_id") or ids["oid"],
        "vacancy_id": doc.get("vacancy_id") or ids["vid"],
        "facility_id": doc.get("facility_id") or ids["fid"],
        "staff_id": doc.get("staff_id"),
        "rank": _num(doc.get("rank"), int),
        "offered_at": _ts(sent) if sent else None,
        "responded_at": _ts(resp) if resp else None,
        "status": doc.get("status"),
        "response_min": round((resp - sent).total_seconds() / 60, 2) if sent and resp else None,
        "lead_hours": _num(f.get("lead_hours"), float),
        "weekday": _num(f.get("weekday"), int),
        "shift": f.get("shift"),
        "same_unit": _bool(f.get("same_unit")),
        "skill_match": _bool(f.get("skill_match")),
        "consec_before": _num(f.get("consec_before"), int),
        "month_hours_before": _num(f.get("month_hours_before"), float),
        "nights_last30": _num(f.get("nights_last30"), int),
        "offers_last14": _num(f.get("offers_last14"), int),
        "tenure_years": _num(f.get("tenure_years"), int),
        "employment": f.get("employment"),
        "state": doc.get("status"),
    }


def build_row(path: str, old: dict | None, new: dict | None, *, event_id: str, event_time: str | None,
              now: datetime | None = None) -> tuple[str, dict]:
    """(表の名前, 行)。path は documents/ 以下（facilities/...）。"""
    if old is None and new is None:
        raise BadEvent(f"文書が空です: {path}")
    op = "deleted" if new is None else ("created" if old is None else "updated")
    doc = new if new is not None else old
    m = OFF_RE.search(path)
    if m:
        table, row = OFFER_TABLE, offer_row(doc, m.groupdict())
    else:
        m = VAC_RE.search(path)
        if not m:
            raise BadEvent(f"対象外のパスです: {path}")
        table, row = VACANCY_TABLE, vacancy_row(doc, {**m.groupdict(), "oid": None})
    row.update({
        "source": source_of(doc),
        "op": op,
        "doc_path": path,
        "event_id": event_id,
        "event_time": event_time,
        "ingested_at": (now or datetime.now(timezone.utc)).isoformat(),
    })
    return table, row


def doc_path(subject: str | None, doc_name: str | None) -> str:
    """CloudEvent の subject（documents/facilities/...）か文書名（projects/.../documents/facilities/...）から facilities/... を取り出す。"""
    for s in (subject, doc_name):
        if s and "documents/" in s:
            return s.split("documents/", 1)[1]
    return subject or doc_name or ""


# ---------------------------------------------------------------- BigQuery

_bq = None


def bq():
    global _bq
    if _bq is None:
        from google.cloud import bigquery

        _bq = bigquery.Client(project=PROJECT or None)
    return _bq


def insert(table: str, row: dict, client=None) -> None:
    c = client or bq()
    errors = c.insert_rows_json(f"{PROJECT}.{DATASET}.{table}", [row], row_ids=[row["event_id"]])
    if errors:
        # 列・型の不一致は再送しても直らない
        raise BadEvent(f"BigQuery が行を受け付けませんでした: {json.dumps(errors, ensure_ascii=False)[:500]}")


def handle(event_id: str, event_time: str | None, subject: str | None, data: bytes, client=None) -> dict | None:
    from google.events.cloud.firestore import DocumentEventData

    ev = DocumentEventData.deserialize(data)
    old = decode_document(ev.old_value) if ev.old_value else None
    new = decode_document(ev.value) if ev.value else None
    name = (ev.value.name if new is not None else ev.old_value.name) if (old or new) is not None else None
    path = doc_path(subject, name)
    try:
        table, row = build_row(path, old, new, event_id=event_id, event_time=event_time)
        insert(table, row, client)
    except BadEvent as e:
        print(json.dumps({"severity": "ERROR", "message": f"[ml-stream] {e}", "event_id": event_id, "path": path}, ensure_ascii=False))
        return None
    print(json.dumps({"severity": "INFO", "message": f"[ml-stream] {table} {row['op']} {path}", "source": row["source"]}, ensure_ascii=False))
    return row


try:
    import functions_framework

    @functions_framework.cloud_event
    def on_firestore(cloud_event):
        """Eventarc（google.cloud.firestore.document.v1.written・application/protobuf）の受け手。
        一時的な失敗（BigQuery の 5xx など）は例外のまま返し、Eventarc に再送させる。"""
        handle(cloud_event["id"], cloud_event.get("time"), cloud_event.get("subject"), cloud_event.data)
except ImportError:                                          # テスト環境では functions_framework が無くてもよい
    pass
