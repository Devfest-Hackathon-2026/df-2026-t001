import { useEffect, useRef, useState } from 'preact/hooks';
import { SHIFT_ORDER, STAFF, UNITS, staffById, unitName } from '../core/facility';
import { fmtMD } from '../core/dates';
import { summarizeDay } from '../core/roster';
import { monthStats } from '../core/labor';
import { interpretLeader } from '../core/leaderai';
import { createPlan, planAssign, remindUnsubmitted, sendPlanRequest } from '../core/store';
import { PAID_TARGET, paidCount } from '../core/paidleave';
import { daysInRange } from '../core/dates';
import { monthEnd } from '../core/planner';
import type { State } from '../core/store';
import type { Assignment, ShiftCode } from '../core/types';
import { Icon } from '../shared/ui';
import { askGemini, canonical } from './planIntent';

/** シフト作成画面の右パネル：シフト作成君に話して、勤務表の修正案を出してもらう（承認してから反映） */
interface Change { date: string; shift: ShiftCode; unitId: string; staffId: string | null }
interface Prop { label: string; changes: Change[] }
interface Msg { id: number; from: 'me' | 'ai'; text: string; props?: Prop[]; done?: Record<number, string>; action?: { label: string; run: () => string } }

const SHIFT_RX: [RegExp, ShiftCode][] = [[/夜勤|夜/, '夜勤'], [/早番|朝/, '早番'], [/遅番|夕/, '遅番'], [/日勤/, '日勤']];
const shiftIn = (t: string): ShiftCode | undefined => SHIFT_RX.find(([r]) => r.test(t))?.[1];
const dateIn = (t: string, month: string): string | undefined => {
  const y = month.slice(0, 4);
  const a = t.match(/(\d{1,2})\s*[/月]\s*(\d{1,2})/); if (a) return `${y}-${String(+a[1]).padStart(2, '0')}-${String(+a[2]).padStart(2, '0')}`;
  const b = t.match(/(\d{1,2})日/); if (b) return `${month}-${String(+b[1]).padStart(2, '0')}`;
};
const staffIn = (t: string) => STAFF.filter((x) => x.shifts.length && (t.includes(x.name.replace(/\s+/g, '')) || t.includes(x.name.split(' ')[0]))).sort((p, q) => t.indexOf(p.name.split(' ')[0]) - t.indexOf(q.name.split(' ')[0]));

export function applyChanges(draft: Assignment[], cs: Change[]): Assignment[] {
  let d = draft;
  for (const c of cs) {
    d = d.filter((a) => !(a.date === c.date && a.shift === c.shift && a.unitId === c.unitId)).filter((a) => !(c.staffId && a.date === c.date && a.staffId === c.staffId && a.shift === c.shift));
    if (c.staffId) d = d.concat({ id: `TMP${d.length}`, date: c.date, staffId: c.staffId, shift: c.shift, unitId: c.unitId, status: 'assigned' });
  }
  return d;
}
export const runChanges = (cs: Change[]) => cs.forEach((c) => planAssign(c.date, c.shift, c.unitId, c.staffId));

/** 変更の前後の影響（その日の欠員枠・労務の警告） */
export function impactOf(s: State, draft: Assignment[], cs: Change[], month: string): string[] {
  const after = applyChanges(draft, cs); const out: string[] = [];
  for (const date of new Set(cs.map((c) => c.date))) {
    const b = summarizeDay(draft, date, s.events), a = summarizeDay(after, date, s.events);
    if (a.vacant !== b.vacant) out.push(`${fmtMD(date)}の欠員枠 ${b.vacant} → ${a.vacant}`);
    if (a.issues.length !== b.issues.length) out.push(`${fmtMD(date)}の人数・スキルの不足 ${b.issues.length} → ${a.issues.length}か所`);
  }
  const ids = new Set(cs.map((c) => c.staffId).filter(Boolean) as string[]);
  const bw = monthStats(draft, `${month}-01`), aw = monthStats(after, `${month}-01`);
  for (const id of ids) {
    const before = bw.find((x) => x.staffId === id)?.warnings.map((w) => w.text) ?? [];
    for (const w of aw.find((x) => x.staffId === id)?.warnings ?? []) if (!before.includes(w.text)) out.push(`労務：${staffById(id).name}さん ${w.text}`);
  }
  return out.length ? out : ['人数・スキル・労務の面で、増える問題は見つかりません'];
}

