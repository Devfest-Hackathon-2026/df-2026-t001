import { useEffect, useRef, useState } from 'preact/hooks';
import { SHIFT_ORDER, STAFF, UNITS, staffById, unitName } from '../core/facility';
import { fmtMD } from '../core/dates';
import { summarizeDay } from '../core/roster';
import { monthStats } from '../core/labor';
import { interpretLeader } from '../core/leaderai';
import { addChatRule, canUndoRule, createPlan, getRuleChange, undoChatRule, planAssign, remindUnsubmitted, sendPlanRequest } from '../core/store';
import { cellsOf, displayLabel, isRuleLike, translateRule } from '../core/chatRules';
import type { RuleCand } from '../core/chatRules';
import { PAID_TARGET, paidCount } from '../core/paidleave';
import { daysInRange } from '../core/dates';
import { monthEnd, prevHistoryOf } from '../core/planner';
import type { State } from '../core/store';
import type { Assignment, ShiftCode } from '../core/types';
import { Icon } from '../shared/ui';
import { askGemini, canonical } from './planIntent';

/** シフト作成画面の右パネル：シフト作成君に話して、勤務表の修正案を出してもらう（承認してから反映） */
interface Change { date: string; shift: ShiftCode; unitId: string; staffId: string | null }
interface Prop { label: string; changes: Change[] }
interface Msg { id: number; from: 'me' | 'ai'; text: string; props?: Prop[]; done?: Record<number, string>; action?: { label: string; run: () => string }; rules?: { cands: RuleCand[]; added?: number } }

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
  const prev = prevHistoryOf(s.assignments, month, 7);
  const beforeAll = prev.length ? [...prev, ...draft] : draft;
  const after = applyChanges(draft, cs);
  const afterAll = prev.length ? [...prev, ...after] : after;
  const out: string[] = [];
  for (const date of new Set(cs.map((c) => c.date))) {
    const b = summarizeDay(beforeAll, date, s.events), a = summarizeDay(afterAll, date, s.events);
    if (a.vacant !== b.vacant) out.push(`${fmtMD(date)} 欠員 ${b.vacant}→${a.vacant}`);
    if (a.issues.length !== b.issues.length) out.push(`${fmtMD(date)} 不足 ${b.issues.length}→${a.issues.length}か所`);
  }
  const ids = new Set(cs.map((c) => c.staffId).filter(Boolean) as string[]);
  const bw = monthStats(beforeAll, `${month}-01`), aw = monthStats(afterAll, `${month}-01`);
  for (const id of ids) {
    const before = bw.find((x) => x.staffId === id)?.warnings.map((w) => w.text) ?? [];
    for (const w of aw.find((x) => x.staffId === id)?.warnings ?? []) if (!before.includes(w.text)) out.push(`労務 ${staffById(id).name}さん：${w.text}`);
  }
  return out.length ? out : ['不足・労務の問題は増えません'];
}

