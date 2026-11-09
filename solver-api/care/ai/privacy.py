"""AI に渡す前の個人情報の扱い。

1. 施設の従業員の氏名は、あらかじめ ID（HDM-007 など）に置き換える（仮名化）。リーダーは氏名で話すが、モデルには ID で渡す。
2. 残った文章は Sensitive Data Protection（DLP）で、氏名・電話・メール・住所などを伏せ字にする。
   DLP が使えないときは、既定では AI を呼ばない（fail closed）。DLP_MODE=off で無効にできる（テスト・ローカル用）。

入力だけを処理する。ツールが返す施設のデータ（架空）は、そのままモデルに渡る。
"""
from __future__ import annotations

import os
import re

from ..dsl import StaffMember
from .llm import AIError

INFO_TYPES = ["PERSON_NAME", "PHONE_NUMBER", "EMAIL_ADDRESS", "STREET_ADDRESS", "JAPAN_INDIVIDUAL_NUMBER"]
HONORIFICS = "さん|君|くん|氏|先輩|ちゃん|主任"


def pseudonymize(text: str, staff: list[StaffMember]) -> tuple[str, dict[str, str]]:
    """氏名 → ID。(置換後の文章, {ID: 氏名}) を返す。姓だけは敬称がついているときに限って置き換える。"""
    out, seen = text, {}
    for s in sorted(staff, key=lambda x: -len(x.name)):
        full = s.name.strip()
        compact = re.sub(r"\s+", "", full)
        for v in {full, compact, full.replace(" ", "　")}:
            if v and v in out:
                out = out.replace(v, s.staff_id)
                seen[s.staff_id] = full
        sur = full.split()[0] if " " in full or "　" in full else None
        if sur:
            pat = re.compile(rf"{re.escape(sur)}(?=({HONORIFICS}))")
            if pat.search(out):
                out = pat.sub(s.staff_id, out)
                seen[s.staff_id] = full
    return out, seen


class Masker:
    def __init__(self, mode: str | None = None, project: str | None = None) -> None:
        self.mode = mode or os.getenv("DLP_MODE", "required")
        self.project = project or os.getenv("GOOGLE_CLOUD_PROJECT")
        self._client = None

    def mask(self, text: str) -> str:
        if self.mode == "off" or not text:
            return text
        try:
            from google.cloud import dlp_v2

            if self._client is None:
                self._client = dlp_v2.DlpServiceClient(client_options={"quota_project_id": self.project})
            r = self._client.deidentify_content(request={
                "parent": f"projects/{self.project}/locations/global",
                "item": {"value": text},
                "inspect_config": {"info_types": [{"name": n} for n in INFO_TYPES], "min_likelihood": dlp_v2.Likelihood.POSSIBLE},
                "deidentify_config": {"info_type_transformations": {"transformations": [
                    {"primitive_transformation": {"replace_with_info_type_config": {}}}]}},
            })
            return r.item.value
        except Exception as e:  # noqa: BLE001
            raise AIError(f"個人情報のマスクに失敗しました（安全のため AI は呼びません）: {str(e)[:120]}") from e
