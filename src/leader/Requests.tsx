import { staffById } from '../core/facility';
import { fmtMD } from '../core/dates';
import type { State } from '../core/store';
import { ReqActions } from './Auto';

const ST: Record<string, { l: string; c: string }> = { pending: { l: '承認待ち', c: 'warn' }, approved: { l: '承認済み', c: 'ok' }, rejected: { l: '見送り', c: '' }, auto: { l: 'AI自動反映', c: 'pri' } };
export function Requests({ s, openStaff }: { s: State; openStaff: (id: string) => void }) {
  const rs = s.requests.slice().sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  return (
    <div class="page scroll">
      <p class="muted" style="margin-bottom:12px">シフト作成君が読み取った申請のうち、人数や休憩に影響がないものは自動で反映され、影響があるものだけが承認待ちになります。</p>
      {rs.length === 0 && <div class="empty">申請はまだありません。</div>}
      <div class="cards">{rs.map((x) => <section key={x.id} class="card">
        <div class="row spread"><span class={`chip ${ST[x.status].c}`}>{ST[x.status].l}</span>{x.via === 'ai' && <span class="chip pri">シフト作成君</span>}</div>
        <h3 class="h3" style="margin-top:8px"><button class="link" onClick={() => openStaff(x.staffId)}>{staffById(x.staffId).name}</button>さん　{fmtMD(x.date)} {x.kind}</h3>
        <p class="muted">{[x.detail, x.reason && `理由：${x.reason}`].filter(Boolean).join('／')}</p>
        {x.impact && <p class="small" style="color:var(--tx);margin-top:6px">{x.impact}</p>}
        <ReqActions r={x} s={s} />
      </section>)}</div>
    </div>
  );
}