export function interpretPlan(raw: string, s: State, month: string): { text: string; props?: Prop[]; action?: Msg['action']; unknown?: boolean } {
  const t = raw.replace(/\s+/g, '');
  const plan = s.plan && s.plan.month === month ? s.plan : undefined;
  const date = dateIn(t, month); const sh = shiftIn(t); const people = staffIn(t);
  const unit = UNITS.find((u) => t.includes(u.name));
  const slotOf = (id: string, d: string) => plan?.draft.find((a) => a.staffId === id && a.date === d && a.status !== 'absent');
  if (/(夜勤).*(減ら|少なく|抑え)|(シフト).*(作|つく|組)|作り直/.test(t)) {
    const nm = /(夜勤).*(減ら|少なく|抑え)/.test(t) ? 6 : undefined;
    return { text: `${+month.slice(5)}月を${plan ? '作り直します' : '作ります'}${nm ? '（夜勤 月6回まで）' : ''}。${plan ? '今の案は置き換わります。' : ''}`, action: { label: plan ? '作り直す' : '作る', run: () => { createPlan(month, nm ? { nightMax: nm } : {}); return 'シフト案を作りました'; } } };
  }
  if (/催促|リマインド|未提出/.test(t)) { const n = Object.values(s.collection.submitted).filter((v) => !v).length; return { text: n ? `未提出は${n}名です。` : '未提出の人はいません。', action: n ? { label: `${n}名に催促`, run: () => `未提出の${remindUnsubmitted()}名に催促を送りました` } : undefined }; }
  // 依頼（出勤・有休の打診・希望休の修正）
  const freeDay = (id: string, k = 0) => { const l = daysInRange(`${month}-01`, monthEnd(month)).filter((d) => d >= s.today && !plan?.draft.some((a) => a.staffId === id && a.date === d && a.status !== 'absent') && !(s.paidLeave?.[id] ?? []).includes(d) && new Date(d + 'T00:00:00').getDay() !== 0 && new Date(d + 'T00:00:00').getDay() !== 6); return l.length ? l[(k * 3) % l.length] : undefined; };
  if (/(有休|有給)/.test(t) && /(足りない|不足|取れて|未取得|届いて|少ない)/.test(t)) {
    const lack = STAFF.filter((x) => x.shifts.length && !x.isLeader && paidCount(s, x.id) < PAID_TARGET).map((x, i) => ({ x, d: freeDay(x.id, i) })).filter((r) => r.d);
    if (!lack.length) return { text: '有休が年5日に届いていない人はいません。' };
    return { text: `有休 年${PAID_TARGET}日未満：${lack.length}名。勤務のない平日で打診します。\n${lack.slice(0, 6).map((r) => `・${r.x.name}さん ${fmtMD(r.d!)}（あと${PAID_TARGET - paidCount(s, r.x.id)}日）`).join('\n')}${lack.length > 6 ? `\n ほか${lack.length - 6}名` : ''}`, action: { label: `${lack.length}名に打診`, run: () => { lack.forEach((r) => sendPlanRequest('paid', r.x.id, r.d!)); return `${lack.length}名に有休を打診しました`; } } };
  }
  if (people.length && /(依頼|お願い|打診|頼)/.test(t)) {
    const st = people[0];
    if (/(有休|有給)/.test(t)) { const d = date ?? freeDay(st.id); if (!d) return { text: `${st.name}さんに打診できる日がありません。` };
      return { text: `${st.name}さん ${fmtMD(d)} 有休（今年度 ${paidCount(s, st.id)}/${PAID_TARGET}日）`, action: { label: '打診する', run: () => { sendPlanRequest('paid', st.id, d); return `${st.name}さんに有休を打診しました`; } } }; }
    if (/(希望休|休み)/.test(t) && /(修正|見直|変更|取り下げ|外し)/.test(t) && date) return { text: `${st.name}さん ${fmtMD(date)} 希望休の見直し`, action: { label: '依頼する', run: () => { sendPlanRequest('dayoff', st.id, date); return `${st.name}さんに依頼しました`; } } };
    if (date && /(出勤|入って|入れて|勤務|シフト)/.test(t)) { const shf = sh ?? '日勤'; const u = unit?.id ?? st.homeUnit;
      return { text: `${st.name}さん ${fmtMD(date)} ${shf}（${unitName(u)}）の出勤。承諾されると表に入ります。`, action: { label: '依頼する', run: () => { sendPlanRequest('work', st.id, date, { shift: shf, unitId: u }); return `${st.name}さんに出勤を依頼しました`; } } }; }
  }
  if (!plan) return { text: 'まだ案がありません。「シフトを作って」と送ってください。' };
  if (plan.status === 'published') return { text: '公開済みです。変更は月間・1日の画面から。' };
  if (/(入れ替え|交代|替わ|代わ)/.test(t) && people.length >= 2 && date) {
    const [p, q] = people; const sp = slotOf(p.id, date), sq = slotOf(q.id, date);
    if (!sp && !sq) return { text: `${fmtMD(date)}は2人とも勤務がありません。` };
    const cs: Change[] = [];
    if (sp) cs.push({ date, shift: sp.shift, unitId: sp.unitId, staffId: q.id });
    if (sq) cs.push({ date, shift: sq.shift, unitId: sq.unitId, staffId: p.id });
    return { text: `${fmtMD(date)} ${p.name}さん⇄${q.name}さん`, props: [{ label: '入れ替える', changes: cs }] };
  }
  if (/(休み|休ま|外し|抜い|入れない|なし)/.test(t) && people.length && date) {
    const st = people[0]; const cur = slotOf(st.id, date);
    if (!cur) return { text: `${st.name}さんは${fmtMD(date)}に勤務がありません。` };
    return { text: `${st.name}さん ${fmtMD(date)} ${cur.shift}（${unitName(cur.unitId)}）→ 休み。枠は空きになります。`, props: [{ label: '休みにする', changes: [{ date, shift: cur.shift, unitId: cur.unitId, staffId: null }] }] };
  }
  if (/誰|候補|空い|入れる人/.test(t) && date && sh) {
    const free = UNITS.filter((u) => !unit || u.id === unit.id).filter((u) => !plan.draft.some((a) => a.date === date && a.shift === sh && a.unitId === u.id && a.status !== 'absent'));
    const target = free[0] ?? unit ?? UNITS[0];
    const busy = new Set(plan.draft.filter((a) => a.date === date && a.status !== 'absent').map((a) => a.staffId));
    const cands = STAFF.filter((x) => x.shifts.length && !x.isLeader && x.shifts.includes(sh) && !busy.has(x.id))
      .map((x) => ({ x, avail: !!s.availability[x.id]?.some((v) => v.date === date && (!v.shifts.length || v.shifts.includes(sh))) })).sort((a, b) => Number(b.avail) - Number(a.avail)).slice(0, 3);
    if (!cands.length) return { text: `${fmtMD(date)} ${sh}に入れる人がいません。` };
    const why = (x: (typeof STAFF)[number], avail: boolean) => [avail && '入れる日あり', x.homeUnit !== target.id && '応援', x.skills.includes('medical') && '医療的ケア可', plan.draft.filter((a) => a.staffId === x.id && a.status !== 'absent').length < 14 && '勤務少なめ'].filter(Boolean).join('・');
    return { text: `${fmtMD(date)} ${sh}（${target.name}）の候補${free.length ? '' : '（埋まっているので、今の担当は外れます）'}\n${cands.map((c) => `・${c.x.name}さん ${why(c.x, c.avail) || ''}`).join('\n')}`, props: cands.map((c) => ({ label: `${c.x.name}さん`, changes: [{ date, shift: sh, unitId: target.id, staffId: c.x.id }] })) };
  }
  if (people.length && date && sh) {
    const st = people[0]; const cur = slotOf(st.id, date);
    const u = unit?.id ?? (cur?.unitId ?? st.homeUnit);
    return { text: `${st.name}さん ${fmtMD(date)} → ${sh}（${unitName(u)}${u !== st.homeUnit ? '・応援' : ''}）`, props: [{ label: '入れる', changes: [...(cur && (cur.shift !== sh || cur.unitId !== u) ? [{ date, shift: cur.shift, unitId: cur.unitId, staffId: null } as Change] : []), { date, shift: sh, unitId: u, staffId: st.id }] }] };
  }
  const base = interpretLeader(raw, s);
  if (base.action && base.action.kind === 'publishPlan') return { text: '公開は上の「公開する」から。' };
  return { unknown: true, text: 'たとえば：\n・「山田さんの11/24を休みに」\n・「佐藤さんを11/25の夜勤にひなたで入れて」\n・「11/24の日勤に誰が入れる？」\n・「山田さんと佐藤さんを11/24で入れ替えて」\n・「夜勤を減らして作り直して」\n・「山田さんに11/24の日勤を依頼して」\n・「山田さんに有休を打診して」\n・「有休が足りない人に打診して」\n・「月1回は土日とも休みにして」（決まりを足す）' };
}

