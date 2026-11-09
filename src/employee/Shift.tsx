import { useState } from 'preact/hooks';
import type { State } from '../core/store';
import { submitRequest } from '../core/store';
import { MY_ID, SHIFTS, TASKS, TASK_GROUPS, staffById, unitName } from '../core/facility';
import { buildDay } from '../core/roster';
import { addDays, dow, fmtMD, fmtMin, parseYmd, toYmd, DOW_JA, fmtLong } from '../core/dates';
import type { RequestKind } from '../core/types';
import { Icon, Modal } from '../shared/ui';
import { Ctx, MiniCal, ShiftChip, myAssign } from './common';
import { myAvail } from './Avail';
import { MonthCard, MonthRequest } from './Request';

const REASONS = ['体調不良', '子どもの送迎', '通院', '家族の事情', '私用'];

function RequestForm({ date, hasShift, onDone, c }: { date: string; hasShift: boolean; onDone: () => void; c: Ctx }) {
  const kinds: RequestKind[] = hasShift ? ['休み', '遅刻', '早退', 'シフト変更'] : ['希望休'];
  const [kind, setKind] = useState<RequestKind>(kinds[0]);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const ph = kind === '遅刻' ? '例：30分遅れます' : kind === '早退' ? '例：15:00に帰ります' : kind === 'シフト変更' ? '例：早番に変えたい' : '補足があれば';
  return (
    <div class="stack">
      <div class="field"><label>種類</label><div class="row" style="flex-wrap:wrap">{kinds.map((k) => <button key={k} class={`opt${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>{k}</button>)}</div></div>
      <div class="field"><label>理由（任意）</label><div class="row" style="flex-wrap:wrap">{REASONS.map((r) => <button key={r} class={`opt${reason === r ? ' on' : ''}`} aria-pressed={reason === r} onClick={() => setReason(reason === r ? '' : r)}>{r}</button>)}</div></div>
      <div class="field"><label>詳細（任意）</label><input class="input" value={detail} placeholder={ph} onInput={(e) => setDetail((e.target as HTMLInputElement).value)} /></div>
      <p class="small">リーダーに送られ、承認されるとシフトに反映されます。文章で伝えたいときは<button class="link" onClick={() => { onDone(); c.go('chat'); }}>シフト作成君に話しかける</button>こともできます。</p>
      <button class="btn pri block" onClick={() => { submitRequest(MY_ID, date, kind, reason, detail.trim() || undefined, 'form'); c.toast(`${fmtMD(date)}の${kind}をリーダーに送りました`); onDone(); }}>リーダーに送る</button>
    </div>
  );
}

function DaySheet({ s, date, onClose, c }: { s: State; date: string; onClose: () => void; c: Ctx }) {
  const [form, setForm] = useState(false);
  const rows = buildDay(s.assignments, date);
  const row = rows.find((r) => r.staff.id === MY_ID && !r.tail);
  const a = myAssign(s, date);
  const has = !!a && a.status !== 'absent';
  const mates = a ? rows.filter((r) => !r.tail && r.assignment.status !== 'absent' && r.assignment.unitId === a.unitId && r.staff.id !== MY_ID) : [];
  const reqs = s.requests.filter((r) => r.staffId === MY_ID && r.date === date);
  return (
    <Modal title={fmtLong(date)} onClose={onClose}>
      {a ? (
        <div class="row spread"><div><div class="big">{a.shift}　{SHIFTS[a.shift].label}</div><div class="muted">担当：{unitName(a.unitId)}</div></div><ShiftChip shift={a.shift} full strike={!has} /></div>
      ) : <p class="big">勤務予定なし</p>}
      {a?.status === 'absent' && <p class="chip warn" style="margin-top:8px">休みとして受付済み</p>}
      {reqs.map((r) => <p key={r.id} class="row" style="margin-top:8px"><span class={`chip ${r.status === 'pending' ? 'warn' : r.status === 'rejected' ? 'bad' : 'ok'}`}>{r.status === 'pending' ? '相談中' : r.status === 'rejected' ? '見送り' : '承認済み'}</span><span class="muted">{r.kind}{r.detail ? `（${r.detail}）` : ''}</span></p>)}
      {form ? <div style="margin-top:16px"><RequestForm date={date} hasShift={has} onDone={() => { setForm(false); onClose(); }} c={c} /></div> : (
        <>
          {has && row && (<><div class="sec-title">この日の担当業務</div><ol class="tl">{row.blocks.map((b, i) => <li key={i} class={`tl-i${TASKS[b.kind].group === 'rest' ? ' rest' : ''}`} style={`--tc:${TASKS[b.kind].fg};--tb:${TASKS[b.kind].bg};--bar:${TASK_GROUPS[TASKS[b.kind].group].bar}`}><div class="tl-time">{fmtMin(b.start)}<br /><span class="small">{fmtMin(b.end)}</span></div><div class="tl-body"><b>{b.label}</b></div></li>)}</ol></>)}
          {mates.length > 0 && (<><div class="sec-title">同じユニット（{a ? unitName(a.unitId) : ''}）の職員</div>{mates.map((r) => <button key={r.assignment.id} class="line" onClick={() => c.openStaff(r.staff.id)}><ShiftChip shift={r.assignment.shift} /><span style="flex:1">{r.staff.name}</span><Icon n="chevron_right" /></button>)}</>)}
          {date >= s.today && <button class="btn tonal block" style="margin-top:16px" onClick={() => setForm(true)}>{has ? '休み・遅刻・早退・変更を相談' : '希望休を相談'}</button>}
        </>
      )}
    </Modal>
  );
}

export function Shift({ s, c }: { s: State; c: Ctx }) {
  const [mode, setMode] = useState<'cal' | 'list'>('cal');
  const [month, setMonth] = useState(s.today.slice(0, 7) + '-01');
  const [day, setDay] = useState<string | null>(null);
  const [req, setReq] = useState(false);
  const pr = s.prefs[MY_ID];
  const m0 = parseYmd(month); const nDays = new Date(m0.getFullYear(), m0.getMonth() + 1, 0).getDate();
  const shiftMonth = (n: number) => setMonth(toYmd(new Date(m0.getFullYear(), m0.getMonth() + n, 1)));
  const worked = s.assignments.filter((a) => a.staffId === MY_ID && a.status !== 'absent' && a.date.startsWith(month.slice(0, 7))).length;
  const cells: (string | null)[] = [...Array(dow(month)).fill(null), ...Array.from({ length: nDays }, (_, i) => addDays(month, i))];
  const list = Array.from({ length: 42 }, (_, i) => addDays(s.today, i)).map((d) => ({ d, a: myAssign(s, d) })).filter((x) => x.a);
  return (
    <div class="pg">
      <h1 class="ptitle">シフト</h1>
      <div class="row spread"><div class="seg" role="tablist"><button aria-selected={mode === 'cal'} onClick={() => setMode('cal')}>カレンダー</button><button aria-selected={mode === 'list'} onClick={() => setMode('list')}>リスト</button></div></div>
      <section class="card row" style="gap:16px;flex-wrap:wrap">
        <div><div class="small">今月の勤務日数</div><div class="big">{worked}日</div></div>
        <div><div class="small">休憩の希望</div><div><b>{pr.breakPref ?? '特になし'}</b></div></div>
        <div><div class="small">退勤上限</div><div><b>{pr.leaveBy ? `${pr.leaveBy}${pr.leaveReason ? `　${pr.leaveReason}` : ''}` : 'なし'}</b></div></div>
      </section>
      <MonthCard s={s} c={c} onOpen={() => setReq(true)} />
      {mode === 'cal' ? (
        <section class="card">
          <div class="row spread" style="margin-bottom:8px"><button class="iconbtn" aria-label="前の月" onClick={() => shiftMonth(-1)}><Icon n="chevron_left" /></button><b style="font-size:18px">{m0.getFullYear()}年{m0.getMonth() + 1}月</b><button class="iconbtn" aria-label="次の月" onClick={() => shiftMonth(1)}><Icon n="chevron_right" /></button></div>
          <div class="cal">
            {DOW_JA.map((d, i) => <div key={d} class="cal-h" style={i === 0 ? 'color:var(--bad)' : i === 6 ? 'color:var(--pri)' : ''}>{d}</div>)}
            {cells.map((d, i) => { if (!d) return <div key={`b${i}`} />; const a = myAssign(s, d); return (
              <button key={d} class={`cal-d${d === s.today ? ' today' : ''}`} onClick={() => setDay(d)} aria-label={`${fmtMD(d)} ${a ? a.shift : '勤務なし'}`}>
                <span class="n">{+d.slice(8)}</span>{a ? <ShiftChip shift={a.shift} strike={a.status === 'absent'} /> : myAvail(s).some((x) => x.date === d) ? <span class="avmark">入れる</span> : <span class="off">休</span>}
              </button>); })}
          </div>
          <div class="row" style="flex-wrap:wrap;margin-top:12px;gap:8px">{(['早番', '日勤', '遅番', '夜勤'] as const).map((k) => <span key={k} class="row small" style="gap:4px"><ShiftChip shift={k} />{k} {SHIFTS[k].label}</span>)}</div>
        </section>
      ) : (
        <section class="card" style="padding:4px 16px">
          {list.length === 0 && <p class="muted" style="padding:16px 0">今後6週間の勤務はまだ決まっていません。</p>}
          {list.map(({ d, a }) => { const rq = s.requests.filter((r) => r.staffId === MY_ID && r.date === d); return (
            <button key={d} class="line" style="width:100%" onClick={() => setDay(d)}>
              <div style="width:64px;text-align:left"><b>{fmtMD(d)}</b></div><ShiftChip shift={a!.shift} full strike={a!.status === 'absent'} />
              <span style="flex:1;text-align:left" class="muted">{SHIFTS[a!.shift].label}・{unitName(a!.unitId)}</span>
              {rq.map((r) => <span key={r.id} class={`chip ${r.status === 'pending' ? 'warn' : r.status === 'rejected' ? 'bad' : 'ok'}`}>{r.status === 'pending' ? '相談中' : r.status === 'rejected' ? '見送り' : '承認済'}</span>)}
            </button>); })}
        </section>
      )}
      {req && <MonthRequest s={s} c={c} onClose={() => setReq(false)} />}
      {day && <DaySheet s={s} date={day} onClose={() => setDay(null)} c={c} />}
      {void staffById}
    </div>
  );
}
