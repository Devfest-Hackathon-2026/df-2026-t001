"""内部キー → 日本語。リーダーに見せる文章（説明・ラベル）では、必ずここを通す。"""
TASK_JA = {"handover": "引き継ぎ", "wake": "起床介助", "meal": "食事介助", "excretion": "排泄介助", "bath": "入浴介助", "med": "配薬",
           "medical": "医療的ケア", "round": "巡回", "record": "記録", "rec": "レク", "transport": "送迎", "laundry": "環境整備",
           "bed": "就寝介助", "watch": "見守り", "nap": "仮眠", "break": "休憩"}
SKILL_JA = {"medical": "医療的ケア", "dementia": "認知症ケア", "bath": "入浴介助", "swallow": "嚥下配慮", "driver": "送迎（運転）",
            "terminal": "看取りケア", "follow": "フォロー", "night": "夜勤", "ict": "記録・ICT", "preceptor": "新人指導"}


def task(k: str | None) -> str:
    return TASK_JA.get(k or "", k or "")


def skill(k: str | None) -> str:
    return SKILL_JA.get(k or "", k or "")
