"""ベンチマーク変換で捨てた条件を5種類ごとに数える（P0 と P8 の比較用）。

使い方:
  .venv/bin/python bench/dropped_summary.py [/tmp/bench-req] [--src /path/to/bench-dl] [--out out.json]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

APP = ("早番", "日勤", "遅番", "夜勤")
DEFAULT_REQ_DIR = Path("/tmp/bench-req")
DEFAULT_SRC_DIR = Path("/Users/beni/df-hack26/ref/bench-dl")
_COUNT_RE = re.compile(r"（(\d+)件）")
_WISH_TOKENS = ("ShiftOn", "ShiftOff", "DayOn", "勤務の希望", "避けたい", "働きたい")


@dataclass
class WeekdayNeedStats:
    files: int = 0
    extra_days: int = 0
    over10_days: int = 0
    by_source: dict[str, int] = field(default_factory=dict)


@dataclass
class ContractStats:
    files: int = 0
    count_unhandled: int = 0
    time_only: int = 0


@dataclass
class ShiftRequestStats:
    files: int = 0
    items: int = 0
    ros_files: int = 0
    txt_files: int = 0
    items_incomplete: bool = False


@dataclass
class FixedPeriodStats:
    files: int = 0
    items: int = 0


@dataclass
class PrevMonthStats:
    files: int = 0
    items: int = 0
    source_missing: bool = False


@dataclass
class SequenceRuleStats:
    files: int = 0


@dataclass
class SkillCoverStats:
    files: int = 0


@dataclass
class CollapsedShiftStats:
    files: int = 0
    collapsed_pairs: int = 0


@dataclass
class DroppedSummary:
    total_files: int
    weekday_need: WeekdayNeedStats
    contracts: ContractStats
    shift_requests: ShiftRequestStats
    fixed_in_period: FixedPeriodStats
    prev_month_older: PrevMonthStats
    sequence_rules: SequenceRuleStats = field(default_factory=SequenceRuleStats)
    skill_cover: SkillCoverStats = field(default_factory=SkillCoverStats)
    collapsed_shifts: CollapsedShiftStats = field(default_factory=CollapsedShiftStats)
    per_file: list[dict[str, Any]] = field(default_factory=list)


def _extract_count(msg: str) -> int:
    return sum(int(m.group(1)) for m in _COUNT_RE.finditer(msg))


def _index_sources(src_dir: Path | None) -> tuple[dict[str, Path], dict[str, Path]]:
    if src_dir is None:
        return {}, {}
    ros_map: dict[str, Path] = {}
    txt_map: dict[str, Path] = {}
    for p in sorted(src_dir.rglob("*.ros")):
        ros_map[p.stem] = p
    for p in sorted(src_dir.rglob("*.txt")):
        txt_map[p.stem] = p
    return ros_map, txt_map


def _unhandled_weekday_shifts(req: dict, cover: list[dict[str, int]]) -> list[str]:
    month = req.get("month", "")
    if not cover or not month or "-" not in month:
        return []
    y, m = map(int, month.split("-")[:2])
    d0 = date(y, m, 1)
    by_w: dict[int, list[dict[str, int]]] = {w: [] for w in range(7)}
    for i, c in enumerate(cover):
        w = ((d0 + timedelta(days=i)).weekday() + 1) % 7  # 0=日..6=土
        by_w[w].append(c)
    need_by_weekday = req.get("need_by_weekday") or {}
    shift_types = req.get("shift_types")
    keys = [st["id"] for st in shift_types if st.get("counts", True)] if shift_types else list(APP)
    unhandled: list[str] = []
    for k in keys:
        mins = {min(c.get(k, 0) for c in by_w[w]) for w in range(7) if by_w[w]}
        if len(mins) > 1 and k not in need_by_weekday:
            unhandled.append(k)
    return unhandled


def _ros_cover_kind(ros_path: Path) -> str:
    root = ET.parse(ros_path).getroot()
    cov = root.find("CoverRequirements")
    if cov is None:
        return "不明"
    if cov.findall("DayOfWeekCover"):
        return "DayOfWeekCover"
    if cov.findall("DateSpecificCover"):
        return "DateSpecificCover"
    return "不明"


def _count_txt_shift_requests(txt_path: Path) -> int:
    sec = None
    count = 0
    for line in txt_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("SECTION_"):
            sec = line
            continue
        if sec in ("SECTION_SHIFT_ON_REQUESTS", "SECTION_SHIFT_OFF_REQUESTS"):
            count += 1
    return count


def _count_ros_older_prev_month(ros_path: Path, req: dict) -> int:
    root = ET.parse(ros_path).getroot()
    start_txt = root.findtext("StartDate")
    if not start_txt:
        return 0
    start = date.fromisoformat(start_txt)
    cov = root.find("CoverRequirements")
    if cov is not None:
        dow = cov.findall("DayOfWeekCover")
        spec = cov.findall("DateSpecificCover")
        if spec and not dow:
            dates = [date.fromisoformat(n.findtext("Date")) for n in spec if n.findtext("Date")]
            if dates:
                start = min(dates)
    history = req.get("history") or {}
    if history:
        lengths = [len(v) for v in history.values() if isinstance(v, list)]
        covered_days = min(7, max(lengths)) if lengths else 1
    else:
        covered_days = 1
    cutoff = start - timedelta(days=covered_days)
    count = 0
    for e in root.findall("FixedAssignments/Employee"):
        for a in e.findall("Assign"):
            d_txt = a.findtext("Date")
            if d_txt and date.fromisoformat(d_txt) < cutoff:
                count += 1
    return count


def summarize(req_dir: Path, src_dir: Path | None = None) -> DroppedSummary:
    files = sorted(req_dir.glob("*.json"))
    ros_map, txt_map = _index_sources(src_dir)

    weekday_need = WeekdayNeedStats()
    contracts = ContractStats()
    shift_requests = ShiftRequestStats()
    fixed_in_period = FixedPeriodStats()
    prev_month_older = PrevMonthStats()
    sequence_rules = SequenceRuleStats()
    skill_cover = SkillCoverStats()
    collapsed_shifts = CollapsedShiftStats()
    per_file: list[dict[str, Any]] = []

    for p in files:
        inst = json.loads(p.read_text())
        name = inst.get("name") or p.stem
        req = inst.get("request") or {}
        meta = inst.get("meta") or {}
        dropped: list[str] = meta.get("dropped") or []
        cover: list[dict[str, int]] = meta.get("cover") or []

        row_info: dict[str, Any] = {"name": name}

        # 1. 曜日ごとの人数（最小値＋上乗せに丸めている）
        unhandled_shifts = _unhandled_weekday_shifts(req, cover)
        if unhandled_shifts:
            weekday_need.files += 1
            extra_days = len(req.get("extra") or {})
            over10_days = sum(1 for msg in dropped if "10人を超え" in msg)
            weekday_need.extra_days += extra_days
            weekday_need.over10_days += over10_days
            if name in txt_map:
                src_kind = "SECTION_COVER"
            elif name in ros_map:
                src_kind = _ros_cover_kind(ros_map[name])
            else:
                src_kind = "不明"
            weekday_need.by_source[src_kind] = weekday_need.by_source.get(src_kind, 0) + 1
            row_info["weekday_need"] = {"unhandled_shifts": unhandled_shifts, "source": src_kind}

        # 2. 個人の契約
        contract_msgs = [msg for msg in dropped if "個人ごとの" in msg or "契約" in msg]
        if contract_msgs:
            contracts.files += 1
            is_time_only = all("時間" in msg and "回数" not in msg for msg in contract_msgs)
            if is_time_only:
                contracts.time_only += 1
            else:
                contracts.count_unhandled += 1
            row_info["contracts"] = "time_only" if is_time_only else "unhandled"

        # 3. 勤務の希望・避けたい勤務・働きたい日
        wish_msgs = [msg for msg in dropped if any(tok in msg for tok in _WISH_TOKENS)]
        if wish_msgs:
            shift_requests.files += 1
            if name in txt_map:
                shift_requests.txt_files += 1
            elif name in ros_map:
                shift_requests.ros_files += 1
            elif any(not _COUNT_RE.search(msg) for msg in wish_msgs):
                shift_requests.txt_files += 1
            else:
                shift_requests.ros_files += 1

            wish_items = sum(_extract_count(msg) for msg in wish_msgs)
            has_uncounted = any(not _COUNT_RE.search(msg) for msg in wish_msgs)
            if has_uncounted:
                if name in txt_map:
                    wish_items += _count_txt_shift_requests(txt_map[name])
                else:
                    shift_requests.items_incomplete = True
            shift_requests.items += wish_items
            row_info["shift_requests"] = wish_items

        # 4. 期間中の固定
        fixed_msgs = [msg for msg in dropped if "期間中の固定" in msg]
        if fixed_msgs:
            fixed_in_period.files += 1
            fixed_items = sum(_extract_count(msg) for msg in fixed_msgs)
            fixed_in_period.items += fixed_items
            row_info["fixed_in_period"] = fixed_items

        # 5. 前月の2日目以前
        prev_msgs = [msg for msg in dropped if "前月の" in msg]
        if prev_msgs:
            prev_month_older.files += 1
            prev_items = sum(_extract_count(msg) for msg in prev_msgs)
            prev_month_older.items += prev_items
            row_info["prev_month_older"] = prev_items
        elif name in txt_map:
            pass
        elif name in ros_map:
            prev_items = _count_ros_older_prev_month(ros_map[name], req)
            if prev_items > 0:
                prev_month_older.files += 1
                prev_month_older.items += prev_items
                row_info["prev_month_older"] = prev_items
        else:
            prev_month_older.source_missing = True
            row_info["prev_month_older"] = "source_missing"

        # 6. 並びのルール（連勤・週末・禁止の並び）
        if any("連勤" in msg or "続けてはいけない" in msg or "勤務パターン" in msg for msg in dropped):
            sequence_rules.files += 1
            row_info["sequence_rules"] = True

        # 7. チーム・技能別の人数
        if any("スキル別の必要人数" in msg for msg in dropped):
            skill_cover.files += 1
            row_info["skill_cover"] = True

        # 8. 勤務区分の統合（4区分に潰したもの）
        smap = meta.get("shift_map") or {}
        if smap and not req.get("shift_types"):
            remapped = sum(1 for k, v in smap.items() if k != v)
            if remapped > 0 or any("複数の勤務が同じ帯に寄った" in msg for msg in dropped):
                collapsed_shifts.files += 1
                collapsed_shifts.collapsed_pairs += remapped
                row_info["collapsed_shifts"] = remapped

        per_file.append(row_info)

    return DroppedSummary(
        total_files=len(files),
        weekday_need=weekday_need,
        contracts=contracts,
        shift_requests=shift_requests,
        fixed_in_period=fixed_in_period,
        prev_month_older=prev_month_older,
        sequence_rules=sequence_rules,
        skill_cover=skill_cover,
        collapsed_shifts=collapsed_shifts,
        per_file=per_file,
    )


def format_table(s: DroppedSummary) -> str:
    n = s.total_files
    src_parts = [f"{k} {v}" for k, v in sorted(s.weekday_need.by_source.items())]
    src_note = f" ({' / '.join(src_parts)})" if src_parts else ""
    w_detail = f"extra={s.weekday_need.extra_days}日分, 10人超切り={s.weekday_need.over10_days}日分{src_note}"

    c_detail = f"回数系未反映={s.contracts.count_unhandled}本, 時間のみ={s.contracts.time_only}本"

    inc = "+" if s.shift_requests.items_incomplete else ""
    r_detail = (
        f"{s.shift_requests.items}{inc} 件 "
        f"(.ros {s.shift_requests.ros_files}本 / .txt {s.shift_requests.txt_files}本"
        + (", .txt未参照のため件数一部欠損" if s.shift_requests.items_incomplete else "")
        + ")"
    )

    f_detail = f"{s.fixed_in_period.items} 件"

    if s.prev_month_older.source_missing and s.prev_month_older.files == 0:
        p_files = "不明"
        p_detail = "元データ未参照のため確認不可"
    else:
        p_files = f"{s.prev_month_older.files} / {n} 本"
        p_detail = f"{s.prev_month_older.items} 件" + ("（一部元データ未参照）" if s.prev_month_older.source_missing else "")

    lines = [
        f"対象: {n} 本",
        "",
        "| 種類 | 本数 | 件数・内訳 |",
        "|---|---:|---|",
        f"| 曜日ごとの人数（最小値＋上乗せに丸めている） | {s.weekday_need.files} / {n} 本 | {w_detail} |",
        f"| 個人の契約 | {s.contracts.files} / {n} 本 | {c_detail} |",
        f"| 勤務の希望・避けたい勤務・働きたい日 | {s.shift_requests.files} / {n} 本 | {r_detail} |",
        f"| 期間中の固定 | {s.fixed_in_period.files} / {n} 本 | {f_detail} |",
        f"| 前月の2日目以前 | {p_files} | {p_detail} |",
        f"| 並びのルール（連勤・週末・禁止の並び） | {s.sequence_rules.files} / {n} 本 | {s.sequence_rules.files} 本 |",
        f"| チーム・技能別の人数 | {s.skill_cover.files} / {n} 本 | {s.skill_cover.files} 本 |",
        f"| 勤務区分の統合（4区分への丸め） | {s.collapsed_shifts.files} / {n} 本 | {s.collapsed_shifts.collapsed_pairs} 区分 |",
    ]
    return "\n".join(lines)


def _resolve_src_dir(raw: str | None) -> Path | None:
    if raw is not None:
        p = Path(raw)
        try:
            if not p.is_dir():
                print(f"warn: --src が見つかりません: {p}", file=sys.stderr)
                return None
            next(p.iterdir(), None)
        except OSError as e:
            print(f"warn: --src を読めません ({p}): {e}", file=sys.stderr)
            return None
        return p

    try:
        if DEFAULT_SRC_DIR.is_dir():
            next(DEFAULT_SRC_DIR.iterdir(), None)
            return DEFAULT_SRC_DIR
    except OSError:
        return None
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("req_dir", nargs="?", default=str(DEFAULT_REQ_DIR))
    ap.add_argument("--src", default=None)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()

    req_dir = Path(a.req_dir)
    if not req_dir.is_dir():
        sys.exit(f"req_dir not found: {req_dir}")

    src_dir = _resolve_src_dir(a.src)
    if a.src is not None and src_dir is None:
        sys.exit(1)

    summary = summarize(req_dir, src_dir=src_dir)
    print(format_table(summary))
    if a.out:
        out_path = Path(a.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(asdict(summary), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
