"""台本のある会話で、チャットからルールを足す流れを API で回して測る（U5）。

  .venv/bin/python -m bench.ux_loop [--llm scripted|gemini] [--only <場面id>...] [--out ../artifacts/ux/loop-<日時>]

1場面ごとに、U0 の基準（artifacts/ux/base/<data>.json の入力と表）から始めて、1手ずつ
  言葉 → translate-inline（今の表を current に） → 候補を選ぶ → solve-inline（足したルール＋前の表を baseline に） → check.py
の順に回す。--llm scripted は台本の draft を返す偽物の LLM（流れの不具合を見る）、gemini は本物（AI の読み違いを見る）。
台本: tests/fixtures/ux_scenarios.yaml
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import yaml

from bench.check import check
from bench.scripted_ai import ScriptedLLM
from bench.translate_eval import _items, _load_env

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCENARIOS = HERE.parent / "tests" / "fixtures" / "ux_scenarios.yaml"
BASE = ROOT / "artifacts" / "ux" / "base"
STAFF_KEYS = ("staff_id", "role", "employment", "skills", "shifts")


def _ai(llm):
    from care.ai.privacy import Masker
    from care.ai.service import AIService
    from care.service import Svc
    from care.store import MemoryRepo

    synth = Path(tempfile.mkdtemp(prefix="synth-"))
    subprocess.run([sys.executable, str(ROOT / "scripts/synth/generate.py"), "--out", str(synth)], check=True, capture_output=True)
    return AIService(Svc(MemoryRepo.from_synth(synth)), llm, Masker(mode="off"), armor=None)


class Counting:
    def __init__(self, inner):
        self.inner, self.n = inner, 0

    def structured(self, **kw):
        self.n += 1
        return self.inner.structured(**kw)

    def __getattr__(self, k):
        return getattr(self.inner, k)


def _soft(res: dict) -> dict[str, int]:
    return {x["label"]: x["count"] for x in res.get("soft_broken") or []}


def run_scene(ai, llm: Counting, sc: dict) -> dict:
    from care.inline_solve import InlineSolveIn, solve_inline
    from care.service import ServiceError

    base = json.loads((BASE / f"{sc['data']}.json").read_text())
    req = copy.deepcopy(base["request"])
    cells = base["result"]["cells"]
    prev_res = base["result"]
    added: list[dict] = []            # {"rule", "label", "index"}
    turns_out = []
    for ti, t in enumerate(sc["turns"]):
        n0, t0 = llm.n, time.time()
        try:
            j = ai.translate_inline(
                t["say"], month=req["month"], staff=[{k: s[k] for k in STAFF_KEYS if k in s} for s in req["staff"]],
                shift_types=req.get("shift_types") or None, staff_id=None, day=None, current=cells,
                carry_in=req.get("carry_in") or None, ip=f"loop-{sc['id']}-{ti}",
            )
            status = 200
        except ServiceError as e:
            j, status = {"kind": "error", "message": str(getattr(e, "message", e))}, e.status
        ai_ms = int((time.time() - t0) * 1000)
        exp = t["expect"]
        bad = _items(exp, j) if status == 200 else ["http"]
        cands = j.get("candidates") or []
        row = {
            "say": t["say"], "status": status, "kind": j.get("kind"),
            "ai": {"type_ok": status == 200 and not {"kind", "rule_type", "candidates"} & set(bad), "items_ok": not bad, "bad": bad,
                   "n_candidates": len(cands), "ms": ai_ms, "llm_calls": llm.n - n0,
                   "message": j.get("message"), "labels": [c["label"] for c in cands][:4],
                   "impact": [((c.get("impact") or {}).get("broken_now")) for c in cands][:4]},
            "input": {"utterances": 1, "choose": t.get("choose"), "manual_fix": 0},
        }
        choose = t.get("choose")
        if choose is not None and status == 200 and len(cands) > choose:
            c = cands[choose]
            req["rules"] = [*(req.get("rules") or []), c["rule"]]
            req["baseline"] = cells
            added.append({"label": c["label"], "index": len(req["rules"]) - 1, "broken_before": (c.get("impact") or {}).get("broken_now")})
            s0 = time.time()
            try:
                res = solve_inline(InlineSolveIn.model_validate(req))
                sstat = 200
            except ServiceError as e:
                res, sstat = {"status": "ERROR", "explanation": [str(getattr(e, "message", e))]}, e.status
            except Exception as e:  # noqa: BLE001  422 相当（入力検証）
                res, sstat = {"status": "INVALID", "explanation": [str(e).splitlines()[0][:200]]}, 422
            solve_ms = int((time.time() - s0) * 1000)
            made = res.get("status") in ("OPTIMAL", "FEASIBLE") and bool(res.get("cells"))
            chk = check(req, res) if made else {}
            rc = {x["index"]: x for x in chk.get("rules_check") or []}
            kept = {a["label"]: rc.get(a["index"], {}).get("broken") for a in added}
            before_soft, after_soft = _soft(prev_res), _soft(res)
            mine = {a["label"] for a in added}       # 足したルール自身の破れは「足したルールの破れ」で数える
            new_broken = {k: v for k, v in after_soft.items() if v > before_soft.get(k, 0) and k not in mine}
            row["solve"] = {
                "http": sstat, "status": res.get("status"), "made": made, "ms": solve_ms,
                "changed": (res.get("changed") or {}).get("count"), "broken_before": added[-1]["broken_before"],
                "added_broken": kept, "new_soft_broken": new_broken, "explanation": (res.get("explanation") or [])[:3],
                "explanation_all": res.get("explanation") or [],
                "hard": chk.get("hard"),
            }
            if made:
                cells, prev_res = res["cells"], res
        turns_out.append(row)

    # 場面の判定（台本の check）
    ck = sc.get("check") or {}
    verdict = {}
    last = next((r["solve"] for r in reversed(turns_out) if "solve" in r), None)
    if "rule_kept" in ck and last:
        verdict["rule_kept"] = (all(v == 0 for v in last["added_broken"].values()) and last["made"]) == ck["rule_kept"]
    if "changed_ratio_max" in ck:
        oks = []
        for r in turns_out:
            s = r.get("solve")
            if not s or not s["made"] or s["changed"] is None:
                continue
            lim = ck["changed_ratio_max"] * (s["broken_before"] or 0)
            oks.append(s["changed"] <= lim)
        verdict["changed_within"] = all(oks) if oks else None
    if ck.get("explain_mentions_rule") and last:
        lbl = [r["ai"]["labels"][r["input"]["choose"]] for r in turns_out if "solve" in r][-1]
        verdict["explain_mentions_rule"] = any(lbl in ln for ln in last["explanation_all"])
    if "made" in ck and last:
        verdict["made"] = last["made"] == ck["made"]
    verdict["ai_all_ok"] = all(r["ai"]["items_ok"] for r in turns_out)
    return {"id": sc["id"], "data": sc["data"], "source": sc.get("source"), "kind": sc.get("kind"), "turns": turns_out,
            "verdict": verdict, "ok": all(v is not False for v in verdict.values()),
            "inputs": {"utterances": len(turns_out), "chosen": sum(1 for r in turns_out if "solve" in r), "manual_fix": 0}}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--llm", choices=["scripted", "gemini"], default="scripted")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--out")
    args = ap.parse_args()
    scenes = yaml.safe_load(SCENARIOS.read_text())
    if args.only:
        scenes = [s for s in scenes if s["id"] in set(args.only)]
    if args.llm == "gemini":
        _load_env()
        from care.ai.llm import GeminiLLM
        inner = GeminiLLM()
    else:
        inner = ScriptedLLM([{"utterance": t["say"], "draft": t["draft"]} for s in scenes for t in s["turns"]])
    llm = Counting(inner)
    ai = _ai(llm)

    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out = Path(args.out or ROOT / "artifacts" / "ux" / f"loop-{args.llm}-{stamp}")
    rows = []
    for sc in scenes:
        r = run_scene(ai, llm, sc)
        rows.append(r)
        print(f"{sc['id']}: {'OK' if r['ok'] else 'NG'} {r['verdict']}", flush=True)
    import os
    model = os.getenv("GEMINI_PRO_MODEL", "既定") if args.llm == "gemini" else "台本の答え"
    out.parent.mkdir(parents=True, exist_ok=True)
    Path(f"{out}.json").write_text(json.dumps({"at": stamp, "llm": args.llm, "model": model, "scenes": rows}, ensure_ascii=False, indent=1))
    Path(f"{out}.md").write_text(_md(rows, args.llm, model, stamp))
    print(f"-> {out}.md")


def _md(rows: list[dict], llm: str, model: str, stamp: str) -> str:
    turns = [t for r in rows for t in r["turns"]]
    solves = [t["solve"] for t in turns if "solve" in t]
    L = [f"# U5 台本のある会話（{llm}・{model}・{stamp}）", "",
         f"- 場面 {sum(r['ok'] for r in rows)}/{len(rows)} OK・発話 {len(turns)}・AI の型が合った {sum(t['ai']['type_ok'] for t in turns)}/{len(turns)}・"
         f"項目まで {sum(t['ai']['items_ok'] for t in turns)}/{len(turns)}",
         f"- 解き直し {len(solves)} 回：作れた {sum(s['made'] for s in solves)}・足したルールが守られた "
         f"{sum(1 for s in solves if s['made'] and all(v == 0 for v in s['added_broken'].values()))}・"
         f"変わったセル 中央値 {sorted(s['changed'] or 0 for s in solves)[len(solves) // 2] if solves else '—'}", "",
         "| 場面 | データ | 区分 | 発話 | 選択 | AI | 候補 | 今の表の破れ | 解き直し | 変わったセル | 足したルールの破れ | 新しく破れた | 判定 |",
         "|---|---|---|--:|--:|---|--:|---|---|--:|---|---|---|"]
    for r in rows:
        for i, t in enumerate(r["turns"]):
            a, s = t["ai"], t.get("solve")
            ai_s = ("○" if a["items_ok"] else "×" + ",".join(a["bad"])) + f" {t['kind']} {a['ms']}ms" + (f"（{a['llm_calls']}回）" if a["llm_calls"] > 1 else "")
            sv = f"{s['status']} {s['ms']}ms" if s else "—"
            L.append(f"| {r['id'] if i == 0 else ''} | {r['data'] if i == 0 else ''} | {r.get('kind') or '' if i == 0 else ''} | {i + 1} | "
                     f"{t['input']['choose'] if t['input']['choose'] is not None else '—'} | {ai_s} | {a['n_candidates']} | "
                     f"{s['broken_before'] if s else '—'} | {sv} | {s['changed'] if s else '—'} | "
                     f"{', '.join(f'{v}' for v in s['added_broken'].values()) if s else '—'} | "
                     f"{', '.join(f'{k}+{v}' for k, v in s['new_soft_broken'].items()) if s and s['new_soft_broken'] else '—'} | "
                     f"{('OK' if r['ok'] else 'NG ' + ', '.join(k for k, v in r['verdict'].items() if v is False)) if i == len(r['turns']) - 1 else ''} |")
    L += ["", "## 言葉と説明（先頭3行）", ""]
    for r in rows:
        L.append(f"### {r['id']}（{r.get('source') or ''}）")
        for t in r["turns"]:
            a = t["ai"]
            L.append(f"- 師長：「{t['say']}」")
            if a["labels"]:
                L.append(f"  - 候補：{' ／ '.join(a['labels'])}")
            if a["message"]:
                L.append(f"  - AI：{a['message']}")
            if t.get("solve"):
                for ln in t["solve"]["explanation"]:
                    L.append(f"  - 説明：{ln}")
        L.append("")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    main()
