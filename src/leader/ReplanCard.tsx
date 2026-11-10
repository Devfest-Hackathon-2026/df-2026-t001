// ソルバー（CP-SAT, POST /api/v1/replan-inline）による「この日だけの組み直し」の表示。
// ReplanNote: 時間の調整・打診のカードに添える確認結果の1行。SolverPlanCard: ソルバーの組み直しを案として出したときの承認カード。
import { fmtMD } from '../core/dates';
import { staffById, unitName } from '../core/facility';
import { verdictText } from '../core/apireplan';
import { applySolverReplan, skipAdjustment } from '../core/store';
import type { Vacancy } from '../core/types';
import { Icon } from '../shared/ui';

export function ReplanNote({ v }: { v: Vacancy }) {
  const r = v.auto?.replan; if (!r) return null;
  return <p class="small" style="margin-top:6px" data-testid="replan-note"><Icon n="rule" sm /> {verdictText(r)}{v.auto?.replanUse === 'check' && r.ok ? '（画面の案と比べ、変わる勤務が少ないほうを提案しています）' : ''}</p>;
}

export function SolverPlanCard({ v }: { v: Vacancy }) {
  const r = v.auto?.replan;
  return (
    <section class="card askcard">
      <div class="row spread wrap" style="gap:8px"><div class="row" style="gap:8px"><Icon n="swap_horiz" /><b style="font-weight:500">この日だけの組み直しの承認</b></div><span class="chip warn">あなたの承認待ち</span></div>
      <p style="margin-top:4px">{fmtMD(v.date)} {v.shift}／{unitName(v.unitId)}：ほかの日はそのままにして、この日の勤務だけを入れ替えると埋まります。</p>
      {r?.ok ? <div class="plan sel" style="margin-top:8px">
        <p class="small" style="margin-bottom:4px">{verdictText(r)}</p>
        <ul>{r.changes.map((c) => <li key={c.staffId}>{staffById(c.staffId).name}さん：{c.from || '休み'} → {c.to || '休み'}</li>)}</ul>
        <ul class="small" style="margin-top:6px"><li><Icon n="check" sm /> 連勤・夜勤明け・勤務間隔（11時間）・夜勤の回数・公休：ソルバーと画面の両方の確認を通っています</li></ul>
      </div> : <p class="small" style="margin-top:8px">この組み直しは確認できません。別の方法に進めてください。</p>}
      <div class="row wrap" style="margin-top:12px">
        {r?.ok && <button class="btn pri" onClick={() => applySolverReplan(v.id)}>この組み直しを承認</button>}
        <button class="btn" onClick={() => skipAdjustment(v.id)}>別の方法で（打診へ）</button>
      </div>
    </section>
  );
}
