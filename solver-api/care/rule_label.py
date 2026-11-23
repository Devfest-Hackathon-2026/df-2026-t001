"""ルールの表示ラベルを、型と構造化項目だけから決定的に組み立てる。

クライアント送付の label 文字列は使わない（利用者の文章・命令文を説明文へ混ぜないため）。
translate.py の候補表示（_what / _label）もここを共有する。
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence

from . import vocab
from .dsl import OFF, PUBLIC_OFF

WD = ("日", "月", "火", "水", "木", "金", "土")
TASK_JA = {k: v for k, v in vocab.TASK_JA.items() if k not in ("nap", "break")}


# ---------------------------------------------------------------- translate.py 用（RuleDraft 向け）


def _what(d) -> str:
    ids = "・".join(d.shift_ids)
    if d.type == "request":
        if d.shift_ids == [OFF]:
            return "休みにする" if d.want else "休みにしない"
        return f"{ids}に入る" if d.want else f"{ids}に入らない"
    if d.type == "succession":
        return f"連続勤務は{d.max_run}日まで" if d.max_run is not None else f"{ids}のあとに{'・'.join(d.after_shift_ids)}を置かない"
    if d.type == "count":
        u = d.unit or ""
        lo, hi = d.at_least, d.at_most
        rng = f"{lo}〜{hi}{u}" if lo is not None and hi is not None else (f"{lo}{u}以上" if lo is not None else f"{hi}{u}以下")
        return f"{ids}は月{rng}"
    hrs = ""
    if d.from_hour is not None or d.to_hour is not None:
        hrs = f"{d.from_hour if d.from_hour is not None else 0:g}時〜{d.to_hour if d.to_hour is not None else 24:g}時の"
    return f"{hrs}{TASK_JA.get(d.task or '', d.task)}を担当{'する' if d.want else 'しない'}"


def _label(subject: str, when: str, d) -> str:
    what = _what(d)
    if d.type == "succession" or d.type == "count":
        return f"{subject}は{what}" if d.type == "succession" else f"{subject}の{what}"
    return f"{subject}は{when}{what}"


# ---------------------------------------------------------------- 構造化ルール → 日本語ラベル


def _people_ja(people, staff_names: Mapping[str, str] | None) -> str:
    if people is None:
        return "全員"
    parts: list[str] = []
    if people.ids is not None:
        names = [(staff_names.get(sid, sid) if staff_names else sid) for sid in people.ids]
        if not names:
            parts.append("対象なし")
        elif len(names) == 1:
            parts.append(f"{names[0]}さん")
        elif len(names) <= 3:
            parts.append("・".join(f"{n}さん" for n in names))
        else:
            parts.append(f"{names[0]}さんほか{len(names) - 1}名")
    if people.roles:
        parts.append("・".join(people.roles))
    if people.skills:
        parts.append("・".join(vocab.skill(sk) for sk in people.skills) + "保有者")
    if people.employment:
        parts.append(people.employment)
    return "・".join(parts) if parts else "全員"


def _days_ja(days) -> str:
    if days is None:
        return ""
    parts: list[str] = []
    if days.named:
        parts.append(days.named)
    if days.weekdays is not None:
        wds = sorted(set(days.weekdays))
        if wds:
            parts.append("・".join(WD[w] for w in wds if 0 <= w <= 6) + "曜")
    if days.dates is not None:
        ds = sorted(set(days.dates))
        if len(ds) == 1:
            parts.append(f"{ds[0]}日")
        elif 2 <= len(ds) <= 4:
            parts.append("・".join(f"{d}日" for d in ds))
        elif len(ds) >= 5:
            if ds[-1] - ds[0] + 1 == len(ds):
                parts.append(f"{ds[0]}〜{ds[-1]}日")
            else:
                parts.append(f"{ds[0]}日ほか{len(ds) - 1}日")
    return "・".join(parts)


def _shift_name(k: str, shift_names: Mapping[str, str] | None) -> str:
    if k == OFF:
        return "休"
    if k == PUBLIC_OFF:
        return "公休"
    return shift_names.get(k, k) if shift_names else k


def _shifts_ja(sel, shift_names: Mapping[str, str] | None, work_ids: Sequence[str] | None) -> str:
    if sel is None or sel.ids is None:
        return "勤務"
    ids = list(sel.ids)
    if not ids:
        return "なし"
    if work_ids:
        w_set = set(work_ids)
        id_set = set(ids)
        all_cells = w_set | {OFF}
        if id_set == all_cells:
            return "いずれか"
        if id_set == w_set:
            return "勤務"
        if len(ids) >= 3 and len(all_cells - id_set) == 1:
            missing = next(iter(all_cells - id_set))
            return f"{_shift_name(missing, shift_names)}以外"
    return "・".join(_shift_name(k, shift_names) for k in ids)


def _fmt_num(v: int | float) -> str:
    if isinstance(v, int) or (isinstance(v, float) and v.is_integer()):
        return str(int(v))
    return f"{v:g}"


def _range_ja(lo: int | float | None, hi: int | float | None, unit: str, *, target: int | None = None) -> str:
    if lo is not None and hi is not None:
        base = f"{_fmt_num(lo)}{unit}" if lo == hi else f"{_fmt_num(lo)}〜{_fmt_num(hi)}{unit}"
    elif lo is not None:
        base = f"{_fmt_num(lo)}{unit}以上"
    elif hi is not None:
        base = f"{_fmt_num(hi)}{unit}以下"
    elif target is not None:
        return f"目標{_fmt_num(target)}{unit}"
    else:
        return ""
    if target is not None:
        return f"{base}（目標{_fmt_num(target)}{unit}）"
    return base


def _pattern_ja(pattern: Sequence, shift_names: Mapping[str, str] | None, work_ids: Sequence[str] | None) -> str:
    step_labels = [_shifts_ja(sel, shift_names, work_ids) for sel in pattern]
    grouped: list[str] = []
    i = 0
    while i < len(step_labels):
        lbl = step_labels[i]
        j = i + 1
        while j < len(step_labels) and step_labels[j] == lbl:
            j += 1
        cnt = j - i
        if cnt >= 3:
            grouped.append(f"{lbl}×{cnt}")
        else:
            grouped.extend([lbl] * cnt)
        i = j
    return "→".join(grouped)


def occurrence_pattern_ja(
    rule,
    *,
    shift_names: Mapping[str, str] | None = None,
    work_ids: Sequence[str] | None = None,
) -> str:
    """Occurrence の並び表現（「土日とも休み」または「<開始日>始まりの<並び>」）。"""
    starts = getattr(rule, "starts", None)
    pat = getattr(rule, "pattern", None) or ()
    is_sat_weekend = (
        starts is not None
        and starts.weekdays == [6]
        and starts.dates is None
        and starts.named is None
        and len(pat) == 2
        and all((sel.ids in ([PUBLIC_OFF], [OFF])) for sel in pat)
    )
    if is_sat_weekend:
        return "土日とも休み"
    when = _days_ja(starts)
    pat_str = _pattern_ja(pat, shift_names, work_ids)
    return f"{when}始まりの{pat_str}" if when else pat_str


def rule_label(
    rule,
    *,
    shift_names: Mapping[str, str] | None = None,
    staff_names: Mapping[str, str] | None = None,
    work_ids: Sequence[str] | None = None,
) -> str:
    """構造化ルールの項目から日本語ラベルを組み立てる（入力の label は一切読まない）。"""
    subj = _people_ja(getattr(rule, "people", None), staff_names)
    when = _days_ja(getattr(rule, "days", None))
    rtype = rule.type

    if rtype == "staffing":
        sh = _shifts_ja(rule.shifts, shift_names, work_ids)
        when_p = f"{when}の" if when else ""
        subj_p = "" if subj == "全員" else f"{subj}の"
        rng = _range_ja(rule.at_least, rule.at_most, "人")
        return f"{when_p}{subj_p}{sh}は{rng}"

    if rtype == "request":
        when_p = f"{when}の" if when else ""
        if rule.shifts.ids == [OFF]:
            what = "休みにする" if rule.want else "休みにしない"
        else:
            sh = _shifts_ja(rule.shifts, shift_names, work_ids)
            what = f"{sh}に入る" if rule.want else f"{sh}に入らない"
        return f"{subj}は{when_p}{what}"

    if rtype == "succession":
        # 「全員は…」は不自然なので、全員のときは主語を書かない
        subj_p = "" if subj == "全員" else f"{subj}は"
        if rule.max_run is not None:
            return f"{subj_p}連続勤務{rule.max_run}日まで" if subj_p else f"連続勤務は{rule.max_run}日まで"
        pat_str = _pattern_ja(rule.pattern or (), shift_names, work_ids)
        verb = "の並びにしない" if rule.forbid else "の並びにする"
        return f"{subj_p}{pat_str}{verb}"

    if rtype == "count":
        sh = _shifts_ja(rule.shifts, shift_names, work_ids)
        period = f"{when}の" if when else "月の"
        rng = _range_ja(rule.at_least, rule.at_most, rule.unit, target=rule.target)
        return f"{subj}の{period}{sh}は{rng}"

    if rtype == "balance":
        sh = _shifts_ja(rule.shifts, shift_names, work_ids)
        when_p = f"{when}の" if when else ""
        ids = rule.shifts.ids
        if subj == "全員" and ids and not ({OFF, PUBLIC_OFF} & set(ids)):
            subj = f"{sh}に入れる人"     # 差をそろえるのはその勤務に入れる人だけ（Balance.members）
        return f"{subj}の{when_p}{sh}の差は{rule.max_spread}回以内"

    if rtype == "occurrence":
        what = occurrence_pattern_ja(rule, shift_names=shift_names, work_ids=work_ids)
        rng = _range_ja(rule.at_least, rule.at_most, "回")
        return f"{subj}の{what}は月{rng}"

    raise ValueError(f"未対応のルール型です: {rtype}")
