"""業務イベントを Pub/Sub へ発行する（BigQuery subscription が care_analytics.events に書き込む）。

PUBSUB_TOPIC 未設定時はメモリに溜めるだけ（ローカル開発・テスト、分析のフォールバックにも使う）。
"""
import json
import threading
import time
import uuid
from typing import Any

from . import config

_lock = threading.Lock()
_local: list[dict] = []
_publisher = None


def emit(event_type: str, payload: dict[str, Any], vacancy_id: str | None = None) -> dict:
    ev = {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "vacancy_id": vacancy_id,
        "facility_id": config.FACILITY_ID,
        "ts": time.time(),
        "payload": json.dumps(payload, ensure_ascii=False),
    }
    with _lock:
        _local.append(ev)
        del _local[:-2000]
    if config.PUBSUB_TOPIC:
        try:
            global _publisher
            if _publisher is None:
                from google.cloud import pubsub_v1

                _publisher = pubsub_v1.PublisherClient()
            topic = _publisher.topic_path(config.PROJECT, config.PUBSUB_TOPIC)
            _publisher.publish(topic, json.dumps(ev, ensure_ascii=False).encode())
        except Exception as e:  # イベント送信失敗で業務操作を止めない
            print(f"[events] publish failed: {e}")
    return ev


def local_events() -> list[dict]:
    with _lock:
        return list(_local)


def clear_local() -> None:
    with _lock:
        _local.clear()
