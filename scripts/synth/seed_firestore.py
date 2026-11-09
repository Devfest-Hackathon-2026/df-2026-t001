#!/usr/bin/env python3
"""合成データの一部を Firestore にシードする（標準ライブラリのみ。gcloud の認証を使う）。

  facilities/{fid}                     施設
  facilities/{fid}/staff/{staffId}     従業員
  facilities/{fid}/taskTemplates/{id}  日課テンプレート
  facilities/{fid}/rosters/{YYYY-MM}   2026-11・12 の提案(proposal)と現状(current)。別々に持つ
  facilities/{fid}/requests/{YYYY-MM}  希望休 {byStaff: {staffId: [日]}}
  （ルールは api/scripts/seed_rules.py が DSL の形で書く。デモ用の仮値で、法令の数値ではない）

履歴（欠員・打診・編集ログなど）は BigQuery に入れるので、ここには置かない。
既存の facilities/demo など、synthetic でない文書は上書きしない。何度実行しても同じ結果。
"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request

PROJECT = sys.argv[1] if len(sys.argv) > 1 else "gdgoc-514203"
SEED = sys.argv[2] if len(sys.argv) > 2 else "scripts/synth/out/seed.json"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"
DOC = f"projects/{PROJECT}/databases/(default)/documents"
TOKEN = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
HEAD = {"Authorization": f"Bearer {TOKEN}", "x-goog-user-project": PROJECT, "Content-Type": "application/json"}


def val(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [val(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {k: val(x) for k, x in v.items()}}}
    raise TypeError(type(v))


def call(method, url, body=None):
    req = urllib.request.Request(url, method=method, headers=HEAD, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def write(path, data):
    return {"update": {"name": f"{DOC}/{path}", "fields": {k: val(v) for k, v in data.items()}}}


def commit(writes):
    for i in range(0, len(writes), 300):
        st, body = call("POST", f"{BASE}:commit", {"writes": writes[i:i + 300]})
        if st != 200:
            sys.exit(f"commit failed {st}: {json.dumps(body, ensure_ascii=False)[:400]}")


def rules_for(fid: str, need: dict):
    org = {"kind": "手入力", "evidence": "デモ用の仮値（法令の数値ではない）"}
    base = [
        {"id": "r-run", "type": "succession", "label": "連続勤務は5日まで（デモ用の仮値）", "strength": "絶対", "max_run": 5},
        {"id": "r-ake", "type": "succession", "label": "夜勤のあとは翌日を休みにする（デモ用の仮値）", "strength": "絶対", "pattern": [["夜勤"], ["早番", "日勤", "遅番", "夜勤"]], "forbid": True},
        {"id": "r-interval", "type": "succession", "label": "遅番のあとに早番を置かない（勤務間インターバル・デモ用の仮値）", "strength": "絶対", "pattern": [["遅番"], ["早番"]], "forbid": True},
        {"id": "r-night-cap", "type": "count", "label": f"夜勤は月{9}回まで（デモ用の仮値）", "strength": "強く", "shifts": ["夜勤"], "unit": "回", "at_most": 9},
    ]
    base += [{"id": f"r-staff-{sh}", "type": "staffing", "label": f"{sh}は毎日{n}人以上（デモ用の仮値）", "strength": "絶対", "shifts": [sh], "at_least": n} for sh, n in need.items()]
    return [{**r, "origin": org, "provisional": True, "locked": False, "synthetic": True} for r in base]


def main():
    seed = json.load(open(SEED, encoding="utf-8"))
    out_dir = SEED.rsplit("/", 1)[0]
    requests = [json.loads(line) for line in open(f"{out_dir}/fact_requests.ndjson", encoding="utf-8")]
    last_oct: dict[str, dict[str, str]] = {}
    for line in open(f"{out_dir}/fact_assignments.ndjson", encoding="utf-8"):
        a = json.loads(line)
        if a["date"] == "2026-10-31" and a["status"] != "absent":
            last_oct.setdefault(a["facility_id"], {})[a["staff_id"]] = a["shift"]
    need_by = {"fac-sakura": {"早番": 4, "日勤": 6, "遅番": 4, "夜勤": 4}, "fac-midori": {"早番": 3, "日勤": 4, "遅番": 3, "夜勤": 2},
               "fac-hidamari": {"早番": 2, "日勤": 2, "遅番": 2, "夜勤": 2}}
    writes = []
    for f in seed["facilities"]:
        fid = f["facility"]["id"]
        st, doc = call("GET", f"{BASE}/facilities/{fid}")
        if st == 200 and not doc.get("fields", {}).get("synthetic", {}).get("booleanValue"):
            sys.exit(f"facilities/{fid} は合成データではない既存の文書です。上書きしません")
        writes.append(write(f"facilities/{fid}", {**f["facility"], "needPerShift": need_by[fid]}))
        for s in f["staff"]:
            writes.append(write(f"facilities/{fid}/staff/{s['staff_id']}", {**s, "synthetic": True}))
        for t in f["templates"]:
            writes.append(write(f"facilities/{fid}/taskTemplates/{t['template_id']}", {**t, "synthetic": True}))
        for ym, m in f["rosters"].items():
            writes.append(write(f"facilities/{fid}/rosters/{ym}", {**m, "carryIn": last_oct.get(fid, {}) if ym == "2026-11" else {}, "synthetic": True}))
        for ym in f["rosters"]:
            by: dict[str, list[int]] = {}
            for q in requests:
                if q["facility_id"] == fid and q["date"].startswith(ym) and q["kind"] == "off":
                    by.setdefault(q["staff_id"], []).append(int(q["date"][8:10]))
            writes.append(write(f"facilities/{fid}/requests/{ym}", {"month": ym, "byStaff": {k: sorted(v) for k, v in by.items()}, "synthetic": True}))
    commit(writes)
    print(f"seeded {len(writes)} documents for {len(seed['facilities'])} facilities")


if __name__ == "__main__":
    main()
