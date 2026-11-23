"""2つの bench.run 出力 JSON を比較し、変わった入力だけを表示する。

使い方:
  .venv/bin/python bench/compare.py <前.json> <後.json>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def _hard(r: dict) -> int:
    return sum((r.get("hard") or {}).values())


def _labor(r: dict) -> int:
    return sum((r.get("labor") or {}).values())


def _fmt_short(r: dict) -> str:
    s, n = r.get("orig_short"), r.get("orig_need")
    return "-" if s is None else f"{s}/{n}"


def _fmt_off(r: dict) -> str:
    o = r.get("day_off")
    return "-" if o is None else f"{o[0]}/{o[1]}"


def _fmt_state(r: dict) -> str:
    return f"{r.get('http')}/{r.get('status', '-')}/made={r.get('made')}"


def _sec_changed(a: float, b: float) -> bool:
    hi, lo = max(a, b), min(a, b)
    if hi < 0.5:
        return False
    return lo == 0 or (hi / lo) >= 2.0


def _load(paths: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for p in paths:
        for row in json.loads(Path(p).read_text()):
            out[row["name"]] = row
    return out


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 2 or len(args) % 2 != 0:
        sys.exit("usage: compare.py <before.json> <after.json>")
    half = len(args) // 2
    before = _load(args[:half])
    after = _load(args[half:])
    names = sorted(set(before) | set(after))

    changed = 0
    for name in names:
        a, b = before.get(name), after.get(name)
        if a is None:
            print(f"+ {name}: (新規) {_fmt_state(b)}")
            changed += 1
            continue
        if b is None:
            print(f"- {name}: (削除) {_fmt_state(a)}")
            changed += 1
            continue

        diffs: list[str] = []
        sa, sb = _fmt_state(a), _fmt_state(b)
        if sa != sb:
            diffs.append(f"状態 {sa} -> {sb}")
        ha, hb = _hard(a), _hard(b)
        if ha != hb:
            diffs.append(f"hard {ha} -> {hb}")
        la, lb = _labor(a), _labor(b)
        if la != lb:
            diffs.append(f"labor {la} -> {lb}")
        sha, shb = _fmt_short(a), _fmt_short(b)
        if sha != shb:
            diffs.append(f"不足 {sha} -> {shb}")
        oa, ob = _fmt_off(a), _fmt_off(b)
        if oa != ob:
            diffs.append(f"希望休 {oa} -> {ob}")
        ta, tb = float(a.get("sec") or 0.0), float(b.get("sec") or 0.0)
        if _sec_changed(ta, tb):
            diffs.append(f"秒 {ta:.1f}s -> {tb:.1f}s")

        if diffs:
            print(f"{name}: " + " | ".join(diffs))
            changed += 1

    print(f"--- 変化あり: {changed} / {len(names)} 件 ---")


if __name__ == "__main__":
    main()
