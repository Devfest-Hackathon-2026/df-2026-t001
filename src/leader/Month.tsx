import { useMemo, useState } from 'preact/hooks';
import { SHIFT_ORDER, UNITS, staffById, unitName } from '../core/facility';
import { addDays, dow, fmtLong, parseYmd, DOW_JA } from '../core/dates';
import { RANGE_START, RANGE_END, issueTime, summarizeDay } from '../core/roster';
import type { State } from '../core/store';
import type { FacilityEvent } from '../core/events';
import { Icon, Modal } from '../shared/ui';
import { useWide, VAC_STATE } from './util';
import type { Go } from './util';
import { EVENT_STYLE, EventForm, effectText } from './Events';

const MONTHS = ['2026-10', '2026-11', '2026-12'];
type Sum = ReturnType<typeof summarizeDay>;

export function Month({ s, date, go, openStaff }: { s: State; date: string; go: Go; openStaff: (id: string) => void }) {
  const [ym, setYm] = useState(date.slice(0, 7));
  const wide = useWide(1100);
  // 日付の選択（右ペイン用）。ボトムシートは「セルをタップしたとき」だけ開く
  const [sel, setSel] = useState<string>(date);
  const [sheet, setSheet] = useState(false);
  const first = `${ym}-01`;
  const gridStart = addDays(first, -dow(first));
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)).filter((d, i) => i < 35 || d.slice(0, 7) === ym);
  const sums = useMemo(() => { const m: Record<string, Sum> = {}; for (const d of days) if (d >= RANGE_START && d <= RANGE_END) m[d] = summarizeDay(s.assignments, d, s.events); return m; }, [s.assignments, s.events, ym]);
  const idx = MONTHS.indexOf(ym);
  const tap = (d: string) => { setSel(d); setSheet(true); };
  const detail = (showDate: boolean) => <DayDetail showDate={showDate} s={s} date={sel} sum={sums[sel] ?? summarizeDay(s.assignments, sel, s.events)} go={go} openStaff={openStaff} />;
  return (
    <div class="split">
      <div class="main-col">
        <div class="row spread tb">
          <div class="row"><button class="iconbtn" disabled={idx <= 0} onClick={() => setYm(MONTHS[idx - 1])} aria-label="前の月"><Icon n="chevron_left" /></button>
            <h2 class="mtitle">{ym.replace('-', '年')}月</h2>
            <button class="iconbtn" disabled={idx >= MONTHS.length - 1} onClick={() => setYm(MONTHS[idx + 1])} aria-label="次の月"><Icon n="chevron_right" /></button>
            {s.today.slice(0, 7) !== ym && <button class="btn sm" onClick={() => { setYm(s.today.slice(0, 7)); setSel(s.today); }}>今日</button>}</div>
        </div>
        <div class="cal-head">{DOW_JA.map((d, i) => <div key={d} style={i === 0 ? 'color:var(--bad)' : i === 6 ? 'color:var(--pri)' : ''}>{d}</div>)}</div>
        <div class="cal scroll">
          {days.map((d) => {
            const sm = sums[d]; const out = !sm; const cur = d.slice(0, 7) === ym;
            const short = !!sm && sm.vacant > 0; const warn = !!sm && (sm.issues.length > 0 || sm.eventShort > 0) && !short;
            const need = sm ? SHIFT_ORDER.reduce((t, k) => t + sm.byShift[k].need, 0) : 1;
            const pct = sm ? Math.min(100, Math.round((sm.staffCount / need) * 100)) : 0;
            const evs = sm?.events ?? [];
            return (
              <button key={d} class={`cell${d === s.today ? ' today' : ''}${wide && d === sel ? ' sel' : ''}${cur ? '' : ' dim'}${short ? ' short' : ''}${sm?.holiday ? ' hol' : ''}`} disabled={out} onClick={() => tap(d)}
                aria-label={`${fmtLong(d)}${sm?.holiday ? `、${sm.holiday}` : ''}${evs.length ? `、行事：${evs.map((e) => e.title).join('、')}` : ''}${sm ? `、勤務${sm.staffCount}名` : ''}${short ? `、欠員${sm!.vacant}` : warn ? '、要確認' : ''}`}>
                <span class="c-top"><span class="dn">{parseYmd(d).getDate()}</span>{sm?.holiday && <span class="holn">{sm.holiday}</span>}{warn && <i class="lgdot" aria-hidden="true" />}</span>
                {evs.length > 0 && <span class="c-ev">{evs.slice(0, 2).map((e) => <span key={e.id} class="evc" style={`background:${EVENT_STYLE[e.kind].bg};color:${EVENT_STYLE[e.kind].fg}`}>{e.title}</span>)}{evs.length > 2 && <span class="evc more">+{evs.length - 2}</span>}</span>}
                {sm && <span class="c-stf"><span class="c-num"><span>{sm.staffCount}名</span>{short && <span class="cv">欠員{sm.vacant}</span>}</span><span class={`bar${short ? ' bad' : warn ? ' warn' : ''}`} aria-hidden="true"><i style={`width:${pct}%`} /></span></span>}
              </button>
            );
          })}
        </div>
        <div class="cal-legend small">
          <span class="lg"><i class="lgbox ok" />必要人数が揃っている</span>
          <span class="lg"><i class="lgbox bad" />欠員あり</span>
          <span class="lg"><i class="lgdot" />要確認（配置の穴・行事で人数不足）</span>
          <span class="lg"><i class="lgtxt">祝</i>祝日</span>
          <span class="lg"><i class="lgbox ev" />施設の行事</span>
        </div>
      </div>
      {wide && <aside class="side scroll">{detail(true)}</aside>}
      {!wide && sheet && <Modal title={fmtLong(sel)} onClose={() => setSheet(false)}>{detail(false)}</Modal>}
    </div>
  );
}

