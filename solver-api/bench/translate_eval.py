"""評価用の文（tests/fixtures/rule_sentences.yaml）を、本物の LLM で translate-inline に通して数える（Q6 の実測）。

  .venv/bin/python -m bench.translate_eval --out ../artifacts/ux/q6-gemini
  （GEMINI_API_KEY は solver-api/.env から読む。DLP は使わない：文は架空の EMP-xxx だけで、氏名を含まない）

数えるもの
- 型が合った：返った種類（候補・設定の案内・書けません）と、候補なら1本目の型が期待と同じ
- 項目が合った：期待に書いた項目（強さ・回数・曜日・並びの長さ・設定の欄・書けない理由など）がすべて同じ
- 書けない条件に「書けません」を返した割合、書ける条件に誤って「書けません」を返した数
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SENTENCES = HERE.parent / "tests" / "fixtures" / "rule_sentences.yaml"


def _load_env() -> None:
    env = HERE.parent / ".env"
    if env.exists():
        for ln in env.read_text().splitlines():
            if "=" in ln and not ln.lstrip().startswith("#"):
                k, v = ln.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _staff(shift_types: list[dict] | None) -> list[dict]:
    """tests/test_translate_inline_q6.py の _default_staff と同じ8人。"""
    shifts = [st["id"] for st in shift_types] if shift_types else ["早番", "日勤", "遅番", "夜勤"]
    roles = ["主任", "介護福祉士", "介護職員", "新人", "看護師", "介護職員", "新人", "介護福祉士"]
    return [
        {"staff_id": f"EMP-{i:03d}", "role": roles[i - 1], "employment": "常勤" if i <= 7 else "パート",
         "skills": ["medical"] if i <= 3 else [], "shifts": list(shifts)}
        for i in range(1, 9)
    ]


def _items(exp: dict, j: dict) -> list[str]:
    """期待の項目のうち、合わなかったものの名前を返す（空なら全部合った）。"""
    bad: list[str] = []
    if j.get("kind") != exp["kind"]:
        return ["kind"]
    if exp["kind"] == "setting":
        return [] if j.get("setting_field") == exp["setting_field"] else ["setting_field"]
    if exp["kind"] == "unsupported":
        return [] if j.get("unsupported_kind") == exp["unsupported_kind"] else ["unsupported_kind"]
    if exp["kind"] == "ask":
        return []
    cands = j.get("candidates") or []
    if not cands:
        return ["candidates"]
    c0, r = cands[0], cands[0]["rule"]
    if r.get("type") != exp["rule_type"]:
        return ["rule_type"]
    if "strength" in exp and c0.get("strength") != exp["strength"]:
        bad.append("strength")
    if "scopes_include" in exp and not set(exp["scopes_include"]) <= {c["scope"] for c in cands}:
        bad.append("scopes")
    if "pattern_len" in exp and len(r.get("pattern") or []) != exp["pattern_len"]:
        bad.append("pattern_len")
    for k in ("max_run", "at_least", "at_most", "target", "max_spread"):
        if k in exp and r.get(k) != exp[k]:
            bad.append(k)
    if "weekdays" in exp and sorted(((r.get("days") or {}).get("weekdays")) or []) != sorted(exp["weekdays"]):
        bad.append("weekdays")
    if "start_weekdays" in exp and sorted(((r.get("starts") or {}).get("weekdays")) or []) != sorted(exp["start_weekdays"]):
        bad.append("start_weekdays")
    if "dates" in exp:
        day_obj = r.get("starts") or r.get("days") or {}
        if sorted(day_obj.get("dates") or []) != sorted(exp["dates"]):
            bad.append("dates")
    return bad


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="出力の先頭（.json と .md を書く）")
    ap.add_argument("--only", nargs="*", help="この id の文だけ流す")
    args = ap.parse_args()

    _load_env()
    from care.ai.llm import GeminiLLM
    from care.ai.privacy import Masker
    from care.ai.service import AIService
    from care.service import ServiceError, Svc
    from care.store import MemoryRepo

    synth = Path(tempfile.mkdtemp(prefix="synth-"))
    subprocess.run([sys.executable, str(ROOT / "scripts/synth/generate.py"), "--out", str(synth)], check=True, capture_output=True)
    svc = Svc(MemoryRepo.from_synth(synth))
    class Counting:
        """呼び出しの回数を数える（数が抜けたときのやり直しを見るため）"""
        def __init__(self, inner):
            self.inner, self.n = inner, 0

        def structured(self, **kw):
            self.n += 1
            return self.inner.structured(**kw)

        def __getattr__(self, k):
            return getattr(self.inner, k)

    llm = Counting(GeminiLLM())
    ai = AIService(svc, llm, Masker(mode="off"), armor=None)

    cases = yaml.safe_load(SENTENCES.read_text())
    if args.only:
        cases = [c for c in cases if c["id"] in set(args.only)]

    rows = []
    for i, c in enumerate(cases):
        st = c.get("shift_types") or None
        t0, n0 = time.time(), llm.n
        try:
            j = ai.translate_inline(c["utterance"], month="2026-11", staff=_staff(st), shift_types=st,
                                    staff_id=c.get("staff_id"), day=c.get("day"), current=None, carry_in=None,
                                    ip=f"eval-{i}")
            status = 200
        except ServiceError as e:
            j, status = {"kind": "error", "detail": str(getattr(e, "message", e))}, e.status
        ms = int((time.time() - t0) * 1000)
        exp = c["expect"]
        bad = _items(exp, j) if status == 200 else ["http"]
        type_ok = status == 200 and "kind" not in bad and "rule_type" not in bad and "candidates" not in bad
        cands = j.get("candidates") or []
        rows.append({
            "id": c["id"], "source": c.get("source"), "utterance": c["utterance"], "expect": exp,
            "status": status, "kind": j.get("kind"), "got_type": (cands[0]["rule"]["type"] if cands else j.get("kind")),
            "type_ok": type_ok, "items_ok": not bad, "bad": bad, "n_candidates": len(cands),
            "labels": [x["label"] for x in cands][:4], "message": j.get("message") or j.get("detail"),
            "draft": j.get("draft"), "setting_field": j.get("setting_field"), "unsupported_kind": j.get("unsupported_kind"),
            "ms": ms, "llm_calls": llm.n - n0, "holdout": bool(c.get("holdout")),
        })
        print(f"[{i + 1}/{len(cases)}] {c['id']}: type={'OK' if type_ok else 'NG'} items={'OK' if not bad else bad} {ms}ms",
              flush=True)

    def summarize(rs: list[dict]) -> dict:
        n = len(rs)
        uns = [r for r in rs if r["expect"]["kind"] == "unsupported"]
        sup = [r for r in rs if r["expect"]["kind"] != "unsupported"]
        return {
            "n": n,
            "type_ok": sum(r["type_ok"] for r in rs),
            "items_ok": sum(r["items_ok"] for r in rs),
            "unsupported_ok": sum(r["kind"] == "unsupported" for r in uns), "unsupported_n": len(uns),
            "false_unsupported": sum(r["kind"] == "unsupported" for r in sup),
            "setting_ok": sum(r["kind"] == "setting" for r in rs if r["expect"]["kind"] == "setting"),
            "setting_n": sum(r["expect"]["kind"] == "setting" for r in rs),
            "ask": sum(r["kind"] == "ask" for r in rs),
            "retried": sum(r["llm_calls"] > 1 for r in rs),
            "errors": sum(r["status"] != 200 for r in rs),
            "ms_median": sorted(r["ms"] for r in rs)[n // 2] if rs else 0,
        }

    groups = {"全体": rows, "元の文": [r for r in rows if not r["holdout"]], "測り直し専用": [r for r in rows if r["holdout"]]}
    summary = {k: summarize(v) for k, v in groups.items() if v}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().isoformat(timespec="seconds")
    Path(f"{out}.json").write_text(json.dumps({"at": stamp, "summary": summary, "rows": rows}, ensure_ascii=False, indent=1))

    pct = lambda a, b: f"{a}/{b}（{100 * a // b if b else 0}%）"  # noqa: E731
    md = [f"# Q6 評価用の文を本物の LLM で（{stamp}・{os.getenv('GEMINI_RULE_MODEL', 'gemini-3.8-flash')}）", "",
          "| | " + " | ".join(summary) + " |", "|---|" + "---|" * len(summary)]
    for key, lbl in [("type_ok", "型が合った"), ("items_ok", "項目まで合った")]:
        md.append(f"| {lbl} | " + " | ".join(pct(v[key], v["n"]) for v in summary.values()) + " |")
    md.append("| 書けない条件に「書けません」 | " + " | ".join(pct(v["unsupported_ok"], v["unsupported_n"]) for v in summary.values()) + " |")
    md.append("| 入力欄の案内 | " + " | ".join(pct(v["setting_ok"], v["setting_n"]) for v in summary.values()) + " |")
    for key, lbl in [("false_unsupported", "書ける条件に誤って「書けません」"), ("ask", "聞き返した"), ("retried", "数を入れ直させた"),
                     ("errors", "エラー（422 など）"), ("ms_median", "時間の中央値（ms）")]:
        md.append(f"| {lbl} | " + " | ".join(str(v[key]) for v in summary.values()) + " |")
    md += ["",
          "| id | 言葉 | 期待 | 返った | 型 | 項目 | 呼出 | ms | 備考 |", "|---|---|---|---|:-:|:-:|--:|--:|---|"]
    for r in rows:
        e = r["expect"]
        want = e.get("rule_type") or f"{e['kind']}:{e.get('setting_field') or e.get('unsupported_kind') or ''}"
        got = r["got_type"] if r["kind"] == "candidates" else f"{r['kind']}:{r.get('setting_field') or r.get('unsupported_kind') or ''}"
        note = ", ".join(r["bad"]) if r["bad"] else (r["labels"][0] if r["labels"] else "")
        if r["kind"] == "ask":
            note = str(r["message"])[:60]
        if r["status"] != 200:
            note = f"{r['status']} {str(r['message'])[:80]}"
        hid = f"{r['id']}（測り直し）" if r["holdout"] else r["id"]
        md.append(f"| {hid} | {r['utterance']} | {want} | {got} | {'○' if r['type_ok'] else '×'} | "
                  f"{'○' if r['items_ok'] else '×'} | {r['llm_calls']} | {r['ms']} | {note} |")
    Path(f"{out}.md").write_text("\n".join(md) + "\n")
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
