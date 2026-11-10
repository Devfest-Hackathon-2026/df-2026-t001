"""ml_stream（Firestore → BigQuery *_stream）のテスト。BigQuery はフェイク、Firestore のイベントは本物の protobuf で組み立てる。"""
import os
import sys
from datetime import datetime, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
os.environ.setdefault("BQ_PROJECT", "test-proj")

import main  # noqa: E402
from google.events.cloud.firestore import ArrayValue, Document, DocumentEventData, MapValue, Value  # noqa: E402

DOC = "projects/test-proj/databases/(default)/documents/"
VAC_PATH = "facilities/fac-hidamari/vacancies/VAC-20261112-HID01"
OFF_PATH = VAC_PATH + "/offers/OFF-VAC-20261112-HID01-1"

VAC_TABLE_COLS = {"vacancy_id", "facility_id", "date", "shift", "unit_id", "need_skills", "reason", "absent_staff_id", "discovered_at",
                  "lead_hours", "final_route", "filled_by", "filled_at", "n_offers"}
OFF_TABLE_COLS = {"offer_id", "vacancy_id", "facility_id", "staff_id", "rank", "offered_at", "responded_at", "status", "response_min",
                  "lead_hours", "weekday", "shift", "same_unit", "skill_match", "consec_before", "month_hours_before", "nights_last30",
                  "offers_last14", "tenure_years", "employment"}
EXTRA = {"state", "source", "op", "doc_path", "event_id", "event_time", "ingested_at"}


def val(x):
    if x is None:
        return Value(null_value=0)
    if isinstance(x, bool):
        return Value(boolean_value=x)
    if isinstance(x, int):
        return Value(integer_value=x)
    if isinstance(x, float):
        return Value(double_value=x)
    if isinstance(x, str):
        return Value(string_value=x)
    if isinstance(x, list):
        return Value(array_value=ArrayValue(values=[val(v) for v in x]))
    if isinstance(x, dict):
        return Value(map_value=MapValue(fields={k: val(v) for k, v in x.items()}))
    if isinstance(x, datetime):
        return Value(timestamp_value=x)
    raise TypeError(x)


def doc(path, fields):
    return Document(name=DOC + path, fields={k: val(v) for k, v in fields.items()})


def event(path, old=None, new=None) -> bytes:
    ev = DocumentEventData(old_value=doc(path, old) if old is not None else None, value=doc(path, new) if new is not None else None)
    return DocumentEventData.serialize(ev)


class FakeBQ:
    def __init__(self, errors=None):
        self.rows, self.errors = [], errors or []

    def insert_rows_json(self, table, rows, row_ids=None):
        self.rows.append((table, rows, row_ids))
        return self.errors


VAC = {"vacancy_id": "VAC-20261112-HID01", "facility_id": "fac-hidamari", "date": "2026-11-12", "shift": "夜勤", "unit_id": "HDM-U1",
       "need_skills": ["喀痰吸引"], "reason": "体調不良", "absent_staff_id": "HDM-013", "state": "open",
       "created_at": "2026-11-12T00:00:00Z", "discovered_at": "2026-11-12T00:00:00Z", "filled_by": None, "filled_at": None}
FEATS = {"lead_hours": 7.5, "weekday": 3, "shift": "夜勤", "same_unit": True, "skill_match": False, "consec_before": 2,
         "month_hours_before": 64.0, "nights_last30": 3, "offers_last14": 1, "tenure_years": 4, "employment": "常勤"}
OFF = {"offer_id": "OFF-VAC-20261112-HID01-1", "vacancy_id": "VAC-20261112-HID01", "facility_id": "fac-hidamari", "staff_id": "HDM-002",
       "rank": 1, "status": "pending", "offered_at": "2026-11-12T00:10:00Z", "responded_at": None, "features": FEATS}