function DayDetail({ s, date, sum, go, openStaff, showDate }: { showDate?: boolean; s: State; date: string; sum: Sum; go: Go; openStaff: (id: string) => void }) {
  const vacs = s.vacancies.filter((v) => v.date === date && v.state !== 'filled');
  const [form, setForm] = useState<{ ev?: FacilityEvent } | null>(null);
  const evs = sum.events;
  return (
    <div class="stack">
      <div>{showDate && <h3 class="h3">{fmtLong(date)}{sum.holiday && <span class="chip bad" style="margin-left:8px">{sum.holiday}</span>}</h3>}
        {!showDate && sum.holiday && <span class="chip bad">{sum.holiday}</span>}
        <p class="muted">勤務 {sum.staffCount}名{sum.vacant ? `／欠員 ${sum.vacant}枠` : '／全枠充足'}</p>
        {sum.eventShort > 0 && <p class="small" style="color:var(--warn)"><Icon n="warning" sm /> 行事のため{sum.eventShort}名足りません</p>}</div>
      <button class="btn pri block" onClick={() => go('day', { date })}><Icon n="schedule" /> この日の1日を見る</button>
      <div class="stack" style="gap:8px">
        <div class="row spread"><div class="sec-title" style="margin:0">行事</div><button class="btn sm" onClick={() => setForm({})}><Icon n="add" sm /> 行事を追加</button></div>
        {evs.map((e) => <button key={e.id} class="evrow" onClick={() => setForm({ ev: e })} aria-label={`${e.title}を編集`}>
          <span class="evc" style={`background:${EVENT_STYLE[e.kind].bg};color:${EVENT_STYLE[e.kind].fg}`}>{e.kind}</span>
          <span class="evt"><b>{e.title}</b>{e.note && <span class="small">{e.note}</span>}{effectText(e) && <span class="small" style="color:var(--pri-tx)">{effectText(e)}</span>}</span><Icon n="edit" sm /></button>)}
        {!evs.length && <p class="small">この日の行事はありません。</p>}
      </div>
      {vacs.length > 0 && <div class="stack" style="gap:8px">{vacs.map((v) => <button key={v.id} class="card listbtn" onClick={() => go('vac', { vacId: v.id })}><span><b style="font-weight:500">{v.shift}／{unitName(v.unitId)}</b><br /><span class="small">{v.id}{v.needSkills.length ? '／必須スキルあり' : ''}</span></span><span class={`chip ${VAC_STATE[v.state].cls}`}>{VAC_STATE[v.state].label}</span></button>)}</div>}
      <div class="sec-title" style="margin:0">勤務帯 × ユニット（担当）</div>
      <div class="xscroll"><table class="tbl small-tbl"><thead><tr><th></th>{UNITS.map((u) => <th key={u.id}>{u.name}</th>)}</tr></thead><tbody>
        {SHIFT_ORDER.map((sh) => <tr key={sh}><th>{sh}{sum.byShift[sh].need > UNITS.length && <span class="mini warn" style="margin-left:4px">+{sum.byShift[sh].need - UNITS.length}</span>}</th>{UNITS.map((u) => { const as = s.assignments.filter((a) => a.date === date && a.shift === sh && a.unitId === u.id);
          const act = as.filter((a) => a.status !== 'absent'); const ab = as.filter((a) => a.status === 'absent');
          return <td key={u.id}>{act.map((a) => <div key={a.id}><button class="link" onClick={() => openStaff(a.staffId)}>{staffById(a.staffId).name.split(' ')[0]}</button>{a.status === 'late' && <span class="mini warn">遅</span>}{a.status === 'early' && <span class="mini warn">早退</span>}{a.note?.includes('行事') && <span class="mini">行事</span>}</div>)}
            {ab.map((a) => <div key={a.id} class="small" style="text-decoration:line-through">{staffById(a.staffId).name.split(' ')[0]}</div>)}
            {!act.length && <span class="chip bad">欠員</span>}</td>; })}</tr>)}
      </tbody></table></div>
      {sum.issues.length > 0 && <><div class="sec-title" style="margin:0">配置の検証</div><ul class="issues">{sum.issues.slice(0, 5).map((i, k) => <li key={k}><span class={`chip ${i.kind === 'skill' ? 'bad' : 'warn'}`}>{i.kind === 'skill' ? 'スキル' : '人数'}</span> {issueTime(i)} {i.text}</li>)}</ul></>}
      {sum.issues.length === 0 && vacs.length === 0 && sum.eventShort === 0 && <p class="muted">この日は必要人数・休憩・スキルの検証で問題ありません。</p>}
      {form && <EventForm date={date} event={form.ev} onClose={() => setForm(null)} />}
    </div>
  );
}
