import { useMemo, useState } from 'preact/hooks';
import './plan.css';
import { SHIFTS, SHIFT_ORDER, STAFF, UNITS, staffById, unitName } from '../core/facility';
import { addDays, daysInRange, DOW_JA, dow, fmtMD, parseYmd } from '../core/dates';
import { canWork, summarizeDay } from '../core/roster';
import { monthStats } from '../core/labor';
import { holidayOf, eventsOn } from '../core/events';
import { monthEnd } from '../core/planner';
import { createPlan, planAssign, planSolving, publishPlan, remindUnsubmitted, sendPlanRequest } from '../core/store';
import type { State } from '../core/store';
import type { Assignment, ShiftCode } from '../core/types';
import { Icon, Modal, useToast } from '../shared/ui';
import { useWide } from './util';
import { PlanChat, impactOf, runChanges } from './PlanChat';
import { PlanGrid, ReqModal } from './PlanGrid';
import { Day } from './Day';
import type { Go } from './util';
import { needSkillsFor } from '../core/roster';
import { SKILLS } from '../core/facility';
import { fmtMin } from '../core/dates';

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

export function Plan({ s, onOpen, go, openStaff, openResident }: { s: State; onOpen?: (target: string) => void; go: Go; openStaff: (id: string) => void; openResident: (id: string) => void }) {
  const [month, setMonth] = useState(s.plan?.month ?? s.collection.month);
  const [cell, setCell] = useState<{ staffId: string; date: string } | null>(null);
  const [dayM, setDayM] = useState<string | null>(null);
  const [pub, setPub] = useState(false);
  const [allSp, setAllSp] = useState(false);
  const [dayFull, setDayFull] = useState<string | null>(null);
  const [rq, setRq] = useState<{ staffId: string; date: string; shift: ShiftCode; unitId: string } | null>(null);
  const dock = useWide(1100);
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
  const solvingNow = planSolving()?.month === month;
  const make = (nightMax?: number) => { createPlan(month, nightMax ? { nightMax } : {}); setToast('シフト案を作成しました'); };

  return (
    <div class="page scroll plan">
      <div class={dock ? 'plandock' : undefined}>
      <div class="plancol">
      <div class="ph">
        <div class="mnav"><button class="iconbtn" aria-label="前の月" onClick={() => setMonth(shiftMonth(month, -1))}><Icon n="chevron_left" /></button><h2>{month.slice(0, 4)}年{+month.slice(5)}月</h2><button class="iconbtn" aria-label="次の月" onClick={() => setMonth(shiftMonth(month, 1))}><Icon n="chevron_right" /></button></div>
        {plan && <div class="row" style="gap:8px"><span class={`chip ${ro ? 'ok' : 'warn'}`}>{ro ? '公開済み' : '作成中（未公開）'}</span><span class="small">作成 {plan.createdAt.slice(5, 16)}</span></div>}
      </div>

      <section class="card" style="margin-top:12px">
        <h3 class="h3">作る前の確認</h3>
        <div class="ready">
          <div class="rcell"><b>{staffIds.length}/{total || '—'}</b>名<span class="small">希望休の提出{total ? `（締切 ${fmtMD(s.collection.deadline)}）` : '：この月は集めていません'}</span>{unsub > 0 && <button class="btn sm" style="margin-top:8px" onClick={() => { const n = remindUnsubmitted(); setToast(`未提出の${n}名に催促を送りました。数秒後に数名が提出します`); }}>未提出者に催促</button>}{s.collection.remindedAt && <span class="small" style="margin-top:4px">催促済み {s.collection.remindedN}名（{s.collection.remindedAt.slice(11, 16)}）</span>}</div>
          <div class="rcell"><b>{availN}</b>件<span class="small">「入れる日」の登録（補欠になる人）</span></div>
          <div class="rcell"><b>{evs.length}</b>件<span class="small">行事{evs.length ? `：${evs.slice(0, 2).map((e) => `${+e.date.slice(8)}日 ${e.title}`).join('、')}${evs.length > 2 ? ' ほか' : ''}` : 'はありません'}</span></div>
        </div>
        <div class="row wrap" style="margin-top:16px;gap:8px">
          <button class="btn pri" disabled={solvingNow} onClick={() => make()}><Icon n="auto_awesome" sm /> {solvingNow ? 'ソルバーで最適化中…' : 'シフト作成君に作ってもらう'}</button>
          <button class="btn" disabled={solvingNow} onClick={() => make(6)}>夜勤を減らして作る（月6回まで）</button>
        </div>
        {solvingNow && <p class="small" role="status" style="margin-top:8px">最適化ソルバー（CP-SAT）で1か月分を組み直しています。先に簡易計算の案を表示しています（数秒〜20秒ほど）。</p>}
        <p class="small" style="margin-top:8px">希望休、入れる日、行事の必要人数、連勤・勤務間隔などの労務ルールを反映して作ります。作ったあとに確認・編集してから公開します。</p>
      </section>


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
          <ShortList s={s} plan={plan} days={days} sums={sums} onDay={setDayFull} />
          <PlanGrid s={s} plan={plan} month={month} days={days} ro={!!ro} sums={sums as never} onDay={setDayFull} onCell={(staffId, date) => setCell({ staffId, date })} onToast={setToast} />

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

      </div>
      {dock && <PlanChat s={s} month={month} onDone={setToast} />}
      </div>
      {!dock && <details class="card" style="margin-top:16px"><summary class="h3" style="cursor:pointer">シフト作成君に話して直す</summary><PlanChat s={s} month={month} onDone={setToast} /></details>}
      {dayFull && plan && <div class="dayfull" role="dialog" aria-label={`${fmtMD(dayFull)}の1日表示`}>
        <div class="dayfull-h"><b style="font-weight:500">作成中のシフト案での1日表示（{fmtMD(dayFull)}）</b><span class="small">1日タブと同じ画面です。不足は下の「配置の検証」に出ます</span>
          <span style="flex:1" />{!ro && <button class="btn sm pri" onClick={() => { const d = dayFull; setDayM(d); }}><Icon n="edit" sm /> この日の枠を直す・依頼する</button>}<button class="btn sm" onClick={() => setDayFull(null)}><Icon n="close" sm /> 閉じる</button></div>
        <div class="dayfull-b"><Day s={{ ...s, assignments: plan.draft }} date={dayFull} go={(view, o) => { if (view === 'day' && o?.date) setDayFull(o.date); else { setDayFull(null); go(view, o); } }} openStaff={openStaff} openResident={openResident} /></div></div>}
      {rq && <ReqModal s={s} staffId={rq.staffId} date={rq.date} shift={rq.shift} unitId={rq.unitId} kind="work" onClose={() => setRq(null)} onSent={setToast} />}
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
    if (shift === '夜勤' && plan.draft.some((a) => a.staffId === staffId && a.date === addDays(date, 1) && a.status !== 'absent')) warns.push('翌日（夜勤明けの日）に勤務があります');
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
  const [slot, setSlot] = useState<string>(() => { for (const sh of SHIFT_ORDER) for (const u of UNITS) if (!plan.draft.some((a) => a.date === date && a.shift === sh && a.unitId === u.id && a.status !== 'absent')) return `${sh}|${u.id}`; return `${SHIFT_ORDER[0]}|${UNITS[0].id}`; });
  const [sSh, sU] = slot.split('|') as [ShiftCode, string];
  const slotCands = useMemo(() => suggest(s, plan.draft, date, sSh, month, 6).map((c) => ({ ...c, imp: impactOf(s, plan.draft, [{ date, shift: sSh, unitId: sU, staffId: c.staff.id }], month) })), [slot, plan.draft]);
  const cur = plan.draft.filter((a) => a.date === date && a.shift === sSh && a.unitId === sU && a.status !== 'absent');
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
      {!ro && <><div class="sec-title">手動で直す（候補と、入れた後の変化）</div>
        <div class="choice">{SHIFT_ORDER.flatMap((sh) => UNITS.map((u) => { const n = plan.draft.filter((a) => a.date === date && a.shift === sh && a.unitId === u.id && a.status !== 'absent').length; const k = `${sh}|${u.id}`;
          return <button key={k} aria-pressed={slot === k} onClick={() => setSlot(k)}>{sh}・{u.name}{n ? '' : '（空き）'}</button>; }))}</div>
        <p class="small" style="margin:6px 0">{sSh}（{unitName(sU)}）：いまの担当 {cur.length ? cur.map((a) => staffById(a.staffId).name).join('、') : 'なし（空き）'}{cur.length ? '。入れると、いまの担当は外れます。' : ''}</p>
        <div class="stack" style="gap:8px">{slotCands.map((c) => <div key={c.staff.id} class="cand"><div style="flex:1;min-width:0"><div class="row" style="gap:6px;flex-wrap:wrap"><b style="font-weight:500">{c.staff.name}</b><span class="small">{c.staff.role}</span>{c.avail && <span class="chip pri">入れる日を出した人</span>}{c.staff.homeUnit !== sU && <span class="chip">他ユニットから応援</span>}</div>
          <ul class="small" style="margin:4px 0 0 16px">{c.imp.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div class="row" style="gap:6px"><button class="btn sm pri" onClick={() => { runChanges([{ date, shift: sSh, unitId: sU, staffId: c.staff.id }]); onToast(`${c.staff.name}さんを${sSh}（${unitName(sU)}）に入れました`); }}>入れる</button><button class="btn sm" onClick={() => { sendPlanRequest('work', c.staff.id, date, { shift: sSh, unitId: sU }); onToast(`${c.staff.name}さんに出勤を依頼しました`); }}>出勤を依頼</button></div></div>)}
          {!slotCands.length && <p class="muted">入れられる人が見つかりません。</p>}</div></>}
      <div class="sec-title">補欠（入れる日を出した人）</div>
      {spares.length ? spares.map((x) => <div key={x.staffId} class="row-li"><span><b style="font-weight:500">{staffById(x.staffId).name}</b></span><span class="small">{x.shifts.join('・')}</span></div>) : <p class="muted">この日の補欠はいません。</p>}
    </Modal>
  );
}
void parseYmd;

/** 不足の一覧（要対応と同じ見せ方）：いつ・どこで・何が（人数／スキル）足りないか */
function ShortList({ s, plan, days, sums, onDay }: { s: State; plan: NonNullable<State['plan']>; days: string[]; sums: Map<string, { level: string; vacant: number; issues: { t0: number; t1: number; scope: string; need: number; have: number; kind: string; text: string }[] }>; onDay: (d: string) => void }) {
  const [all, setAll] = useState(false);
  const rows = useMemo(() => days.flatMap((d) => {
    const sm = sums.get(d); if (!sm) return [];
    const slots = SHIFT_ORDER.flatMap((sh) => UNITS.filter((u) => !plan.draft.some((a) => a.date === d && a.shift === sh && a.unitId === u.id && a.status !== 'absent')).map((u) => ({ kind: 'slot' as const, date: d, text: `${sh} ${u.name}の担当がいません`, sub: (() => { const sk = needSkillsFor(plan.draft, d, sh, u.id).filter((k) => k !== 'night'); return sk.length ? `必須：${sk.map((k) => SKILLS[k].label).join('・')}` : ''; })(), shift: sh as ShiftCode, unitId: u.id })));
    const iss = sm.issues.map((i) => ({ kind: i.kind === 'skill' ? ('skill' as const) : ('head' as const), date: d, text: `${fmtMin(i.t0)}〜${fmtMin(i.t1)} ${i.scope}：${i.text}`, sub: `必要 ${i.need}／現在 ${i.have}`, shift: undefined as ShiftCode | undefined, unitId: undefined as string | undefined }));
    return [...slots, ...iss];
  }), [days, sums, plan.draft]);
  if (!rows.length) return <section class="card"><h3 class="h3">不足（時間・スキル）</h3><p class="muted" style="margin-top:6px">人数・スキルの不足はありません。</p></section>;
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <section class="card" id="plan-short">
      <div class="row spread wrap"><h3 class="h3">不足（時間・スキル）<span class="chip bad" style="margin-left:8px">{rows.length}件</span></h3><span class="small">行をタップすると、その日の1日表示（候補と依頼もそこから）</span></div>
      <div class="stack" style="gap:6px;margin-top:8px">{shown.map((r, i) => <button key={i} class="vitem" onClick={() => onDay(r.date)}>
        <div class="row spread"><b style="font-weight:500">{fmtMD(r.date)}（{DOW_JA[dow(r.date)]}）</b><span class={`chip ${r.kind === 'skill' ? 'bad' : r.kind === 'slot' ? 'bad' : 'warn'}`}>{r.kind === 'skill' ? 'スキル不足' : r.kind === 'slot' ? '担当なし' : '人数不足'}</span></div>
        <div class="small">{r.text}{r.sub ? `／${r.sub}` : ''}</div></button>)}</div>
      {rows.length > 8 && <button class="btn sm" style="margin-top:8px" onClick={() => setAll(!all)}>{all ? '閉じる' : `すべて見る（${rows.length}件）`}</button>}
    </section>
  );
}
