import json
import random

import numpy as np
import pytest
from fastapi.testclient import TestClient

from care import guard, server
from care.ai.chat import ChatTools
from care.learn import scoring, train
from care.learn.analytics import FakeAnalytics
from care.learn.detect import detect_daily, detect_roster, threshold, to_rule
from care.learn.features import FEATURES, row_features
from care.learn.store import MemoryModelStore
from care.service import ServiceError, Svc
from care.store import MemoryRepo


def load(synth, name):
    return [json.loads(line) for line in open(synth / f"{name}.ndjson", encoding="utf-8")]


@pytest.fixture()
def offers(synth):
    return load(synth, "fact_offers")


def rows_of(offers, fid):
    return [r for r in offers if r["facility_id"] == fid]


# ---------------------------------------------------------------- 学習・採点

def test_pure_python_scoring_matches_sklearn(offers):
    rows = rows_of(offers, "fac-sakura")
    out = train.train_facility("fac-sakura", rows, version="t1")
    art = out["artifact"]
    assert art["kind"] in ("logistic", "pooled_logistic") and art["gate"]["passed"]
    stats, base = train._stats(rows)                       # 成果物の統計と同じ前提で、sklearn の予測と比べる
    X = train._matrix(rows, art["staff_stats"], art["base_rate"], loo=False)
    ref = out["sk"].predict_proba(X)[:, 1]
    mine = np.array([scoring.predict(art, r) for r in rows])
    assert np.max(np.abs(ref - mine)) < 1e-9
    assert json.loads(json.dumps(art))["version"] == "t1"                      # JSON にできる


def test_xgboost_dump_scoring_matches_xgboost(offers):
    rows = rows_of(offers, "fac-sakura")
    stats, base = train._stats(rows)
    X = train._matrix(rows, stats, base, loo=True)
    y = np.array([train.label(r) for r in rows])
    model = train._fit_xgb(X, y)
    art = {"schema": 1, "kind": "xgboost", "features": FEATURES, "staff_stats": stats, "base_rate": base, "xgb": train._xgb_artifact(model[2])}
    ref = model[2].predict_proba(train._matrix(rows, stats, base, loo=False))[:, 1]
    mine = np.array([scoring.predict(art, r) for r in rows])
    assert np.max(np.abs(ref - mine)) < 1e-5


def test_gate_promotes_learnable_facilities_and_blocks_the_rest(offers):
    res = {}
    for fid in ("fac-sakura", "fac-midori", "fac-hidamari"):
        res[fid] = train.train_facility(fid, rows_of(offers, fid), other_rows=[r for r in offers if r["facility_id"] != fid])["artifact"]
    assert res["fac-sakura"]["gate"]["passed"] and res["fac-midori"]["gate"]["passed"]
    assert res["fac-sakura"]["metrics"][res["fac-sakura"]["kind"]]["auc"] > 0.7
    h = res["fac-hidamari"]
    assert not h["gate"]["passed"] and h["gate"]["reasons"]                       # 基準に勝てないモデルは昇格しない
    assert h["metrics"]["baseline"]["logloss"] < h["metrics"][h["kind"]]["logloss"]
    # 比べた候補が成果物に残る（選んだ根拠を報告できる）
    assert {"logistic", "xgboost", "pooled_logistic", "baseline"} <= set(k for k, v in h["metrics"].items() if isinstance(v, dict))


def test_too_few_rows_never_promotes(offers):
    art = train.train_facility("x", rows_of(offers, "fac-hidamari")[:30])["artifact"]
    assert not art["gate"]["passed"] and "件数が少なすぎます" in art["gate"]["reasons"][0]


def test_features_use_only_what_is_known_at_offer_time(offers):
    r = dict(rows_of(offers, "fac-sakura")[0])
    base = row_features(r, {}, 0.5)
    r2 = {**r, "status": "accepted" if r["status"] != "accepted" else "declined", "response_min": 1.0, "responded_at": "x"}
    assert row_features(r2, {}, 0.5) == base                                       # 結果・応答時間は特徴量に入らない
    assert len(base) == len(FEATURES)


# ---------------------------------------------------------------- 反復検出