def test_vacancy_created_is_live_and_matches_fact_columns():
    fake = FakeBQ()
    row = main.handle("ev-1", "2026-11-12T00:00:01Z", "documents/" + VAC_PATH, event(VAC_PATH, new=VAC), client=fake)
    table, rows, ids = fake.rows[0]
    assert table == "test-proj.care_ml.fact_vacancies_stream" and ids == ["ev-1"]
    assert set(row) == VAC_TABLE_COLS | EXTRA
    assert row["op"] == "created" and row["source"] == "live" and row["state"] == "open"
    assert row["need_skills"] == ["喀痰吸引"] and row["date"] == "2026-11-12"
    # 夜勤の開始は JST 16:30 = UTC 07:30、発見は UTC 00:00 → 7.5 時間前
    assert row["lead_hours"] == 7.5
    assert row["final_route"] is None


def test_vacancy_filled_maps_route_and_replanned_maps_adjusted():
    filled = {**VAC, "state": "filled", "filled_by": "HDM-002", "filled_at": "2026-11-12T01:00:00Z"}
    _, row = main.build_row(VAC_PATH, VAC, filled, event_id="e", event_time=None)
    assert row["op"] == "updated" and row["final_route"] == "offer" and row["filled_by"] == "HDM-002"
    _, row = main.build_row(VAC_PATH, VAC, {**VAC, "state": "replanned"}, event_id="e", event_time=None)
    assert row["final_route"] == "adjusted"


def test_offer_responded_computes_response_minutes_and_features():
    fake = FakeBQ()
    new = {**OFF, "status": "accepted", "responded_at": "2026-11-12T00:40:00Z"}
    row = main.handle("ev-2", None, "documents/" + OFF_PATH, event(OFF_PATH, old=OFF, new=new), client=fake)
    assert fake.rows[0][0] == "test-proj.care_ml.fact_offers_stream"
    assert set(row) == OFF_TABLE_COLS | EXTRA
    assert row["op"] == "updated" and row["status"] == "accepted" and row["response_min"] == 30.0
    assert row["same_unit"] is True and row["skill_match"] is False and row["tenure_years"] == 4 and row["employment"] == "常勤"


def test_synthetic_flag_is_kept_out_of_live():
    _, row = main.build_row(OFF_PATH, None, {**OFF, "synthetic": True}, event_id="e", event_time=None)
    assert row["source"] == "synthetic"


def test_delete_uses_old_value():
    fake = FakeBQ()
    row = main.handle("ev-3", None, "documents/" + VAC_PATH, event(VAC_PATH, old=VAC), client=fake)
    assert row["op"] == "deleted" and row["vacancy_id"] == "VAC-20261112-HID01"


def test_other_paths_and_rejected_rows_are_not_retried():
    fake = FakeBQ()
    assert main.handle("ev-4", None, "documents/facilities/fac-x/rules/r1", event("facilities/fac-x/rules/r1", new={"id": "r1"}), client=fake) is None
    assert fake.rows == []
    bad = FakeBQ(errors=[{"index": 0, "errors": [{"reason": "invalid"}]}])
    assert main.handle("ev-5", None, "documents/" + VAC_PATH, event(VAC_PATH, new=VAC), client=bad) is None


def test_transient_bigquery_errors_propagate_for_retry():
    class Boom(FakeBQ):
        def insert_rows_json(self, *a, **k):
            raise RuntimeError("503 backend error")

    with pytest.raises(RuntimeError):
        main.handle("ev-6", None, "documents/" + VAC_PATH, event(VAC_PATH, new=VAC), client=Boom())


def test_firestore_timestamp_and_path_from_document_name():
    t = datetime(2026, 11, 12, 1, 2, 3, tzinfo=timezone.utc)
    data = event(OFF_PATH, new={**OFF, "offered_at": t})
    row = main.handle("ev-7", None, None, data, client=FakeBQ())
    assert row["doc_path"] == OFF_PATH and row["offered_at"].startswith("2026-11-12T01:02:03")
