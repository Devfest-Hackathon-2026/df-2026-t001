"""施設の運用マニュアル（docs/manuals/**、合成・架空）を Vertex AI Search に取り込む。何度実行してもよい。

1. HTML と documents.jsonl（1行1文書。facility_id つき）を GCS に置く
2. データストア care-manuals と検索アプリ care-manuals-search が無ければ作る（infra/grounding.tf と同じ設定）
3. スキーマで facility_id を絞り込みに使えるようにする
4. documents:import（INCREMENTAL）を実行し、終わるまで待つ。最後に検索して件数を確かめる

  python scripts/manuals_import.py            # 取り込みまで
  python scripts/manuals_import.py --check    # 検索の確認だけ

認証は ADC。GROUNDING_DATASTORE に入れる値を最後に表示する。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import google.auth
from google.auth.transport.requests import AuthorizedSession

PROJECT = "gdgoc-514203"
BUCKET = f"{PROJECT}-care-manuals"
DS, ENGINE = "care-manuals", "care-manuals-search"
API = "https://discoveryengine.googleapis.com/v1"
COLL = f"projects/{PROJECT}/locations/global/collections/default_collection"
ROOT = Path(__file__).resolve().parents[2] / "docs" / "manuals"
FACILITIES = {"fac-sakura": "さくら苑", "fac-midori": "みどりの丘", "fac-hidamari": "ひだまりの家"}
TITLES = {"night-handover": "夜勤・引き継ぎマニュアル", "vacancy-emergency": "欠員・急変対応マニュアル"}
SCHEMA = {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {
    "facility_id": {"type": "string", "indexable": True, "retrievable": True, "searchable": False, "dynamicFacetable": False},
    "facility_name": {"type": "string", "retrievable": True, "searchable": True, "indexable": False, "dynamicFacetable": False},
    "title": {"type": "string", "keyPropertyMapping": "title", "retrievable": True},
    "synthetic": {"type": "boolean", "retrievable": True, "indexable": True},
}}


def session() -> AuthorizedSession:
    cred, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
    s = AuthorizedSession(cred)
    s.headers["x-goog-user-project"] = PROJECT
    return s


def docs() -> list[dict]:
    out = []
    for f in sorted(ROOT.glob("*/*.html")):
        fid, name = f.parent.name, f.stem
        out.append({"id": f"{fid}--{name}", "structData": {"facility_id": fid, "facility_name": FACILITIES[fid],
                                                           "title": f"{FACILITIES[fid]} {TITLES[name]}", "synthetic": True},
                    "content": {"mimeType": "text/html", "uri": f"gs://{BUCKET}/manuals/{fid}/{f.name}"}})
    return out


def upload(items: list[dict]) -> None:
    from google.cloud import storage

    b = storage.Client(project=PROJECT).bucket(BUCKET)
    for f in sorted(ROOT.glob("*/*.html")):
        b.blob(f"manuals/{f.parent.name}/{f.name}").upload_from_filename(str(f), content_type="text/html; charset=utf-8")
    b.blob("import/documents.jsonl").upload_from_string("\n".join(json.dumps(d, ensure_ascii=False) for d in items), content_type="application/json")
    print(f"GCS: {len(items)} 文書と documents.jsonl を置きました")


def wait(s: AuthorizedSession, op: dict, label: str, limit: int = 1800) -> dict:
    t0 = time.time()
    while not op.get("done"):
        if time.time() - t0 > limit:
            sys.exit(f"{label}: {limit} 秒たっても終わりません: {op.get('name')}")
        time.sleep(10)
        op = s.get(f"{API}/{op['name']}").json()
        print(f"  {label}: 待機中 {int(time.time() - t0)}s {json.dumps(op.get('metadata', {}), ensure_ascii=False)[:160]}")
    if "error" in op:
        sys.exit(f"{label}: 失敗 {op['error']}")
    print(f"{label}: 完了")
    return op


def ensure(s: AuthorizedSession) -> None:
    if s.get(f"{API}/{COLL}/dataStores/{DS}").status_code == 404:
        r = s.post(f"{API}/{COLL}/dataStores", params={"dataStoreId": DS}, json={
            "displayName": "介護施設の運用マニュアル（架空・デモ）", "industryVertical": "GENERIC", "contentConfig": "CONTENT_REQUIRED",
            "solutionTypes": ["SOLUTION_TYPE_SEARCH"],
            "documentProcessingConfig": {"defaultParsingConfig": {"layoutParsingConfig": {}},
                                         "chunkingConfig": {"layoutBasedChunkingConfig": {"chunkSize": 300, "includeAncestorHeadings": True}}}})
        r.raise_for_status()
        wait(s, r.json(), "データストアの作成")
    if s.get(f"{API}/{COLL}/engines/{ENGINE}").status_code == 404:
        r = s.post(f"{API}/{COLL}/engines", params={"engineId": ENGINE}, json={
            "displayName": "介護施設の運用マニュアル検索（デモ）", "dataStoreIds": [DS], "solutionType": "SOLUTION_TYPE_SEARCH",
            "industryVertical": "GENERIC", "commonConfig": {"companyName": "介護施設（架空）"},
            "searchEngineConfig": {"searchTier": "SEARCH_TIER_ENTERPRISE", "searchAddOns": ["SEARCH_ADD_ON_LLM"]}})
        r.raise_for_status()
        wait(s, r.json(), "検索アプリの作成")
    r = s.patch(f"{API}/{COLL}/dataStores/{DS}/schemas/default_schema", params={"allowMissing": "true"},
                json={"jsonSchema": json.dumps(SCHEMA)})
    r.raise_for_status()
    wait(s, r.json(), "スキーマの更新")


def import_docs(s: AuthorizedSession) -> None:
    r = s.post(f"{API}/{COLL}/dataStores/{DS}/branches/default_branch/documents:import", json={
        "gcsSource": {"inputUris": [f"gs://{BUCKET}/import/documents.jsonl"], "dataSchema": "document"},
        "reconciliationMode": "FULL"})
    r.raise_for_status()
    op = wait(s, r.json(), "文書の取り込み")
    md = op.get("metadata", {})
    if int(md.get("failureCount", 0) or 0):
        sys.exit(f"取り込みに失敗した文書があります: {op.get('response')}")


def check(s: AuthorizedSession) -> int:
    from care.ai.grounding import VertexSearch  # noqa: WPS433

    vs = VertexSearch(serving_config())
    n = 0
    for fid in FACILITIES:
        hits = vs.search("欠員が出たときの連絡順", fid, hint=FACILITIES[fid])
        print(f"{fid}: {len(hits)} 件 {[h.title + ' / ' + h.section for h in hits[:3]]}")
        n += bool(hits) and all(h.facility_id == fid for h in hits)
    return n


def serving_config() -> str:
    return f"{COLL}/engines/{ENGINE}/servingConfigs/default_search"


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    s = session()
    if not a.check:
        items = docs()
        upload(items)
        ensure(s)
        import_docs(s)
    ok = check(s)
    print(f"検索の確認: {ok}/{len(FACILITIES)} 施設で、その施設の文書だけが返りました")
    print(f"GROUNDING_DATASTORE={serving_config()}")
