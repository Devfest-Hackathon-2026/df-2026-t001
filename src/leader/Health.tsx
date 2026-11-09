import { staffById, unitName } from '../core/facility';
import { fmtMD } from '../core/dates';
import type { State } from '../core/store';
import { Icon } from '../shared/ui';

export function Health({ s, openStaff }: { s: State; openStaff: (id: string) => void }) {
  const todays = s.assignments.filter((a) => a.date === s.today && a.status !== 'absent').sort((a, b) => (a.shift === '夜勤' ? 0 : 1) - (b.shift === '夜勤' ? 0 : 1) || a.shift.localeCompare(b.shift));
  const rows = todays.map((a) => { const h = s.health.find((x) => x.staffId === a.staffId && x.date === s.today); const flag = !!h && (h.temp >= 37.5 || h.symptoms.length > 0 || h.household !== '症状なし' || h.consult); return { a, h, flag }; })
    .sort((x, y) => (y.flag ? 2 : !y.h ? 1 : 0) - (x.flag ? 2 : !x.h ? 1 : 0));
  const missing = rows.filter((r) => !r.h).length;
  return (
    <div class="page scroll">
      <h1 class="ptitle">体調チェック <span class="muted">{fmtMD(s.today)} 出勤分</span></h1>
      <div class="card" style="margin-bottom:12px"><span class={`chip ${missing ? 'warn' : 'ok'}`}>未入力 {missing}名</span>
        <p class="small" style="margin-top:8px">未入力を健康と推定しません。就業可否は本人と確認して決めます（診断・自動判定ではありません）。</p>
        <p class="small" style="margin-top:4px"><Icon n="lock" sm /> 入力内容は本人と許可された担当者だけが見られます。</p></div>
      {todays.length === 0 && <div class="empty">今日の出勤者がいません。</div>}
      <div class="cards">{rows.map(({ a, h, flag }) => <section key={a.id} class="card">
        <div class="row spread"><span><button class="link" onClick={() => openStaff(a.staffId)}>{staffById(a.staffId).name}</button> <span class="small">{a.shift}／{unitName(a.unitId)}</span></span>
          {!h ? <span class="chip warn">未入力</span> : flag ? <span class="chip bad">要確認</span> : <span class="chip ok">入力済み</span>}</div>
        {h && <dl class="kv" style="margin-top:8px"><dt>体温</dt><dd>{h.temp.toFixed(1)}℃</dd><dt>症状</dt><dd>{h.symptoms.join('・') || 'なし'}</dd><dt>同居家族</dt><dd>{h.household}</dd><dt>睡眠</dt><dd>{h.sleep}</dd>{h.note && <><dt>メモ</dt><dd>{h.note}</dd></>}</dl>}
        {h?.consult && <span class="chip pri" style="margin-top:8px">相談希望あり</span>}
      </section>)}</div>
    </div>
  );
}
