import type { Candidate } from '../core/roster';
import type { Vacancy } from '../core/types';
import { ReasonChips } from './Job';

/** 打診候補の理由。Gemini が書いた1文があればそれを「AI」ラベル付きで、なければ今までの理由チップ */
export function CandReason({ v, id, cand }: { v: Vacancy; id: string; cand: Candidate }) {
  const t = v.auto?.reasonAi?.[id];
  if (typeof t !== 'string' || !t) return <ReasonChips c={cand} />;
  return (
    <div class="row" style="gap:6px;margin-top:6px;align-items:flex-start">
      <span class="chip pri" style="flex:none" title="ルールで求めた事実を、Gemini が1文にまとめました。順番は変わりません">AI</span>
      <span class="small" data-testid="ai-reason">{t}</span>
    </div>
  );
}