def test_detection_recovers_hidden_rules_without_false_alarms(synth):
    truth = json.load(open(synth / "truth.json", encoding="utf-8"))["facilities"]
    staff = load(synth, "dim_staff")
    edits, tasks = load(synth, "fact_roster_edits"), load(synth, "fact_task_edits")
    found_total = hidden_total = 0
    for fid, t in truth.items():
        n = sum(1 for s in staff if s["facility_id"] == fid)
        c = detect_roster([e for e in edits if e["facility_id"] == fid], n_staff=n, now_month="2026-10")
        d = detect_daily([e for e in tasks if e["facility_id"] == fid], n_staff=n)
        hidden = {(r["staff_id"], r["weekday"], r["shift"]) for r in t["hidden_rules"]}
        got = {(x["staff_id"], x["weekday"], x["shift"]) for x in c}
        assert got <= hidden                                                         # 誤検出なし
        habits = {(h["staff_id"], h["block"], h["task"]) for h in t["task_habits"]}
        assert {(x["staff_id"], x["time_block"], x["task"]) for x in d} == habits   # 日次は全件再現
        found_total += len(got)
        hidden_total += len(hidden)
    assert found_total >= 7 and hidden_total == 9                                    # 月次は 9 件中 7 件以上（残りは繰り返しが少なすぎた）


