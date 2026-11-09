"""分析集計。BigQuery（care_analytics.events）を優先し、未接続時はメモリ上のイベントで代替する。"""
import json
from collections import Counter

from . import config, events


def _from_local() -> dict:
    evs = events.local_events()
    by_type = Counter(e["event_type"] for e in evs)
    transitions = [json.loads(e["payload"]) for e in evs if e["event_type"] == "vacancy_status_changed"]
    return {"backend": "memory", "events_total": len(evs), "by_type": dict(by_type), "status_transitions": [f"{t.get('from')}→{t.get('to')}" for t in transitions]}


def stats() -> dict:
    if not config.PUBSUB_TOPIC:
        return _from_local()
    try:
        from google.cloud import bigquery

        bq = bigquery.Client(project=config.PROJECT)
        table = f"`{config.PROJECT}.{config.BQ_DATASET}.events`"
        rows = list(bq.query(f"SELECT event_type, COUNT(*) AS n FROM {table} WHERE facility_id=@f GROUP BY event_type", job_config=bigquery.QueryJobConfig(query_parameters=[bigquery.ScalarQueryParameter("f", "STRING", config.FACILITY_ID)])).result())
        by_type = {r["event_type"]: r["n"] for r in rows}
        return {"backend": "bigquery", "events_total": sum(by_type.values()), "by_type": by_type}
    except Exception as e:
        out = _from_local()
        out["bqError"] = type(e).__name__
        return out
