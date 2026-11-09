import { useMemo, useState } from 'preact/hooks';
import './plan.css';
import { SHIFTS, SHIFT_ORDER, STAFF, UNITS, staffById, unitName } from '../core/facility';
import { addDays, daysInRange, DOW_JA, dow, fmtMD, parseYmd } from '../core/dates';
import { canWork, summarizeDay } from '../core/roster';
import { monthStats } from '../core/labor';
import { holidayOf, eventsOn } from '../core/events';
import { monthEnd } from '../core/planner';
import { createPlan, planAssign, publishPlan, remindUnsubmitted } from '../core/store';
import type { State } from '../core/store';
import type { Assignment, ShiftCode } from '../core/types';
import { Icon, Modal, useToast } from '../shared/ui';

const shiftMonth = (m: string, n: number) => { const [y, mm] = m.split('-').map(Number); const d = new Date(y, mm - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const SHORTS = SHIFT_ORDER.map((k) => SHIFTS[k].short);
const letterOf = (k: ShiftCode) => SHIFTS[k].short;

/** 日付ごとの勤務をまとめる */
const indexDraft = (draft: Assignment[]) => { const m = new Map<string, Assignment>(); for (const a of draft) if (a.status !== 'absent') m.set(`${a.staffId}|${a.date}`, a); return m; };

/** 候補（その日に入っていない人）。入れる日を出した人を先に */
function suggest(s: State, draft: Assignment[], date: string, shift: ShiftCode, month: string, n = 3) {
  const dayOff = s.collection.month === month ? s.collection.submitted : {};
  return STAFF.filter((x) => x.shifts.length && !x.isLeader && canWork(x, shift))
    .filter((x) => !draft.some((a) => a.staffId === x.id && a.date === date && a.status !== 'absent'))
    .filter((x) => !draft.some((a) => a.staffId === x.id && a.shift === '夜勤' && a.date === addDays(date, -1)))
    .filter((x) => !(dayOff as Record<string, { dates: string[] } | null>)[x.id]?.dates.includes(date))
    .map((x) => ({ staff: x, avail: !!s.availability[x.id]?.some((v) => v.date === date && (!v.shifts.length || v.shifts.includes(shift))), cnt: draft.filter((a) => a.staffId === x.id && a.status !== 'absent').length }))
    .sort((a, b) => Number(b.avail) - Number(a.avail) || a.cnt - b.cnt).slice(0, n);
}

export function Plan({ s, onOpen }: { s: State; onOpen?: (target: string) => void }) {
  const [month, setMonth] = useState(s.plan?.month ?? s.collection.month);
  const [cell, setCell] = useState<{ staffId: string; date: string } | null>(null);
  const [dayM, setDayM] = useState<string | null>(null);
  const [pub, setPub] = useState(false);
  const [allSp, setAllSp] = useState(false);
  const [toast, setToast] = useToast();
  const plan = s.plan && s.plan.month === month ? s.plan : undefined;
  const ro = plan?.status === 'published';
  const days = useMemo(() => daysInRange(`${month}-01`, monthEnd(month)), [month]);
  const sub = s.collection.month === month ? s.collection.submitted : {};
  const staffIds = Object.keys(sub).filter((k) => sub[k]);
  const total = Object.keys(sub).length; const unsub = total - staffIds.length;
  const availN = Object.values(s.availability).reduce((t, l) => t + l.filter((x) => x.date.startsWith(month)).length, 0);
  const evs = s.events.filter((e) => e.date.startsWith(month));
  const dayOffOf = (id: string) => (sub as Record<string, { dates: string[] } | null>)[id]?.dates ?? [];

  const sums = useMemo(() => (plan ? new Map(days.map((d) => [d, summarizeDay(plan.draft, d, s.events)])) : new Map()), [plan?.draft, days, s.events]);
  const stats = useMemo(() => (plan ? monthStats(plan.draft, `${month}-01`) : []), [plan?.draft, month]);
  const warnList = stats.flatMap((x) => x.warnings.map((w) => ({ staffId: x.staffId, ...w })));
  const idx = useMemo(() => indexDraft(plan?.draft ?? []), [plan?.draft]);
  const spareBy = useMemo(() => { const m = new Map<string, string[]>(); for (const [d, l] of Object.entries(plan?.spares ?? {})) for (const x of l) (m.get(x.staffId) ?? m.set(x.staffId, []).get(x.staffId)!).push(d); return m; }, [plan?.spares]);

  const groups = UNITS.map((u) => ({ u, rows: STAFF.filter((x) => x.shifts.length && x.homeUnit === u.id) }));
  const make = (nightMax?: number) => { createPlan(month, nightMax ? { nightMax } : {}); setToast('シフト案を作成しました'); };

  return (
    <div class="page scroll plan">
      <div class="ph">
        <div class="mnav"><button class="iconbtn" aria-label="前の月" onClick={() => setMonth(shiftMonth(month, -1))}><Icon n="chevron_left" /></button><h2>{month.slice(0, 4)}年{+month.slice(5)}月</h2><button class="iconbtn" aria-label="次の月" onClick={() => setMonth(shiftMonth(month, 1))}><Icon n="chevron_right" /></button></div>
        {plan && <div class="row" style="gap:8px"><span class={`chip ${ro ? 'ok' : 'warn'}`}>{ro ? '公開済み' : '作成中（未公開）'}</span><span class="small">作成 {plan.createdAt.slice(5, 16)}</span></div>}
      </div>

      <section class="card" style="margin-top:12px">
        <h3 class="h3">作る前の確認</h3>
        <div class="ready">
          <div class="rcell"><b>{staffIds.length}/{total || '—'}</b>名<span class="small">希望休の提出{total ? `（締切 ${fmtMD(s.collection.deadline)}）` : '：この月は集めていません'}</span>{unsub > 0 && <button class="btn sm" style="margin-top:8px" onClick={() => { remindUnsubmitted(); setToast(`未提出の${unsub}名に催促を送りました`); }}>未提出者に催促</button>}</div>
          <div class="rcell"><b>{availN}</b>件<span class="small">「入れる日」の登録（補欠になる人）</span></div>
          <div class="rcell"><b>{evs.length}</b>件<span class="small">行事{evs.length ? `：${evs.slice(0, 2).map((e) => `${+e.date.slice(8)}日 ${e.title}`).join('、')}${evs.length > 2 ? ' ほか' : ''}` : 'はありません'}</span></div>
        </div>
        <div class="row wrap" style="margin-top:16px;gap:8px">
          <button class="btn pri" onClick={() => make()}><Icon n="auto_awesome" sm /> シフト作成君に作ってもらう</button>
          <button class="btn" onClick={() => make(6)}>夜勤を減らして作る（月6回まで）</button>
        </div>
        <p class="small" style="margin-top:8px">希望休、入れる日、行事の必要人数、連勤・勤務間隔などの労務ルールを反映して作ります。作ったあとに確認・編集してから公開します。モック（Gemini は未接続）。</p>
      </section>

      {!plan && (
        <section style="margin-top:12px"><h3 class="h3">シフト作成の流れ</h3>
          <ol class="steps3" style="padding:0">
            <li><span class="n">1</span><div><b style="font-weight:500">希望を集める</b><div class="small">希望休と「入れる日」を、従業員がシフト作成君から提出します。</div></div></li>
            <li><span class="n">2</span><div><b style="font-weight:500">シフト作成君が作る</b><div class="small">上のボタンで、希望・行事・労務ルールを反映した案を作ります。</div></div></li>
            <li><span class="n">3</span><div><b style="font-weight:500">確認して公開</b><div class="small">不足日や警告を見て、必要なところを直してから公開します。</div></div></li>
          </ol>
          <p class="muted" style="margin-top:12px">{s.plan ? `作成中のシフトは${+s.plan.month.slice(5)}月分です。` : 'まだシフト案がありません。'}</p>
        </section>
      )}

      {plan && <>
        <h3 class="h3" style="margin:20px 0 8px">できあがりの確認</h3>
        <div class="sumgrid">
          <div class={`scard ${plan.stats.dayOffHonored === plan.stats.dayOffTotal ? 'ok' : 'warn'}`}><div class="v">{plan.stats.dayOffHonored}/{plan.stats.dayOffTotal}</div><div class="small">希望休を反映</div></div>
          <div class={`scard ${plan.stats.shortDays ? 'bad' : plan.stats.warnDays ? 'warn' : 'ok'}`}><div class="v">{plan.stats.shortDays}日</div><div class="small">人が足りない日{plan.stats.warnDays ? `（要確認 ${plan.stats.warnDays}日）` : ''}／欠員枠 {plan.stats.vacantSlots}</div></div>
          <div class="scard"><div class="v">{plan.stats.extraSlots}枠</div><div class="small">行事のための追加配置</div></div>
          <div class="scard"><div class="v">{Object.values(plan.spares).reduce((t, l) => t + l.length, 0)}日分</div><div class="small">補欠（のべ）</div></div>
          <div class={`scard ${warnList.length ? 'warn' : 'ok'}`}><div class="v">{warnList.length}件</div><div class="small">労務の警告</div></div>
        </div>
        <ul class="small" style="margin:8px 0 0 18px;color:var(--tx)">{plan.notes.map((n) => <li key={n}>{n}</li>)}</ul>

        <div class="stack" style="margin-top:16px;gap:12px">
          <details class="acc" open><summary>勤務表（職員×日）<span class="small" style="font-weight:400">{ro ? '公開済み：変更は月間・日次から' : 'マスをタップして直せます。日付をタップすると、その日の詳細'}</span></summary>
            <div class="accbody">
              <div class="legend"><span class="lgt"><span class="t sh-早" style="width:22px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px">{SHORTS[0]}</span>早番</span><span class="lgt"><span class="sh-日" style="width:22px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px">{SHORTS[1]}</span>日勤</span><span class="lgt"><span class="sh-遅" style="width:22px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px">{SHORTS[2]}</span>遅番</span><span class="lgt"><span class="sh-夜" style="width:22px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px">{SHORTS[3]}</span>夜勤</span><span class="lgt"><span style="color:var(--ok);outline:1px dashed var(--ok);border-radius:5px;padding:0 5px">休</span>希望休を反映</span><span class="lgt"><span style="width:12px;height:4px;background:var(--bad);display:inline-block;border-radius:2px" />人が足りない日</span><span class="lgt"><span style="width:6px;height:6px;border-radius:50%;background:var(--pri);display:inline-block" />行事の日</span></div>
              {groups.map(({ u, rows }) => (
                <details key={u.id} class="acc" style="margin-top:8px" open={u.id === 'U1'}><summary>{u.floor}階 {u.name}（所属 {rows.length}名）</summary>
                  <div class="accbody pgrid-wrap">
                    <table class={`pgrid${ro ? ' ro' : ''}`}>
                      <thead><tr><th class="nm">職員</th>{days.map((d) => { const w = dow(d); const sm = sums.get(d); const hol = holidayOf(d); return <th key={d} class={`dh${w === 0 ? ' sun' : w === 6 ? ' sat' : ''}${hol ? ' hol hol-col' : ''}${sm?.level === 'short' ? ' short' : sm?.level === 'warn' ? ' warn' : ''}`} onClick={() => setDayM(d)} title={hol ?? ''}><span class="d">{+d.slice(8)}</span><span class="w">{DOW_JA[w]}</span><span class="bar" />{eventsOn(s.events, d).length > 0 && <span class="ev" />}</th>; })}</tr></thead>
                      <tbody>{rows.map((st) => { const off = dayOffOf(st.id); return <tr key={st.id}><td class="nm"><button class="link" style="font-size:13px" onClick={() => undefined}>{st.name}</button></td>{days.map((d) => { const a = idx.get(`${st.id}|${d}`); const ake = !a && plan.draft.some((x) => x.staffId === st.id && x.shift === '夜勤' && x.date === addDays(d, -1)); const wantOff = off.includes(d);
                        return <td key={d} class={`c${holidayOf(d) ? ' hol-col' : ''}`} onClick={() => !ro && setCell({ staffId: st.id, date: d })}>{a ? <span class={`t sh-${letterOf(a.shift)}${wantOff ? ' conf' : ''}`} title={`${a.shift}／${unitName(a.unitId)}${wantOff ? '（希望休の日）' : ''}`}>{letterOf(a.shift)}</span> : ake ? <span class="ake">明</span> : wantOff ? <span class="t hope">休</span> : <span class="off">・</span>}</td>; })}</tr>; })}</tbody>
                    </table>
                  </div>
                </details>))}
            </div>
          </details>

          <details class="acc"><summary>補欠（欠員のとき、最優先で打診する人）</summary>
            <div class="accbody"><p class="small" style="margin-bottom:8px">「入れる日」を出したが、このシフトでは勤務に入らない人です。欠員が出たときは、まずこの人たちに打診します（順番は公平に回します）。</p>
              {[...spareBy.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, allSp ? 99 : 8).map(([id, ds]) => <div key={id} class="row-li"><span><b style="font-weight:500">{staffById(id).name}</b><span class="small"> {staffById(id).role}</span></span><span class="small">{ds.length}日：{ds.slice(0, 5).map((d) => `${+d.slice(8)}日`).join('、')}{ds.length > 5 ? ' ほか' : ''}</span></div>)}
              {spareBy.size > 8 && <button class="btn sm" style="margin-top:8px" onClick={() => setAllSp(!allSp)}>{allSp ? '閉じる' : `すべて見る（${spareBy.size}名）`}</button>}
              {!spareBy.size && <p class="muted">補欠の人はいません。</p>}
            </div></details>

          <details class="acc"><summary>労務チェック・集計<span class={`chip ${warnList.length ? 'warn' : 'ok'}`}>{warnList.length ? `${warnList.length}件の警告` : '警告なし'}</span></summary>
            <div class="accbody">
              {warnList.slice(0, 8).map((w, i) => <div key={i} class="row-li"><span><b style="font-weight:500">{staffById(w.staffId).name}</b>：{w.text}</span><span class="chip warn">{w.kind}</span></div>)}
              {warnList.length > 8 && <p class="small" style="margin-top:8px">ほか {warnList.length - 8} 件</p>}
              {!warnList.length && <p class="muted">連勤・勤務間隔・夜勤回数・公休数に、目安を超える人はいません。</p>}
              <div class="row-li"><span class="small">平均（常勤）</span><span class="small">勤務 {avg(stats.map((x) => x.workDays))}日／夜勤 {avg(stats.map((x) => x.nights))}回／公休 {avg(stats.map((x) => x.offDays))}日</span></div>
              <p class="small" style="margin-top:8px">目安です。法令・就業規則に基づく最終判断は施設で行ってください。</p>
            </div></details>
        </div>

        <div class="row wrap" style="margin-top:20px;gap:8px">
          {!ro ? <button class="btn pri" onClick={() => setPub(true)}><Icon n="publish" sm /> このシフトを公開する</button> : <><span class="chip ok">公開済み</span><button class="btn" onClick={() => onOpen?.('shift')}>月間を見る</button></>}
        </div>
      </>}

      {cell && plan && <CellModal s={s} plan={plan} month={month} staffId={cell.staffId} date={cell.date} onClose={() => setCell(null)} onDone={(t) => { setCell(null); setToast(t); }} />}
      {dayM && plan && <DayModal s={s} plan={plan} month={month} date={dayM} ro={ro} onClose={() => setDayM(null)} onPick={(id) => { setDayM(null); setCell({ staffId: id, date: dayM }); }} onToast={setToast} />}
      {pub && plan && <Modal title="このシフトを公開しますか？" onClose={() => setPub(false)} footer={<><button class="btn" onClick={() => setPub(false)}>戻る</button><button class="btn pri" onClick={() => { publishPlan(); setPub(false); setToast('シフトを公開しました'); }}>公開する</button></>}>
        <p>{+month.slice(5)}月の勤務表・日次・月次が、この内容に置き換わります。</p>
        <ul style="margin:8px 0 0 18px"><li>希望休：{plan.stats.dayOffTotal}件中{plan.stats.dayOffHonored}件を反映</li><li>人が足りない日：{plan.stats.shortDays}日（欠員枠 {plan.stats.vacantSlots}）</li><li>労務の警告：{warnList.length}件</li></ul>
        {plan.stats.shortDays > 0 && <p class="small" style="margin-top:8px;color:var(--bad)">人が足りない日が残っています。公開後は欠員として、シフト作成君に任せて対応できます。</p>}
      </Modal>}
      {toast}
    </div>
  );
}
const avg = (a: number[]) => (a.length ? (a.reduce((t, x) => t + x, 0) / a.length).toFixed(1) : '—');

function CellModal({ s, plan, month, staffId, date, onClose, onDone }: { s: State; plan: NonNullable<State['plan']>; month: string; staffId: string; date: string; onClose: () => void; onDone: (t: string) => void }) {
  const st = staffById(staffId);
  const cur = plan.draft.find((a) => a.staffId === staffId && a.date === date && a.status !== 'absent');
  const [shift, setShift] = useState<ShiftCode | 'off'>(cur?.shift ?? 'off');
  const [unit, setUnit] = useState(cur?.unitId ?? st.homeUnit);
  const wantOff = (s.collection.month === month ? s.collection.submitted[staffId]?.dates ?? [] : []).includes(date);
  const after = useMemo(() => {
    let d = plan.draft.filter((a) => !(a.staffId === staffId && a.date === date));
    if (shift !== 'off') d = d.filter((a) => !(a.date === date && a.shift === shift && a.unitId === unit)).concat({ id: 'TMP', date, staffId, shift, unitId: unit, status: 'assigned' });
    return d;
  }, [shift, unit]);
  const unchanged = (shift === 'off' && !cur) || (cur && shift === cur.shift && unit === cur.unitId);
  const displaced = shift !== 'off' ? plan.draft.find((a) => a.date === date && a.shift === shift && a.unitId === unit && a.staffId !== staffId) : undefined;
  const warns: string[] = []; const oks: string[] = [];
  if (shift !== 'off') {
    if (!canWork(st, shift)) warns.push(`${st.name}さんは${shift}に入れません（勤務可能な勤務帯・退勤上限）`);
    if (wantOff) warns.push('本人の希望休の日です');
    if (plan.draft.some((a) => a.staffId === staffId && a.shift === '夜勤' && a.date === addDays(date, -1))) warns.push('前日が夜勤のため、夜勤明けの日です');
    if (displaced) warns.push(`いまの担当 ${staffById(displaced.staffId).name}さんは、この枠から外れます`);
  }
  const before = monthStats(plan.draft, `${month}-01`).find((x) => x.staffId === staffId)?.warnings.map((w) => w.text) ?? [];
  const afterW = monthStats(after, `${month}-01`).find((x) => x.staffId === staffId)?.warnings ?? [];
  for (const w of afterW) if (!before.includes(w.text)) warns.push(`労務：${w.text}`);
  const b = summarizeDay(plan.draft, date, s.events); const a = summarizeDay(after, date, s.events);
  if (a.vacant < b.vacant) oks.push(`その日の欠員枠が ${b.vacant} → ${a.vacant} に減ります`);
  if (a.vacant > b.vacant) warns.push(`その日の欠員枠が ${b.vacant} → ${a.vacant} に増えます`);
  if (a.issues.length > b.issues.length) warns.push(`人数・スキルの不足が ${b.issues.length} → ${a.issues.length} か所に増えます`);
  if (a.issues.length < b.issues.length) oks.push(`人数・スキルの不足が ${b.issues.length} → ${a.issues.length} か所に減ります`);
  if (!warns.length && !oks.length && !unchanged) oks.push('人数・スキル・労務の面で、問題は見つかりません');
  const apply = () => {
    if (cur && (shift === 'off' || cur.shift !== shift || cur.unitId !== unit)) planAssign(date, cur.shift, cur.unitId, null);
    if (shift !== 'off') planAssign(date, shift, unit, staffId);
    onDone(shift === 'off' ? `${st.name}さんを休みにしました` : `${st.name}さんを${fmtMD(date)} ${shift}に入れました`);
  };
  return (
    <Modal title={`${st.name}さん　${fmtMD(date)}`} onClose={onClose} footer={<><button class="btn" onClick={onClose}>やめる</button><button class="btn pri" disabled={!!unchanged} onClick={apply}>この内容にする</button></>}>
      <p class="muted">いま：{cur ? `${cur.shift}（${unitName(cur.unitId)}）` : '休み'}{wantOff ? '／希望休あり' : ''}</p>
      <div class="sec-title">勤務帯</div>
      <div class="choice">{[...SHIFT_ORDER, 'off' as const].map((k) => <button key={k} aria-pressed={shift === k} onClick={() => setShift(k)}>{k === 'off' ? '休み' : k}</button>)}</div>
      {shift !== 'off' && <><div class="sec-title">ユニット</div><div class="choice">{UNITS.map((u) => <button key={u.id} aria-pressed={unit === u.id} onClick={() => setUnit(u.id)}>{u.name}</button>)}</div></>}
      <div class="sec-title">変更したときの確認</div>
      <ul class="chk">{warns.map((t) => <li key={t} class="ng"><Icon n="warning" sm /> {t}</li>)}{oks.map((t) => <li key={t} class="ok"><Icon n="check_circle" sm /> {t}</li>)}{unchanged && <li class="muted">変更はありません。</li>}</ul>
    </Modal>
  );
}

function DayModal({ s, plan, month, date, ro, onClose, onPick, onToast }: { s: State; plan: NonNullable<State['plan']>; month: string; date: string; ro: boolean; onClose: () => void; onPick: (id: string) => void; onToast: (t: string) => void }) {
  const hol = holidayOf(date); const evs = eventsOn(s.events, date); const sm = summarizeDay(plan.draft, date, s.events);
  const spares = plan.spares[date] ?? [];
  return (
    <Modal title={`${fmtMD(date)}${hol ? `（${hol}）` : ''}`} onClose={onClose}>
      {evs.map((e) => <p key={e.id} class="small" style="margin-bottom:4px"><span class="chip pri">{e.kind}</span> {e.title}{e.effect ? `　${e.effect.allStaff ? '対象の勤務帯は全員参加' : e.effect.extra ? `${e.effect.shifts.join('・')}に+${e.effect.extra}名` : ''}` : ''}</p>)}
      <p class="muted" style="margin:8px 0">勤務 {sm.staffCount}名／欠員枠 {sm.vacant}{sm.eventShort ? `／行事の追加人数が不足 ${sm.eventShort}` : ''}</p>
      <div class="slots">
        <div class="hd" />{UNITS.map((u) => <div key={u.id} class="hd">{u.name}</div>)}
        {SHIFT_ORDER.map((sh) => <>
          <div class="lb" key={sh + 'l'}>{sh}</div>
          {UNITS.map((u) => { const as = plan.draft.filter((a) => a.date === date && a.shift === sh && a.unitId === u.id && a.status !== 'absent');
            const sg = as.length ? [] : suggest(s, plan.draft, date, sh, month, 2);
            return <div key={sh + u.id} class={`cell${as.length ? '' : ' empty'}`}>
              {as.map((a) => <button key={a.id} disabled={ro} onClick={() => onPick(a.staffId)}>{staffById(a.staffId).name.split(' ')[0]}</button>)}
              {!as.length && <span class="small" style="color:var(--bad)">空き</span>}
              {!ro && sg.map((c) => <button key={c.staff.id} title={c.avail ? '入れる日を出した人' : ''} onClick={() => { planAssign(date, sh, u.id, c.staff.id); onToast(`${c.staff.name}さんを${sh}（${u.name}）に入れました`); }}>{c.avail ? '★' : '＋'}{c.staff.name.split(' ')[0]}</button>)}
            </div>; })}
        </>)}
      </div>
      {!ro && <p class="small" style="margin-top:8px">空き枠の下の「＋名前」で入れられます。★は「入れる日」を出した人です。</p>}
      <div class="sec-title">補欠（入れる日を出した人）</div>
      {spares.length ? spares.map((x) => <div key={x.staffId} class="row-li"><span><b style="font-weight:500">{staffById(x.staffId).name}</b></span><span class="small">{x.shifts.join('・')}</span></div>) : <p class="muted">この日の補欠はいません。</p>}
    </Modal>
  );
}
void parseYmd;