export function PlanChat({ s, month, onDone }: { s: State; month: string; onDone: (t: string) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([{ id: 0, from: 'ai', text: '「山田さんの11/24を休みに」のように送ってください。' }]);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs.length]);
  const [busy, setBusy] = useState(false);
  /** 決まりの言葉をルールの候補にする（translate-inline）。候補を出すだけで、何も変えない */
  const askRule = async (t: string) => {
    const plan = s.plan && s.plan.month === month ? s.plan : undefined;
    const nDays = daysInRange(`${month}-01`, monthEnd(month)).length;
    try {
      const res = await translateRule(t, month, plan ? cellsOf(plan.draft, month, nDays) : undefined);
      if (res.kind === 'candidates' && res.candidates.length) {
        setMsgs((m) => [...m, { id: m.length, from: 'ai', text: 'ルールにできます。どれにしますか？', rules: { cands: res.candidates.slice(0, 4) } }]);
      } else if (res.kind === 'ask') {
        setMsgs((m) => [...m, { id: m.length, from: 'ai', text: res.message }]);
      } else if (res.kind === 'setting') {
        setMsgs((m) => [...m, { id: m.length, from: 'ai', text: `${res.message}\nこれは設定で変えてください。` }]);
      } else {
        setMsgs((m) => [...m, { id: m.length, from: 'ai', text: 'この決まりはルールにできません。' }]);
      }
    } catch (e) {
      setMsgs((m) => [...m, { id: m.length, from: 'ai', text: (e as Error).message }]);
    }
  };
  const send = async (q: string) => {
    const t = q.trim(); if (!t || busy) return; setText('');
    const me: Msg = { id: msgs.length, from: 'me', text: t };
    const flat = t.replace(/\s+/g, '');
    if (isRuleLike(flat, !!(staffIn(flat).length && dateIn(flat, month)))) {
      setMsgs((m) => [...m, me]); setBusy(true);
      try { await askRule(t); } finally { setBusy(false); }
      return;
    }
    const r = interpretPlan(t, s, month);
    if (!r.unknown) { setMsgs((m) => [...m, me, { id: m.length + 1, from: 'ai', text: r.text, props: r.props, action: r.action }]); return; }
    // ルールで読めない言葉は Gemini に意図を分類してもらい、定型の文に直して同じ提案の流れに乗せる
    setMsgs((m) => [...m, me]); setBusy(true);
    try {
      const i = await askGemini(t, month, s.today);
      if (i.intent === 'add_rule') { await askRule(t); return; }
      // 1つの言葉に複数の操作があれば、それぞれを定型の文に直して、1つの提案にまとめる
      const sentences = [canonical(i), ...(i.extra ?? []).map((o) => canonical({ ...o, night_max: null }))].filter(Boolean) as string[];
      const rs = sentences.map((c) => interpretPlan(c, s, month)).filter((x) => !x.unknown);
      if (!rs.length) { setMsgs((m) => [...m, { id: m.length, from: 'ai', text: i.reply || r.text }]); return; }
      const changes = rs.flatMap((x) => (x.props ?? []).flatMap((p) => p.changes)); const acts = rs.map((x) => x.action).filter(Boolean) as NonNullable<Msg['action']>[];
      const single = rs.length === 1;
      const props: Prop[] | undefined = single ? rs[0].props : changes.length ? [{ label: `${rs.length}件まとめて反映`, changes }] : undefined;
      const action = single ? rs[0].action : acts.length ? { label: `${acts.length}件まとめて実行`, run: () => acts.map((a) => a.run()).join('／') } : undefined;
      setMsgs((m) => [...m, { id: m.length, from: 'ai', text: rs.map((x) => x.text).join('\n'), props, action }]);
    } catch (e) {
      setMsgs((m) => [...m, { id: m.length, from: 'ai', text: `${(e as Error).message}\n\n${r.text}` }]);
    } finally { setBusy(false); }
  };
  const apply = (mi: number, pi: number, p: Prop) => { runChanges(p.changes); setMsgs((m) => m.map((x) => (x.id === mi ? { ...x, done: { ...(x.done ?? {}), [pi]: '反映済み' } } : x))); onDone('反映して、変えたマスを固定しました'); };
  const addRule = (mi: number, ci: number, c: RuleCand) => { const t = addChatRule(c, month); setMsgs((m) => m.map((x) => (x.id === mi && x.rules ? { ...x, rules: { ...x.rules, added: ci } } : x))); onDone(t); };
  const run = (mi: number, a: NonNullable<Msg['action']>) => { const t = a.run(); setMsgs((m) => m.map((x) => (x.id === mi ? { ...x, action: undefined, text: `${x.text}\n→ ${t}` } : x))); onDone(t); };
  return (
    <aside class="chatdock plandockchat" aria-label="シフト作成君とのチャット">
      <div class="row" style="gap:8px;padding:12px 14px 8px"><b style="font-weight:500">シフト作成君</b><span class="small">話して直す</span></div>
      <div class="chatdock-body scroll">
        {msgs.map((m) => <div key={m.id} class={`ob ${m.from === 'ai' ? 'l' : 'r'}`}>
          <span class="small">{m.from === 'ai' ? 'シフト作成君' : 'あなた'}</span><div>{m.text}</div>
          {m.props?.map((p, i) => { const after = impactOf(s, s.plan?.draft ?? [], p.changes, month);
            return <div key={i} class="pchg"><ul>{after.map((x) => <li key={x}>{x}</li>)}</ul>
              {m.done?.[i] ? <span class="chip ok">{m.done[i]}</span> : <button class="btn sm pri" onClick={() => apply(m.id, i, p)}>{p.label}</button>}</div>; })}
          {m.rules && <div class="pchg rulecands">{m.rules.cands.map((c, ci) => <div key={ci} class={`rulecand${m.rules!.added === ci ? ' on' : ''}`}>
            <div class="rc-l"><b>{displayLabel(c.label)}</b>{c.strength !== '絶対' && <span class="small">（{c.strength === '強く' ? 'できるだけ' : 'できれば'}）</span>}</div>
            <span class="small rc-n">{c.impact ? (c.impact.broken_now ? `今${c.impact.broken_now}か所` : '今は守れている') : ''}</span>
            {m.rules!.added === ci ? <span class="chip ok">足した</span> : m.rules!.added === undefined && <button class="btn sm" aria-label="このルールを足す" onClick={() => addRule(m.id, ci, c)}>足す</button>}
          </div>)}
            {m.rules.added === undefined && s.plan?.month === month && s.plan.status !== 'published' && <p class="small rc-foot">足すと、変更が少なくなるように作り直します</p>}
            {m.rules.added !== undefined && <RuleResult month={month} onDone={onDone} />}
          </div>}
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

/** ルールを足したあとの結果（作り直し中／変わった件数）と元に戻す */
function RuleResult({ month, onDone }: { month: string; onDone: (t: string) => void }) {
  const c = getRuleChange();
  if (!c || c.month !== month) return null;
  return <p class="small rc-foot">
    {c.state === 'solving' ? '作り直し中…' : c.state === 'done' ? (c.count ? `作り直しました。変更${c.count}件` : '作り直しました。変更はありません') : c.message ?? '足しました'}
    {canUndoRule() && c.state !== 'solving' && <> <button class="link" onClick={() => onDone(undoChatRule())}>元に戻す</button></>}
  </p>;
}