export function interpretPlan(raw: string, s: State, month: string): { text: string; props?: Prop[]; action?: Msg['action']; unknown?: boolean } {
  const t = raw.replace(/\s+/g, '');
  const plan = s.plan && s.plan.month === month ? s.plan : undefined;
  const date = dateIn(t, month); const sh = shiftIn(t); const people = staffIn(t);
  const unit = UNITS.find((u) => t.includes(u.name));
  const slotOf = (id: string, d: string) => plan?.draft.find((a) => a.staffId === id && a.date === d && a.status !== 'absent');
  if (/(夜勤).*(減ら|少なく|抑え)|(シフト).*(作|つく|組)|作り直/.test(t)) {
    const nm = /(夜勤).*(減ら|少なく|抑え)/.test(t) ? 6 : undefined;
    return { text: `${+month.slice(5)}月のシフトを作ります${nm ? '（夜勤は月6回まで）' : ''}。希望休・入れる日・行事・労務ルールを反映します。${plan ? '今のシフト案は置き換わります。' : ''}`, action: { label: 'この内容で作る', run: () => { createPlan(month, nm ? { nightMax: nm } : {}); return 'シフト案を作成しました'; } } };
  }
  if (/催促|リマインド|未提出/.test(t)) { const n = Object.values(s.collection.submitted).filter((v) => !v).length; return { text: n ? `未提出の${n}名に催促を送ります。` : '未提出の人はいません。', action: n ? { label: '催促を送る', run: () => `未提出の${remindUnsubmitted()}名に催促を送りました` } : undefined }; }
  // 依頼（出勤・有休の打診・希望休の修正）
  const freeDay = (id: string, k = 0) => { const l = daysInRange(`${month}-01`, monthEnd(month)).filter((d) => d >= s.today && !plan?.draft.some((a) => a.staffId === id && a.date === d && a.status !== 'absent') && !(s.paidLeave?.[id] ?? []).includes(d) && new Date(d + 'T00:00:00').getDay() !== 0 && new Date(d + 'T00:00:00').getDay() !== 6); return l.length ? l[(k * 3) % l.length] : undefined; };
  if (/(有休|有給)/.test(t) && /(足りない|不足|取れて|未取得|届いて|少ない)/.test(t)) {
    const lack = STAFF.filter((x) => x.shifts.length && !x.isLeader && paidCount(s, x.id) < PAID_TARGET).map((x, i) => ({ x, d: freeDay(x.id, i) })).filter((r) => r.d);
    if (!lack.length) return { text: '有休が年5日に届いていない人はいません（デモ用の仮値）。' };
    return { text: `有休が年${PAID_TARGET}日に届いていない人は${lack.length}名です（デモ用の仮値）。勤務のない平日を1日ずつ選んで、有休を打診します。\n${lack.slice(0, 6).map((r) => `・${r.x.name}さん ${fmtMD(r.d!)}（あと${PAID_TARGET - paidCount(s, r.x.id)}日）`).join('\n')}${lack.length > 6 ? `\n ほか${lack.length - 6}名` : ''}`, action: { label: `${lack.length}名に有休を打診する`, run: () => { lack.forEach((r) => sendPlanRequest('paid', r.x.id, r.d!)); return `${lack.length}名に有休を打診しました。返事は「依頼の状況」に出ます`; } } };
  }
  if (people.length && /(依頼|お願い|打診|頼)/.test(t)) {
    const st = people[0];
    if (/(有休|有給)/.test(t)) { const d = date ?? freeDay(st.id); if (!d) return { text: `${st.name}さんに有休を打診できる日が見つかりません。` };
      return { text: `${st.name}さんに、${fmtMD(d)}の有休を打診します（今年度 ${paidCount(s, st.id)}日／義務${PAID_TARGET}日・デモ用の仮値）。`, action: { label: '有休を打診する', run: () => { sendPlanRequest('paid', st.id, d); return `${st.name}さんに有休を打診しました`; } } }; }
    if (/(希望休|休み)/.test(t) && /(修正|見直|変更|取り下げ|外し)/.test(t) && date) return { text: `${st.name}さんに、${fmtMD(date)}の希望休の見直しを依頼します。`, action: { label: '希望休の修正を依頼する', run: () => { sendPlanRequest('dayoff', st.id, date); return `${st.name}さんに依頼しました`; } } };
    if (date && /(出勤|入って|入れて|勤務|シフト)/.test(t)) { const shf = sh ?? '日勤'; const u = unit?.id ?? st.homeUnit;
      return { text: `${st.name}さんに、${fmtMD(date)}の${shf}（${unitName(u)}）への出勤を依頼します。承諾されると勤務表に反映されます。`, action: { label: '出勤を依頼する', run: () => { sendPlanRequest('work', st.id, date, { shift: shf, unitId: u }); return `${st.name}さんに出勤を依頼しました`; } } }; }
  }
  if (!plan) return { text: 'まだシフト案がありません。「12月のシフトを作って」「夜勤を減らして作って」と話しかけてください。' };
  if (plan.status === 'published') return { text: '公開済みのシフトは、ここからは直せません（変更は月間・日次の画面から）。' };
  if (/(入れ替え|交代|替わ|代わ)/.test(t) && people.length >= 2 && date) {
    const [p, q] = people; const sp = slotOf(p.id, date), sq = slotOf(q.id, date);
    if (!sp && !sq) return { text: `${fmtMD(date)}は、${p.name}さんも${q.name}さんも勤務に入っていません。` };
    const cs: Change[] = [];
    if (sp) cs.push({ date, shift: sp.shift, unitId: sp.unitId, staffId: q.id });
    if (sq) cs.push({ date, shift: sq.shift, unitId: sq.unitId, staffId: p.id });
    return { text: `${fmtMD(date)}の勤務を、${p.name}さんと${q.name}さんで入れ替える案です。`, props: [{ label: '入れ替える', changes: cs }] };
  }
  if (/(休み|休ま|外し|抜い|入れない|なし)/.test(t) && people.length && date) {
    const st = people[0]; const cur = slotOf(st.id, date);
    if (!cur) return { text: `${st.name}さんは${fmtMD(date)}にもともと勤務がありません。` };
    return { text: `${st.name}さんの${fmtMD(date)}（${cur.shift}／${unitName(cur.unitId)}）を休みにする案です。この枠は空きになります。`, props: [{ label: '休みにする', changes: [{ date, shift: cur.shift, unitId: cur.unitId, staffId: null }] }] };
  }
  if (/誰|候補|空い|入れる人/.test(t) && date && sh) {
    const free = UNITS.filter((u) => !unit || u.id === unit.id).filter((u) => !plan.draft.some((a) => a.date === date && a.shift === sh && a.unitId === u.id && a.status !== 'absent'));
    const target = free[0] ?? unit ?? UNITS[0];
    const busy = new Set(plan.draft.filter((a) => a.date === date && a.status !== 'absent').map((a) => a.staffId));
    const cands = STAFF.filter((x) => x.shifts.length && !x.isLeader && x.shifts.includes(sh) && !busy.has(x.id))
      .map((x) => ({ x, avail: !!s.availability[x.id]?.some((v) => v.date === date && (!v.shifts.length || v.shifts.includes(sh))) })).sort((a, b) => Number(b.avail) - Number(a.avail)).slice(0, 3);
    if (!cands.length) return { text: `${fmtMD(date)}の${sh}に入れる人が見つかりません。` };
    const why = (x: (typeof STAFF)[number], avail: boolean) => [avail && '「入れる日」を出している', x.homeUnit !== target.id && '他ユニットから応援', x.skills.includes('medical') && '医療的ケア可', plan.draft.filter((a) => a.staffId === x.id && a.status !== 'absent').length < 14 && '今月の勤務が少なめ'].filter(Boolean).join('・');
    return { text: `${fmtMD(date)}の${sh}（${target.name}）に入れる人の上位です。${free.length ? '' : 'この枠は埋まっているので、入れると今の担当が外れます。'}\n${cands.map((c) => `・${c.x.name}さん：${why(c.x, c.avail) || '勤務できる条件を満たしています'}`).join('\n')}`, props: cands.map((c) => ({ label: `${c.x.name}さん${c.avail ? '★' : ''}を入れる`, changes: [{ date, shift: sh, unitId: target.id, staffId: c.x.id }] })) };
  }
  if (people.length && date && sh) {
    const st = people[0]; const cur = slotOf(st.id, date);
    const u = unit?.id ?? (cur?.unitId ?? st.homeUnit);
    return { text: `${st.name}さんを${fmtMD(date)}の${sh}（${unitName(u)}）に入れる案です。${u !== st.homeUnit ? '他ユニットへの応援になります。' : ''}`, props: [{ label: '入れる', changes: [...(cur && (cur.shift !== sh || cur.unitId !== u) ? [{ date, shift: cur.shift, unitId: cur.unitId, staffId: null } as Change] : []), { date, shift: sh, unitId: u, staffId: st.id }] }] };
  }
  const base = interpretLeader(raw, s);
  if (base.action && base.action.kind === 'publishPlan') return { text: '公開は、下の「このシフトを公開する」から行ってください。' };
  return { unknown: true, text: '次のように話しかけてください。\n・「山田さんの11/24を休みに」\n・「佐藤さんを11/25の夜勤にひなたで入れて」\n・「11/24の日勤に誰が入れる？」\n・「山田さんと佐藤さんを11/24で入れ替えて」\n・「夜勤を減らして作り直して」\n・「山田さんに11/24の日勤を依頼して」\n・「山田さんに有休を打診して」\n・「有休が足りない人に打診して」' };
}