def test_threshold_is_computed_from_observations_not_fixed():
    assert threshold(10, 28 * 7 * 4 // 10, 5) >= 3
    sparse = threshold(10, 2000, 4)
    dense = threshold(10, 100, 40)                                                   # 手修正が多い施設ほど、偶然の重なりが増えるので閾値は上がる
    assert dense >= sparse
    assert threshold(0, 100, 5) == 3


def test_random_edits_do_not_create_candidates():
    rng = random.Random(1)
    false_alarms = 0
    for trial in range(30):
        es = []
        for m in range(1, 11):
            for _ in range(8):
                d = rng.randint(1, 28)
                es.append({"edit_id": f"e{trial}-{len(es)}", "staff_id": f"S-{rng.randint(1, 20):03d}", "date": f"2026-{m:02d}-{d:02d}",
                           "weekday": rng.randint(0, 6), "from_shift": rng.choice(["早番", "日勤", "遅番", "夜勤"]), "to_shift": "休"})
        false_alarms += len(detect_roster(es, n_staff=20, now_month="2026-10"))
    from care.learn.detect import ALPHA

    assert false_alarms / 30 <= ALPHA                                                # 偶然の候補は、観測期間あたり ALPHA 件以下（設計どおり）


def test_candidate_to_rule_is_valid_dsl_with_origin_and_term():
    c = {"kind": "roster", "key": "roster:S-1:4:夜勤", "staff_id": "S-1", "weekday": 4, "shift": "夜勤", "evidence": "過去10か月のうち6か月、木曜の夜勤を外した",
         "edit_ids": ["e1", "e2"], "threshold": 3}
    from care.dsl import Request

    r = Request.model_validate(to_rule(c, {"S-1": "田中 花"}))
    assert r.origin.kind == "反復検出" and r.origin.detected_from == ["e1", "e2"] and r.lifecycle.expires_on is None
    r3 = Request.model_validate(to_rule(c, {"S-1": "田中 花"}, term_months=3))
    assert r3.lifecycle.expires_on is not None and "木曜の夜勤に入らない" in r3.label


# ---------------------------------------------------------------- API への反映

def make_client(synth, offers, with_models=True):
    guard.reset()
    repo = MemoryRepo.from_synth(synth)
    champ, hist = {}, {}
    if with_models:
        a = train.train_facility("fac-sakura", rows_of(offers, "fac-sakura"), version="t1")["artifact"]
        champ["fac-sakura"] = scoring.load(json.dumps(a))
        hist["fac-sakura"] = [{"version": "t0", "rows": 100, "auc": 0.6, "gate_passed": False}, {"version": "t1", "rows": 412, "auc": a["metrics"][a["kind"]]["auc"], "gate_passed": True}]
    truth = json.load(open(synth / "truth.json", encoding="utf-8"))["facilities"]["fac-sakura"]
    staff = [s for s in load(synth, "dim_staff") if s["facility_id"] == "fac-sakura"]
    edits = [e for e in load(synth, "fact_roster_edits") if e["facility_id"] == "fac-sakura"]
    cands = detect_roster(edits, n_staff=len(staff), now_month="2026-10")
    learned = {"fac-sakura": {"facility_id": "fac-sakura", "detected_at": "2026-11-10T00:00:00Z", "edits_seen": len(edits), "candidates": cands}}
    svc = Svc(repo, models=MemoryModelStore(champ, hist, learned))
    server.set_service(svc)
    return TestClient(server.app), svc


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    server.set_service(None)


def _vacancy(client, fid, shift="日勤", day=12, **extra):
    cur = client.get(f"/api/v1/facilities/{fid}/rosters/2026-11").json()["current"]
    sid = next(s for s, row in cur.items() if row[day - 1] == shift)
    r = client.post(f"/api/v1/facilities/{fid}/vacancies", json={"date": f"2026-11-{day:02d}", "shift": shift, "absent_staff_id": sid, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def test_candidates_are_ranked_by_predicted_acceptance(synth, offers):
    client, svc = make_client(synth, offers)
    j = _vacancy(client, "fac-sakura", discovered_at="2026-11-12T00:00:00Z")           # 直前の欠員
    c = j["candidates"]
    assert c and all(x["accept_probability"] is not None for x in c)
    ps = [x["accept_probability"] for x in c]
    assert ps == sorted(ps, reverse=True) or [x["rank_score"] if "rank_score" in x else 0 for x in c] == sorted([x.get("rank_score", 0) for x in c], reverse=True)
    assert "応諾の見込み" in c[0]["reasons"][0] and "学習" in c[0]["reasons"][0]
    # 余裕のある欠員は、直前の欠員より応諾確率が高い（モデルが「余裕」を学習している）
    far = _vacancy(client, "fac-sakura", day=20, discovered_at="2026-11-10T00:00:00Z")["candidates"]
    avg = lambda xs: sum(x["accept_probability"] for x in xs) / len(xs)               # noqa: E731
    assert avg(far) > avg(c)


def test_facility_without_champion_keeps_heuristic_ranking(synth, offers):
    client, svc = make_client(synth, offers)
    j = _vacancy(client, "fac-hidamari")
    assert j["candidates"] and all(x["accept_probability"] is None for x in j["candidates"])
    assert all("応諾の見込み" not in " ".join(x["reasons"]) for x in j["candidates"])
    info = client.get("/api/v1/facilities/fac-hidamari/models/acceptance").json()
    assert info["using_model"] is False and "基準" in info["note"]


def test_model_info_and_history(synth, offers):
    client, svc = make_client(synth, offers)
    i = client.get("/api/v1/facilities/fac-sakura/models/acceptance").json()
    assert i["using_model"] and i["champion"]["version"] == "t1" and i["champion"]["auc"] > 0.7
    assert [h["version"] for h in i["history"]] == ["t0", "t1"]
    assert "coef" not in json.dumps(i) and "staff_stats" not in json.dumps(i)           # 係数・人ごとの統計は出さない


def test_offer_records_features_and_event(synth, offers):
    client, svc = make_client(synth, offers)
    j = _vacancy(client, "fac-sakura")
    vid, top = j["vacancy"]["vacancy_id"], j["candidates"][0]
    o = client.post(f"/api/v1/facilities/fac-sakura/vacancies/{vid}/offers", json={"staff_id": top["staff_id"]}).json()
    f = o["features"]
    assert set(f) >= {"lead_hours", "weekday", "shift", "same_unit", "skill_match", "consec_before", "month_hours_before", "nights_last30", "offers_last14", "tenure_years", "employment"}
    ev = next(e for e in svc.events.local if e["event_type"] == "offer_sent")
    assert json.loads(ev["payload"])["features"] == f                                    # 学習に使えるよう、特徴量をイベントに残す
    # 特徴量は fact_offers の列と同じ名前 → 学習の入力にそのまま使える
    assert len(row_features({**f, "staff_id": top["staff_id"], "status": ""}, {}, 0.5)) == len(FEATURES)


def test_learned_rules_adopt_dismiss_and_never_ask_twice(synth, offers):
    client, svc = make_client(synth, offers)
    P = "/api/v1/facilities/fac-sakura"
    r = client.get(f"{P}/learned-rules", params={"month": "2026-11"}).json()
    assert len(r["candidates"]) == 3 and r["edits_seen"] > 0
    c0, c1 = r["candidates"][0], r["candidates"][1]
    assert c0["evidence"] and c0["question"].endswith("というルールにしますか？") and [x["label"] for x in c0["choices"]] == ["ずっと続ける（期限なし）", "3か月だけ"]
    assert "broken_now" in c0["impact"]
    assert client.post(f"{P}/rules", json=c0["choices"][1]["rule"]).status_code == 201          # 3か月だけで採用
    assert client.post(f"{P}/learned-rules/dismiss", json={"key": c1["key"], "reason": "作らない"}).json()["dismissed"]
    r2 = client.get(f"{P}/learned-rules").json()
    assert {c["key"] for c in r2["candidates"]} == {c["key"] for c in r["candidates"]} - {c0["key"], c1["key"]}   # 一度答えたら、もう聞かない
    # 採用したルールは、次の求解で守られる
    sol = client.post(f"{P}/rosters/2026-11/solve", json={"time_limit": 10, "daily": False}).json()
    assert sol["status"] == "OPTIMAL"
    assert client.get("/api/v1/facilities/fac-hidamari/learned-rules").json()["candidates"] == []


# ---------------------------------------------------------------- チャットの学習ツール

def test_chat_learning_tools_are_read_only_and_not_free_sql(synth, offers):
    client, svc = make_client(synth, offers)
    fake = FakeAnalytics({"offer_acceptance_by_shift": [{"shift": "夜勤", "offers": 10, "accept_rate": 0.3}]})
    t = ChatTools(svc, "fac-sakura", "2026-11", fake)
    assert t.analytics_stats("offer_acceptance_by_shift")["rows"][0]["shift"] == "夜勤" and fake.calls == [("offer_acceptance_by_shift", "fac-sakura")]
    with pytest.raises(ValueError):
        t.analytics_stats("DROP TABLE x")                                                  # 決まった問い合わせ以外は実行できない
    assert t.acceptance_model_info()["using_model"] is True
    assert len(t.learned_rule_candidates()["candidates"]) == 3
    with pytest.raises(ServiceError):
        ChatTools(svc, "fac-sakura", "2026-11", None).analytics_stats("offer_acceptance_by_shift")
    from care.ai.chat import DECLS

    enum = next(d for d in DECLS if d["name"] == "analytics_stats")["parameters"]["properties"]["kind"]["enum"]
    assert set(enum) == set(FakeAnalytics().kinds())


def test_gcs_keys_have_no_leading_slash_when_root_has_no_folder():
    from care.learn.steps import _key

    assert _key("", "runs/x/model.joblib") == "runs/x/model.joblib"            # root が gs://バケット だけのとき
    assert _key("dryrun", "runs/x") == "dryrun/runs/x"


def test_daily_evidence_uses_japanese_task_names(synth):
    staff = load(synth, "dim_staff")
    tasks = [e for e in load(synth, "fact_task_edits") if e["facility_id"] == "fac-sakura"]
    d = detect_daily(tasks, n_staff=sum(1 for s in staff if s["facility_id"] == "fac-sakura"))
    assert d and all(not any(k in c["evidence"] for k in ("bath", "meal", "round")) for c in d)


def test_run_id_from_pipeline_job_is_a_string_version():
    from care.learn.steps import RUNS_SCHEMA, SCORES_SCHEMA, rid

    assert rid("5215997950018191360") == "run-5215997950018191360"            # ジョブ ID は数字だけ。BigQuery に整数と誤判定させない
    assert rid("v20261109163138") == "v20261109163138"
    assert dict(RUNS_SCHEMA)["version"] == "STRING" and dict(SCORES_SCHEMA)["model_version"] == "STRING"
