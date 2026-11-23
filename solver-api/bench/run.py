"""変換した入力を solve-inline に通し、check.py で確かめて、1行ずつ表にする。

  .venv/bin/python -m bench.run <入力のフォルダ>... --out <結果のjson>
  （--http URL を付けると、ローカルの API サーバーに POST する。付けなければ同じ処理を関数で呼ぶ）
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

from bench.check import check


def solve_local(req: dict) -> tuple[int, dict]:
    from pydantic import ValidationError

    from care.inline_solve import InlineSolveIn, solve_inline
    from care.service import ServiceError
    try:
        return 200, solve_inline(InlineSolveIn.model_validate(req))
    except ValidationError as e:
        return 422, {"detail": str(e).splitlines()[:3]}
    except ServiceError as e:
        return e.status, {"detail": e.message if hasattr(e, "message") else str(e)}


def solve_http(url: str, req: dict) -> tuple[int, dict]:
    r = urllib.request.Request(url, data=json.dumps(req).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=120) as f:
            return f.status, json.loads(f.read())
    except urllib.error.HTTPError as e:
        return e.code, {"detail": e.read().decode()[:300]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--http")
    ap.add_argument("--only")
    a = ap.parse_args()
    files = sorted(p for d in a.dirs for p in Path(d).glob("*.json"))
    if a.only:
        files = [p for p in files if a.only in p.name]
    rows = []
    for p in files:
        inst = json.loads(p.read_text())
        t0 = time.time()
        code, res = solve_http(a.http, inst["request"]) if a.http else solve_local(inst["request"])
        row = {"name": inst["name"], "kind": inst["meta"].get("kind", "ベンチマーク"), "staff": len(inst["request"]["staff"]),
               "days": inst["meta"]["days"], "http": code, "sec": round(time.time() - t0, 1), "dropped": inst["meta"].get("dropped", []),
               "expect": inst["meta"].get("expect")}
        if code == 200:
            row |= check(inst["request"], res, inst["meta"])
            row["explanation"] = res.get("explanation")
        else:
            row["detail"] = res.get("detail")
        rows.append(row)
        h = row.get("hard") or {}
        print(f"{row['name'][:30]:30s} {code} {row.get('status', '-'):10s} {row['sec']:5.1f}s made={row.get('made')} "
              f"hard={sum(h.values())} labor={sum((row.get('labor') or {}).values())} short={row.get('orig_short')}/{row.get('orig_need')} "
              f"off={row.get('day_off')}", flush=True)
    Path(a.out).write_text(json.dumps(rows, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
