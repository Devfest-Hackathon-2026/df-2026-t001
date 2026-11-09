import { staffById, unitName } from '../core/facility';
import { fmtMD } from '../core/dates';
import { remindUnsubmitted } from '../core/store';
import type { State } from '../core/store';
import { Icon, useToast } from '../shared/ui';

export function Collect({ s, openStaff }: { s: State; openStaff: (id: string) => void }) {
  const [toast, setToast] = useToast();
  const c = s.collection;
  const entries = Object.entries(c.submitted).sort((a, b) => (a[1] ? 1 : 0) - (b[1] ? 1 : 0) || a[0].localeCompare(b[0]));
  const done = entries.filter(([, v]) => v).length; const total = entries.length; const left = total - done;
  return (
    <div class="page scroll">
      <section class="card">
        <h3 class="h3">{Number(c.month.slice(5))}月分の希望休</h3>
        <p class="muted">締切：{fmtMD(c.deadline)}</p>
        <div class="prog" role="progressbar" aria-valuenow={done} aria-valuemax={total} aria-label="提出状況"><i style={`width:${(done / total) * 100}%`} /></div>
        <p style="margin-top:6px"><b style="font-weight:500">{done}</b> / {total}名が提出済み</p>
        <button class="btn pri" style="margin-top:12px" disabled={!left} onClick={() => { const n = remindUnsubmitted(); setToast(`未提出の${n}名に催促を送りました。数秒後に数名が提出します`); }}><Icon n="notifications_active" sm /> 未提出者に催促を送る</button>
        {c.remindedAt && <p class="small" style="margin-top:6px">催促済み：{c.remindedN}名に送信（{c.remindedAt.slice(11, 16)}）。まだの方は一覧に「未提出」と出ます。</p>}
      </section>
      <div class="cards" style="margin-top:12px">{entries.map(([id, v]) => <div key={id} class="card row spread">
        <span><button class="link" onClick={() => openStaff(id)}>{staffById(id).name}</button> <span class="small">{unitName(staffById(id).homeUnit)}</span>{v && <div class="small">{v.dates.length ? v.dates.map(fmtMD).join('、') : '希望なし'}</div>}</span>
        <span class={`chip ${v ? 'ok' : 'warn'}`}>{v ? '提出済み' : '未提出'}</span></div>)}</div>
      {toast}
    </div>
  );
}