export function PlanChat({ s, month, onDone }: { s: State; month: string; onDone: (t: string) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 0, from: 'ai', text: 'シフト作成君です。「山田さんの11/24を休みに」のように話しかけてください。' }]);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs.length]);
  const [busy, setBusy] = useState(false);
  const send = async (q: string) => {
    const t = q.trim(); if (!t || busy) return; setText('');
    const me: Msg = { id: msgs.length, from: 'me', text: t };
    const r = interpretPlan(t, s, month);
    if (!r.unknown) { setMsgs((m) => [...m, me, { id: m.length + 1, from: 'ai', text: r.text, props: r.props, action: r.action }]); return; }
    // ルールで読めない言葉は Gemini に意図を分類してもらい、定型の文に直して同じ提案の流れに乗せる
    setMsgs((m) => [...m, me]); setBusy(true);
    try {
      const i = await askGemini(t, month, s.today);
      // 1つの言葉に複数の操作があれば、それぞれを定型の文に直して、1つの提案にまとめる
      const sentences = [canonical(i), ...(i.extra ?? []).map((o) => canonical({ ...o, night_max: null }))].filter(Boolean) as string[];
      const rs = sentences.map((c) => interpretPlan(c, s, month)).filter((x) => !x.unknown);
      if (!rs.length) { setMsgs((m) => [...m, { id: m.length, from: 'ai', text: i.reply || r.text }]); return; }
      const changes = rs.flatMap((x) => (x.props ?? []).flatMap((p) => p.changes)); const acts = rs.map((x) => x.action).filter(Boolean) as NonNullable<Msg['action']>[];
      const single = rs.length === 1;
      const props: Prop[] | undefined = single ? rs[0].props : changes.length ? [{ label: `${rs.length}件をまとめて反映`, changes }] : undefined;
      const action = single ? rs[0].action : acts.length ? { label: `${acts.length}件をまとめて実行`, run: () => acts.map((a) => a.run()).join('／') } : undefined;
      setMsgs((m) => [...m, { id: m.length, from: 'ai', text: rs.map((x) => x.text).join('\n'), props, action }]);
    } catch (e) {
      setMsgs((m) => [...m, { id: m.length, from: 'ai', text: `${(e as Error).message}\n\n${r.text}` }]);
    } finally { setBusy(false); }
  };
  const apply = (mi: number, pi: number, p: Prop) => { runChanges(p.changes); setMsgs((m) => m.map((x) => (x.id === mi ? { ...x, done: { ...(x.done ?? {}), [pi]: '反映しました' } } : x))); onDone('勤務表を更新しました'); };
  const run = (mi: number, a: NonNullable<Msg['action']>) => { const t = a.run(); setMsgs((m) => m.map((x) => (x.id === mi ? { ...x, action: undefined, text: `${x.text}\n→ ${t}` } : x))); onDone(t); };
  return (
    <aside class="chatdock plandockchat" aria-label="シフト作成君とのチャット">
      <div class="row" style="gap:8px;padding:12px 14px 8px"><Icon n="smart_toy" /><b style="font-weight:500">シフト作成君</b></div>
      <div class="chatdock-body scroll">
        {msgs.map((m) => <div key={m.id} class={`ob ${m.from === 'ai' ? 'l' : 'r'}`}>
          <span class="small">{m.from === 'ai' ? 'シフト作成君' : 'あなた'}</span><div>{m.text}</div>
          {m.props?.map((p, i) => { const after = impactOf(s, s.plan?.draft ?? [], p.changes, month);
            return <div key={i} class="pchg"><ul>{after.map((x) => <li key={x}>{x}</li>)}</ul>
              {m.done?.[i] ? <span class="chip ok">{m.done[i]}</span> : <button class="btn sm pri" onClick={() => apply(m.id, i, p)}>{p.label}（この内容にする）</button>}</div>; })}
          {m.action && <div class="pchg"><button class="btn sm pri" onClick={() => run(m.id, m.action!)}>{m.action.label}</button></div>}
        </div>)}
        <div ref={end} />
      </div>
      {(s.planRequests ?? []).length > 0 && <div class="reqlist"><b style="font-weight:500;font-size:12px">依頼の状況</b>{(s.planRequests ?? []).slice(0, 4).map((r) => <div key={r.id} class="row spread" style="font-size:12px"><span>{staffById(r.staffId).name}さん・{fmtMD(r.date)}・{r.kind === 'work' ? '出勤' : r.kind === 'paid' ? '有休' : '希望休修正'}</span><span class={`chip ${r.status === 'accepted' ? 'ok' : r.status === 'declined' ? 'bad' : 'warn'}`}>{r.status === 'accepted' ? '承諾' : r.status === 'declined' ? '辞退' : '返事待ち'}</span></div>)}</div>}
      <form class="chatdock-in" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input class="input" value={text} placeholder="例：山田さんの11/24を休みに" maxLength={200} onInput={(e) => setText((e.target as HTMLInputElement).value)} aria-label="シフト作成君へのメッセージ" />
        <button class="btn pri" type="submit" disabled={!text.trim() || busy}>{busy ? '考え中…' : '送る'}</button>
      </form>
    </aside>
  );
}
void SHIFT_ORDER;
