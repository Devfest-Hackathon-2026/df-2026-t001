import { useState } from 'preact/hooks';
import type { State } from '../core/store';
import { collectionClosed, submitMonthRequests } from '../core/store';
import { MY_ID, SHIFTS, SHIFT_ORDER } from '../core/facility';
import { fmtMD, parseYmd, addDays, stampDay, stampTime } from '../core/dates';
import { eventsOn, holidayOf } from '../core/events';
import type { ShiftCode } from '../core/types';
import { Icon, Modal } from '../shared/ui';
import { Ctx, MiniCal, myAssign } from './common';
import { mySkillShifts } from './Avail';

type Item = { date: string; shifts: ShiftCode[] };
export interface MonthData { dayOff: string[]; avail: Item[]; hope: ShiftCode[] }
const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8)}`;
const dayDiff = (a: string, b: string) => Math.round((parseYmd(b).getTime() - parseYmd(a).getTime()) / 86400000);

/** 保存済みの「来月の希望」を state から取り出す */
export function myMonth(s: State): MonthData {
  const m = s.collection.month;
  return { dayOff: (s.collection.submitted[MY_ID]?.dates ?? []).filter((d) => d.startsWith(m)), avail: (s.availability[MY_ID] ?? []).filter((x) => x.date.startsWith(m)), hope: s.prefs[MY_ID].shiftHope };
}
export const isClosed = (s: State) => collectionClosed(s);

/** お知らせ（link: 'dayoff'）から「来月の希望」の画面を開く。シフトタブが開いたときに1回だけ読む */
let pendingOpen = false;
export const requestMonthOpen = () => { pendingOpen = true; window.dispatchEvent(new Event('emp-open-month')); };
export const takeMonthOpen = () => { const v = pendingOpen; pendingOpen = false; return v; };

/** シフト作成君の要約文（平易な日本語） */
export function summarize(d: MonthData): string[] {
  const out: string[] = [];
  if (d.dayOff.length) out.push(`${d.dayOff.slice().sort().map(md).join('・')}は休み希望`);
  const groups = new Map<string, string[]>();
  for (const x of d.avail.slice().sort((a, b) => a.date.localeCompare(b.date))) { const k = x.shifts.length ? x.shifts.join('・') : ''; groups.set(k, [...(groups.get(k) ?? []), md(x.date)]); }
  for (const [k, ds] of groups) out.push(k ? `${ds.join('・')}は${k}なら入れます` : `${ds.join('・')}はどの勤務帯でも入れます`);
  if (d.hope.length) out.push(`勤務帯は${d.hope.join('・')}を希望しています`);
  return out;
}
export const summaryText = (d: MonthData) => { const l = summarize(d); return l.length ? `${l.join('、')}。` : '今月は特に希望はありません。'; };

export function openLeaderThread(c: Ctx) {
  try { localStorage.setItem('emp-open-thread', 'leader'); } catch { /* ignore */ }
  c.go('chat'); setTimeout(() => window.dispatchEvent(new CustomEvent('emp-open-thread', { detail: 'leader' })), 0);
}

const MODES = [{ k: 'off', label: '休み希望', icon: 'beach_access' }, { k: 'avail', label: '入れる', icon: 'event_available' }, { k: 'erase', label: '消す', icon: 'backspace' }] as const;
type Mode = (typeof MODES)[number]['k'];

export function MonthRequest({ s, c, onClose }: { s: State; c: Ctx; onClose: () => void }) {
  const col = s.collection; const mlabel = `${+col.month.slice(5)}月`;
  const init = myMonth(s);
  const [dayOff, setDayOff] = useState<string[]>(init.dayOff);
  const [avail, setAvail] = useState<Item[]>(init.avail);
  const [hope, setHope] = useState<ShiftCode[]>(init.hope);
  const [mode, setMode] = useState<Mode>('off');
  const [pshifts, setPshifts] = useState<ShiftCode[]>([]);
  const [step, setStep] = useState<'edit' | 'confirm'>('edit');
  const closed = isClosed(s); const sub = col.submitted[MY_ID];
  const can = mySkillShifts(); const pr = s.prefs[MY_ID];
  const cur: MonthData = { dayOff, avail, hope };
  const month = col.month + '-01';
  const monthDays = Array.from({ length: 31 }, (_, i) => addDays(month, i)).filter((d) => d.startsWith(col.month));
  const info = monthDays.map((d) => ({ d, h: holidayOf(d), ev: eventsOn(s.events, d) })).filter((x) => x.h || x.ev.length);

  const paint = (d: string) => {
    if (closed) return;
    const off = dayOff.includes(d); const av = avail.find((x) => x.date === d);
    if (mode === 'erase') { setDayOff(dayOff.filter((x) => x !== d)); setAvail(avail.filter((x) => x.date !== d)); return; }
    if (mode === 'off') { setDayOff(off ? dayOff.filter((x) => x !== d) : [...dayOff, d].sort()); setAvail(avail.filter((x) => x.date !== d)); return; }
    const same = av && JSON.stringify(av.shifts) === JSON.stringify(pshifts);
    setDayOff(dayOff.filter((x) => x !== d));
    setAvail(same ? avail.filter((x) => x.date !== d) : [...avail.filter((x) => x.date !== d), { date: d, shifts: pshifts.slice() }].sort((a, b) => a.date.localeCompare(b.date)));
  };
  const submit = () => { submitMonthRequests(MY_ID, { dayOff, avail, shiftHope: hope }); c.toast(`${mlabel}の希望を提出しました`); onClose(); };
  const left = dayDiff(s.today, col.deadline);
  const warnEv = dayOff.flatMap((d) => eventsOn(s.events, d).filter((e) => e.effect && (e.effect.extra > 0 || e.effect.allStaff)).map((e) => ({ d, e })));

  const note = <div class="sum"><p class="small">希望は確定ではありません。できるだけ反映します。締切 {fmtMD(col.deadline)} まで何度でも変更できます。</p></div>;
  const footer = closed
    ? <><button class="btn" onClick={onClose}>閉じる</button><button class="btn tonal" onClick={() => { onClose(); openLeaderThread(c); }}>リーダーに相談</button></>
    : step === 'edit'
      ? <><button class="btn" onClick={onClose}>閉じる</button><button class="btn pri" onClick={() => setStep('confirm')}>内容を確認する</button></>
      : <><button class="btn" onClick={() => setStep('edit')}>戻って直す</button><button class="btn pri" onClick={submit}>{sub ? 'この内容で更新する' : 'この内容で提出'}</button></>;

  return (
    <Modal title={`${mlabel}の希望を出す`} onClose={onClose} footer={footer}>
      {closed && <div class="sum" style="margin-bottom:12px"><b>締切（{fmtMD(col.deadline)}）を過ぎたため、変更できません。</b><p class="small" style="margin-top:4px">変更したい場合は、リーダーに相談してください。</p></div>}
      {step === 'edit' || closed ? (
        <div class="stack">
          {!closed && <p class="muted">{sub ? `提出済みです（${stampDay(sub.at).slice(5).replace('-', '/')} ${stampTime(sub.at)}）。変更して「内容を確認する」から更新できます。` : `締切は${fmtMD(col.deadline)}（あと${Math.max(0, left)}日）。日付をタップして、休みたい日・入れる日を塗ってください。`}</p>}
          <div class="mcal">
            <MiniCal month={month} today={s.today} onPick={paint}
              cell={(d) => { const off = dayOff.includes(d); const av = avail.find((x) => x.date === d); const h = holidayOf(d); const evs = eventsOn(s.events, d); const a = myAssign(s, d);
                return { disabled: closed, selected: off || !!av, content: (
                  <div class="mc">
                    {off ? <span class="mk off">休み</span> : av ? <span class="mk in">入{av.shifts.length ? av.shifts.map((k) => SHIFTS[k].short).join('') : ''}</span> : a && a.status !== 'absent' ? <span class="mk ghost">{SHIFTS[a.shift].short}</span> : <span class="mk none" />}
                    <span class="tags">{h && <i class="t h">祝</i>}{evs.length > 0 && <i class="t e">行</i>}</span>
                  </div>) }; }} />
          </div>
          <div class="row small" style="flex-wrap:wrap;gap:12px"><span><span class="mk off sm">休み</span> 休み希望</span><span><span class="mk in sm">入</span> 入れる日</span><span><span class="mk ghost sm">夜</span> いまの予定（参考）</span><span><i class="t h">祝</i> 祝日</span><span><i class="t e">行</i> 行事</span></div>
          <div class="small">休み希望 <b>{dayOff.length}日</b>　入れる日 <b>{avail.length}日</b></div>
          {info.length > 0 && <div><div class="sec-title" style="margin-top:0">祝日・行事</div>{info.map((x) => <div key={x.d} class="small" style="margin:2px 0;color:var(--tx)"><b>{md(x.d)}</b>　{x.h ?? ''}{x.h && x.ev.length ? '、' : ''}{x.ev.map((e) => `${e.title}${e.effect ? (e.effect.allStaff ? `（${e.effect.shifts.join('・')}は全員参加）` : e.effect.extra ? `（${e.effect.shifts.join('・')}に+${e.effect.extra}名）` : '') : ''}`).join('、')}</div>)}</div>}
          {!closed && <div class="modebar">
            <div class="row" style="gap:8px">{MODES.map((m) => <button key={m.k} class={`opt${mode === m.k ? ' on' : ''}`} style="flex:1;justify-content:center;padding:0 8px" aria-pressed={mode === m.k} onClick={() => setMode(m.k)}><Icon n={m.icon} sm />{m.label}</button>)}</div>
            {mode === 'avail' && <div style="margin-top:8px"><div class="small" style="margin-bottom:4px">入れる勤務帯（選ばないと「どれでも」）。欠員が出たら優先して連絡します。</div><div class="row" style="flex-wrap:wrap">{can.map((k) => <button key={k} class={`opt sm${pshifts.includes(k) ? ' on' : ''}`} aria-pressed={pshifts.includes(k)} onClick={() => setPshifts(pshifts.includes(k) ? pshifts.filter((x) => x !== k) : [...pshifts, k])}>{k}</button>)}</div></div>}
            {mode === 'off' && <div class="small" style="margin-top:6px">休みたい日をタップ（もう一度で解除）</div>}
            {mode === 'erase' && <div class="small" style="margin-top:6px">タップした日の希望を消します</div>}
          </div>}
          <div>
            <div class="sec-title" style="margin-top:0">勤務帯の希望（任意）</div>
            <div class="row" style="flex-wrap:wrap">{SHIFT_ORDER.filter((k) => can.includes(k)).map((k) => <button key={k} class={`opt${hope.includes(k) ? ' on' : ''}`} disabled={closed} aria-pressed={hope.includes(k)} onClick={() => setHope(hope.includes(k) ? hope.filter((x) => x !== k) : [...hope, k])}>{k}</button>)}</div>
            <p class="small" style="margin-top:8px">休憩の希望：<b>{pr.breakPref ?? '特になし'}</b>　退勤上限：<b>{pr.leaveBy ? `${pr.leaveBy}${pr.leaveReason ? `（${pr.leaveReason}）` : ''}` : 'なし'}</b>　<button class="link" onClick={() => { onClose(); c.go('settings'); }}>設定で変える</button></p>
          </div>
        </div>
      ) : (
        <div class="stack">
          <div class="row" style="gap:8px;align-items:flex-start"><span class="av sm ai"><Icon n="auto_awesome" sm /></span>
            <div class="bub" style="max-width:100%"><div class="small" style="margin-bottom:4px">シフト作成君</div>{`${mlabel}の希望をまとめました。`}<br /><b>{summaryText(cur)}</b></div></div>
          {warnEv.length > 0 && <div class="sum"><b style="font-weight:500">確認：</b><span class="small"> {warnEv.map((x) => `${md(x.d)}は${x.e.title}で人手が必要な日です`).join('。')}。休み希望は、調整になる場合があります。</span></div>}
          {note}
          <p class="small">間違いがあれば「戻って直す」を押してください。提出後も、シフトタブの「{mlabel}の希望」から、または「12/24は休みたい」のようにシフト作成君へ話しかけて、変更できます。</p>
        </div>
      )}
    </Modal>
  );
}

/** シフトタブ・ホームに置く入口カード */
export function MonthCard({ s, c, quiet, onOpen }: { s: State; c: Ctx; quiet?: boolean; onOpen: () => void }) {
  const col = s.collection; const mlabel = `${+col.month.slice(5)}月`; const sub = col.submitted[MY_ID];
  const closed = isClosed(s); const left = dayDiff(s.today, col.deadline); const d = myMonth(s);
  if (quiet && (sub || closed)) return null;
  if (quiet) return (
    <section class="card row spread" style="gap:12px">
      <div style="min-width:0"><b>来月の希望をまだ出していません</b><div class="muted">{mlabel}分・締切 {fmtMD(col.deadline)}（あと{Math.max(0, left)}日）</div></div>
      <button class="btn sm tonal" style="flex:none;white-space:nowrap" onClick={onOpen}>希望を出す</button>
    </section>
  );
  return (
    <section class={`card mreq${sub ? '' : ' todo'}`}>
      <div class="row spread" style="gap:12px;align-items:flex-start">
        <div style="min-width:0"><b style="font-size:17px">{mlabel}の希望</b>
          <div class="muted" style="margin-top:2px">{closed ? `締切（${fmtMD(col.deadline)}）を過ぎました` : sub ? `提出済み（${stampDay(sub.at).slice(5).replace('-', '/')} ${stampTime(sub.at)}）・締切まであと${Math.max(0, left)}日` : `まだ提出していません・締切 ${fmtMD(col.deadline)}（あと${Math.max(0, left)}日）`}</div></div>
        {sub ? <span class="chip ok">提出済み</span> : <span class={`chip ${closed ? 'bad' : 'warn'}`}>{closed ? '未提出（締切済み）' : '未提出'}</span>}
      </div>
      {sub ? <p style="margin-top:8px">{summaryText(d)}</p> : <p class="small" style="margin-top:8px">休みたい日・入れる日を、カレンダーにタップで塗って出せます。シフト作成君が内容をまとめて確認します。</p>}
      <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
        <button class={`btn${sub ? '' : ' pri'} block`} style="flex:1" onClick={onOpen}>{closed ? '提出内容を見る' : sub ? '変更する' : '希望を出す'}</button>
        {closed && <button class="btn tonal" onClick={() => openLeaderThread(c)}>リーダーに相談</button>}
      </div>
    </section>
  );
}
