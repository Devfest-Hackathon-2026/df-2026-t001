import { useEffect, useState } from 'preact/hooks';
import type { Applicant, Assignment, AutopilotSettings, AutoState, ChatMessage, HealthCheck, Notice, ShiftCode, ShiftRequest, RequestKind, Vacancy, AiProposal } from './types';
import { DEMO_TODAY, LEADER_ID, MY_ID, STAFF, staffById, unitName, SKILLS } from './facility';
import { applyAdjust, availFor, buildDay, canWork, coverage, generateBaseRoster, initialVacancies, needSkillsFor, proposeAdjustments, rankCandidates, requiredSkills, vacancyId } from './roster';
import type { Availability } from './roster';
import { planMonth, finalize, computeSpares, monthEnd } from './planner';
import type { Plan } from './planner';
import { solveMonth, solverEnabled, solverNote } from './solverPlan';
import { SEED_EVENTS } from './events';
import type { FacilityEvent } from './events';
import { interpretLeader } from './leaderai';
import { askEmployee, askLeader, employeeSentence, leaderSentence } from './aiintent';
import { applyKind, proposeFromText } from './shiftmaker';
import { addDays, addMinutes, fmtMD, nowStamp, setSimNow, stampDay, stampMin, stampTime, toMin } from './dates';
import { rankViaApi, reorderByAi } from './apirank';
import type { AiRank } from './apirank';

export interface Prefs { breakPref?: string; leaveBy?: string; leaveReason?: string; shiftHope: ShiftCode[]; history: { at: string; text: string }[]; }
export interface Settings { push: boolean; mail: boolean; quietNight: boolean; textSize: 'standard' | 'large'; }
export type { AutopilotSettings };
export interface State {
  v: number; today: string; now: string; autopilot: AutopilotSettings;
  assignments: Assignment[]; vacancies: Vacancy[]; requests: ShiftRequest[];
  messages: ChatMessage[]; notices: Notice[]; health: HealthCheck[];
  prefs: Record<string, Prefs>; settings: Record<string, Settings>;
  collection: Collection; availability: Availability;
  plan?: Plan; events: FacilityEvent[]; spareUse: Record<string, number>;
  paidLeave?: Record<string, string[]>; planRequests?: PlanReq[];
}
export type PlanReqKind = 'work' | 'dayoff' | 'paid';
export interface PlanReq { id: string; kind: PlanReqKind; staffId: string; date: string; shift?: ShiftCode; unitId?: string; status: 'pending' | 'accepted' | 'declined'; at: string; note?: string }
export interface Collection { month: string; deadline: string; submitted: Record<string, { at: string; dates: string[] } | null>; remindedAt?: string; remindedN?: number; }
const KEY = 'kana-care-state-v8';
const VERSION = 8;
let seq = 1000;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function seed(): State {
  const assignments = generateBaseRoster();
  const prefs: Record<string, Prefs> = {};
  for (const s of STAFF) prefs[s.id] = { breakPref: s.breakPref, leaveBy: s.leaveBy, leaveReason: s.leaveReason, shiftHope: s.skills.includes('night') && s.id.endsWith('7') ? ['夜勤'] : [], history: [] };
  for (const id of ['EMP-005', 'EMP-011', 'EMP-019', 'EMP-023', 'EMP-026', 'EMP-029']) prefs[id].shiftHope = ['夜勤'];
  prefs['EMP-017'].shiftHope = ['夜勤'];
  const settings: Record<string, Settings> = {};
  for (const s of STAFF) settings[s.id] = { push: true, mail: false, quietNight: s.id === MY_ID, textSize: 'standard' };
  settings.leader = { push: true, mail: true, quietNight: false, textSize: 'standard' };
  const t = (h: string) => `${DEMO_TODAY} ${h}`;
  const messages: ChatMessage[] = [
    { id: 'M1', thread: 'all', from: LEADER_ID, text: '11/23（月・祝）は祝日運用のため入浴は午前のみです。詳細はシフト画面で確認してください。', at: t('08:30') },
    { id: 'M2', thread: 'all', from: LEADER_ID, text: '今月の避難訓練は11/27（金）14:00です。日勤・遅番は参加をお願いします。', at: t('09:10') },
    { id: 'M3', thread: 'shift:夜勤', from: 'EMP-005', text: '2階の昨夜の様子です。つぼみ 205号室は夜間の不穏が少し続いています。', at: t('09:40') },
    { id: 'M4', thread: 'shift:夜勤', from: 'EMP-011', text: 'ありがとうございます。今夜の巡回は2時間ごとで見ておきます。', at: t('09:52') },
    { id: 'M5', thread: 'unit:U3', from: 'EMP-025', text: 'あかり 301号室の福田さん、昼食前に血圧を確認してほしいとのことです。', at: t('10:20') },
    { id: 'M6', thread: 'leader', from: LEADER_ID, text: '美咲さん、来月の夜勤の希望があれば「シフト作成君」に送っておいてください。', at: t('11:00') },
  ];
  const notices: Notice[] = [
    { id: 'N1', to: MY_ID, title: 'リーダーからのお知らせ', body: '11/23（月・祝）は祝日運用です。入浴は午前のみ。', at: t('08:30'), read: false, kind: 'info' },
    { id: 'N2', to: MY_ID, title: '今夜は夜勤です', body: 'あかり（2階）担当、16:30出勤。出勤前の体調チェックをお願いします。', at: t('07:00'), read: false, kind: 'shift', link: 'health' },
    { id: 'N3', to: 'leader', title: '出勤前チェック：未入力が多数', body: '今夜の夜勤4名のうち、体調チェック済みは0名です。', at: t('12:00'), read: false, kind: 'health' },
    { id: 'N4', to: 'leader', title: '欠員が3件あります', body: '11/22 遅番（つぼみ）・11/25 夜勤（ひなた）・11/27 早番（そよかぜ）', at: t('07:30'), read: false, kind: 'shift' },
  ];
  // 動画の台本に合わせた固定データ：加藤さんが11/20の夜勤に入れるよう、前後の勤務を整える
  assignments.forEach((a, i) => { if (a.staffId === 'EMP-009' && a.date === '2026-11-21' && a.shift === '早番') assignments[i] = { ...a, staffId: 'EMP-018' }; });
  const pick = (date: string, shift: ShiftCode) => assignments.find((a) => a.date === date && a.shift === shift && a.staffId !== MY_ID)!;
  const a1 = pick('2026-11-24', '日勤'); const a2 = pick('2026-11-19', '日勤');
  const requests: ShiftRequest[] = [
    { id: 'R1', staffId: a1.staffId, date: a1.date, kind: '希望休', reason: '私用', status: 'pending', via: 'form', createdAt: t('09:00'), impact: `日勤（${unitName(a1.unitId)}）に欠員1名が発生します。` },
    { id: 'R2', staffId: a2.staffId, date: a2.date, kind: '遅刻', detail: '30分遅れ', reason: '通院', status: 'pending', via: 'ai', createdAt: t('10:15'), impact: '対応人数への影響を確認中。' },
  ];
  const health: HealthCheck[] = [
    { id: 'H1', staffId: 'EMP-005', date: DEMO_TODAY, at: t('06:50'), temp: 36.4, symptoms: [], household: '症状なし', sleep: '十分', consult: false },
    { id: 'H2', staffId: 'EMP-011', date: DEMO_TODAY, at: t('07:10'), temp: 37.2, symptoms: ['咳'], household: '症状なし', sleep: 'やや不足', note: '咳が少し出ます', consult: true },
    { id: 'H3', staffId: 'EMP-025', date: DEMO_TODAY, at: t('08:05'), temp: 36.5, symptoms: [], household: '症状なし', sleep: '十分', consult: false },
  ];
  const submitted: Collection['submitted'] = {};
  STAFF.filter((x) => x.id !== 'EMP-900' && x.id !== LEADER_ID).forEach((x, i) => { submitted[x.id] = x.id === MY_ID || i % 5 === 1 || i % 5 === 3 ? null : { at: t('09:00'), dates: i % 2 ? ['2026-12-12', '2026-12-13'] : ['2026-12-24'] }; });
  const availability: Availability = {};
  const hsh = (x: string) => { let h = 7; for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0; return h; };
  for (let d = addDays(DEMO_TODAY, 1); d <= addDays(DEMO_TODAY, 40); d = addDays(d, 1)) {
    for (const x of STAFF) {
      if (!x.shifts.length || x.isLeader || x.id === MY_ID || assignments.some((a) => a.staffId === x.id && a.date === d)) continue;
      if (hsh(x.id + d) % 5 !== 0) continue;
      const sh = x.shifts.filter((k) => canWork(x, k)); if (!sh.length) continue;
      (availability[x.id] ??= []).push({ date: d, shifts: [sh[hsh(d + x.id) % sh.length]] });
    }
  }
  // デモで見やすいよう、欠員の日に「入れる日」を出していた人を用意する
  const pin = (id: string, d: string, k: ShiftCode) => { (availability[id] ??= []).push({ date: d, shifts: [k] }); };
  pin('EMP-026', '2026-11-20', '夜勤'); pin('EMP-009', '2026-11-20', '夜勤'); pin('EMP-019', '2026-11-20', '夜勤'); pin('EMP-004', '2026-11-24', '日勤'); pin('EMP-012', '2026-11-22', '遅番');
  return { v: VERSION, today: DEMO_TODAY, now: `${DEMO_TODAY} 14:00`, autopilot: { enabled: true, maxCandidates: 5, waitSameDay: 30, waitOther: 120, quietStart: '22:00', quietEnd: '07:00', defaultReward: '時給2,200円（単発）', useAdjust: true, autoPost: true, adjustKinds: { break: true, support: true, extend: true }, priority: { availFirst: true, skill: 'normal', days: 'normal' }, jobNote: 'ユニット型の少人数ケア。仮眠・休憩は交代で確実に取れます。' }, assignments, vacancies: initialVacancies(assignments).map((v) => (v.date === '2026-11-25' && v.shift === '夜勤' ? { ...v, opts: { maxCandidates: 1 } } : v)), /* 動画用：この欠員は内部の候補を1人だけにして求人へ進める */ requests, messages, notices, health, prefs, settings, collection: { month: '2026-12', deadline: '2026-11-25', submitted }, availability, events: SEED_EVENTS, spareUse: {} };
}

let state: State = load();
setSimNow(state.now);
function load(): State {
  try { const raw = localStorage.getItem(KEY); if (raw) { const s = JSON.parse(raw) as State; if (s.v === VERSION) return s; } } catch { /* ignore */ }
  return seed();
}
const subs = new Set<() => void>();
function persist(s: State): State {
  try { localStorage.setItem(KEY, JSON.stringify(s)); return s; } catch { /* 容量超過：古い写真から削除して再試行 */ }
  const msgs = [...s.messages];
  for (let i = 0; i < msgs.length; i++) {
    if (!msgs[i].attachments?.length) continue;
    msgs[i] = { ...msgs[i], attachments: undefined, text: `${msgs[i].text} （古い写真は端末の容量のため削除されました）`.trim() };
    const t = { ...s, messages: msgs };
    try { localStorage.setItem(KEY, JSON.stringify(t)); return t; } catch { /* 次へ */ }
  }
  return s;
}
function commit(next: State) { const n = { ...next, now: addMinutes(next.now, 1) }; setSimNow(n.now); state = persist(n); subs.forEach((f) => f()); }
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY && e.newValue) { try { state = JSON.parse(e.newValue); setSimNow(state.now); subs.forEach((f) => f()); } catch { /* ignore */ } } });

export const getState = () => state;
export function useStore(): State { const [, f] = useState(0); useEffect(() => { const fn = () => f((n) => n + 1); subs.add(fn); return () => { subs.delete(fn); }; }, []); return state; }
export const resetDemo = () => commit(seed());

const notice = (n: Omit<Notice, 'id' | 'at' | 'read'>): Notice => ({ ...n, id: uid('N'), at: nowStamp(), read: false });
const set = (fn: (s: State) => Partial<State>) => commit({ ...state, ...fn(state) });
const patchVacancy = (id: string, fn: (v: Vacancy) => Vacancy) => set((s) => ({ vacancies: s.vacancies.map((v) => (v.id === id ? fn(v) : v)) }));
const syncVacancyFor = (s: State, a: Assignment): Vacancy[] => {
  const id = vacancyId(a.date, a.shift, a.unitId);
  if (s.vacancies.some((v) => v.id === id && v.state !== 'filled')) return s.vacancies;
  const v: Vacancy = { id, date: a.date, shift: a.shift, unitId: a.unitId, needSkills: needSkillsFor(s.assignments.map((x) => (x.id === a.id ? a : x)), a.date, a.shift, a.unitId), reason: `${staffById(a.staffId).name}さんの休み`, state: 'open', offers: [], fromAssignmentId: a.id, kind: 'absence' };
  return [...s.vacancies.filter((x) => x.id !== id), v];
};

// ---- 休み・遅刻・早退・変更の申請 ----
export function applyRequestToRoster(s: State, r: ShiftRequest): Pick<State, 'assignments' | 'vacancies'> {
  const a = s.assignments.find((x) => x.staffId === r.staffId && x.date === r.date && x.status !== 'absent');
  if (!a) return { assignments: s.assignments, vacancies: s.vacancies };
  const na = applyKind(a, r.kind, r.detail);
  const assignments = s.assignments.map((x) => (x.id === a.id ? na : x));
  const next = { ...s, assignments };
  let vacancies = na.status === 'absent' ? syncVacancyFor(next, na) : s.vacancies;
  if (na.status === 'late' || na.status === 'early') {
    const days = a.shift === '夜勤' ? [r.date, addDays(r.date, 1)] : [r.date]; const before = days.flatMap((d) => coverage(buildDay(s.assignments, d))).length; const after = days.flatMap((d) => coverage(buildDay(assignments, d)));
    if (after.length > before) {
      const id = `${vacancyId(a.date, a.shift, a.unitId)}-G`;
      vacancies = [...vacancies.filter((v) => v.id !== id), { id, date: a.date, shift: a.shift, unitId: a.unitId, needSkills: [], reason: `${staffById(a.staffId).name}さんの${na.status === 'late' ? '遅刻' : '早退'}で手薄になる時間があります（${after[0].text}）`, state: 'open', offers: [], fromAssignmentId: a.id, kind: 'gap' }];
    }
  }
  return { assignments, vacancies };
}
export function submitRequest(staffId: string, date: string, kind: RequestKind, reason: string, detail: string | undefined, via: ShiftRequest['via'] = 'form') {
  const r: ShiftRequest = { id: uid('R'), staffId, date, kind, reason, detail, status: 'pending', via, createdAt: nowStamp() };
  set((s) => ({
    requests: [r, ...s.requests],
    notices: [notice({ to: 'leader', kind: 'request', title: `${staffById(staffId).name}さんから${kind}の相談`, body: `${fmtMD(date)}${detail ? ` ${detail}` : ''}${reason ? `／${reason}` : ''}`, link: 'requests' }), ...s.notices],
    messages: [...s.messages, { id: uid('M'), thread: 'leader', from: staffId, text: `【${kind}の相談】${fmtMD(date)}${detail ? ` ${detail}` : ''}${reason ? `（${reason}）` : ''}`, at: nowStamp() }],
  }));
}
/** 申請の承認。withAutopilot=true なら、承認と同時に「代わりを自動で探す」も承認する（1タップで完了） */
export function decideRequest(id: string, ok: boolean, withAutopilot = false) {
  set((s) => {
    const r = s.requests.find((x) => x.id === id); if (!r || r.status !== 'pending') return {};
    const nr: ShiftRequest = { ...r, status: ok ? 'approved' : 'rejected' };
    const roster = ok ? applyRequestToRoster(s, r) : { assignments: s.assignments, vacancies: s.vacancies };
    return { ...roster, requests: s.requests.map((x) => (x.id === id ? nr : x)), notices: [notice({ to: r.staffId, kind: 'request', title: `${r.kind}の相談を${ok ? '承認' : '見送り'}しました`, body: `${fmtMD(r.date)}${ok ? '：シフトに反映しました。お大事にしてください。' : '：詳細はリーダーに確認してください。'}` }), ...s.notices] };
  });
  kickoffAutopilot();
  if (ok && withAutopilot) {
    const r = state.requests.find((x) => x.id === id);
    const a = r && state.assignments.find((x) => x.staffId === r.staffId && x.date === r.date && x.status !== 'assigned');
    const v = a && state.vacancies.find((x) => x.fromAssignmentId === a.id && x.auto?.mode === 'ask');
    if (v) void delegateAutopilot(v.id);
  }
}

// ---- チャット / シフト作成君 ----
export function sendMessage(thread: string, from: string, text: string, attachments?: ChatMessage['attachments']) {
  if (!text.trim() && !attachments?.length) return;
  set((s) => ({ messages: [...s.messages, { id: uid('M'), thread, from, text: text.trim(), at: nowStamp(), attachments }], notices: thread === 'leader' && from !== LEADER_ID ? [notice({ to: 'leader', kind: 'info', title: `${staffById(from)?.name ?? from}さんからメッセージ`, body: text.trim().slice(0, 60), link: 'chat' }), ...s.notices] : s.notices }));
}
/** 打診が届いている人の自由記述の返事（「入れます」「難しいです」）を、打診への返答として扱う */
function replyToPendingOffer(staffId: string, text: string): boolean {
  const v = state.vacancies.find((x) => x.state !== 'filled' && x.offers.some((o) => o.staffId === staffId && o.status === 'pending')); if (!v) return false;
  const yes = /入れ(る|ます)|はい|お願い(します)?/.test(text); const no = /難しい|無理|見送|断/.test(text);
  if (yes === no) return false;
  set((s) => ({ messages: [...s.messages, { id: uid('M'), thread: `ai:${staffId}`, from: staffId, text: text.trim(), at: nowStamp() }] }));
  respondOffer(v.id, staffId, yes); return true;
}
export function askShiftMaker(staffId: string, text: string) {
  if (!text.trim()) return;
  if (replyToPendingOffer(staffId, text)) return;
  const known = proposeFromText(text, staffId, state.today, state.assignments, state.collection.month);
  const unknown = known.items.every((i) => i.type === 'unknown');
  const aid = uid('M');
  set((s) => {
    const u: ChatMessage = { id: uid('M'), thread: `ai:${staffId}`, from: staffId, text: text.trim(), at: nowStamp() };
    const a: ChatMessage = unknown ? { id: aid, thread: `ai:${staffId}`, from: 'ai', text: '内容を確認しています…', at: nowStamp() } : { id: aid, thread: `ai:${staffId}`, from: 'ai', text: known.summary, at: nowStamp(), proposal: known };
    return { messages: [...s.messages, u, a] };
  });
  if (!unknown) return;
  // ルールで読めない言葉は Gemini に分類してもらい、定型の文に直して同じ提案の流れに乗せる
  const patch = (fn: (m: ChatMessage) => ChatMessage) => set((s) => ({ messages: s.messages.map((m) => (m.id === aid ? fn(m) : m)) }));
  askEmployee(text.trim(), state.today).then((i) => {
    const c = employeeSentence(i); const p = c ? proposeFromText(c, staffId, state.today, state.assignments, state.collection.month) : null;
    if (p && !p.items.every((x) => x.type === 'unknown')) patch((m) => ({ ...m, text: p.summary, proposal: { ...p, raw: text.trim() } }));
    else patch((m) => ({ ...m, text: i.reply || known.summary, proposal: known }));
  }).catch((e: Error) => patch((m) => ({ ...m, text: `${e.message}\n日付と内容を入れて、もう一度送ってください（例：「11/20の夜勤を休みたい」）。`, proposal: known })));
}
export function confirmProposal(msgId: string, staffId: string) {
  set((s) => {
    const m = s.messages.find((x) => x.id === msgId); if (!m?.proposal || m.proposal.state !== 'draft') return {};
    let cur: State = s; const notices: Notice[] = []; let anyReview = false;
    const undo: NonNullable<AiProposal['undo']> = { assignments: [], addedVacancyIds: [], requestIds: [] };
    const items = m.proposal.items.map((it) => ({ ...it }));
    for (const it of items) {
      if (it.type === 'prefs' && it.prefs) {
        const p = cur.prefs[staffId]; undo.prefs = { breakPref: p.breakPref, leaveBy: p.leaveBy, leaveReason: p.leaveReason, shiftHope: p.shiftHope };
        const np: Prefs = { ...p, ...Object.fromEntries(Object.entries(it.prefs).filter(([k]) => k !== 'shiftHope')), shiftHope: it.prefs.shiftHope ? Array.from(new Set([...p.shiftHope, ...it.prefs.shiftHope])) : p.shiftHope, history: [{ at: nowStamp(), text: `${it.normalized}（シフト作成君・原文：${m.proposal.raw}）` }, ...p.history] };
        cur = { ...cur, prefs: { ...cur.prefs, [staffId]: np } };
      } else if (it.type === 'dayoff' && it.date) {
        const sub = cur.collection.submitted[staffId]; const ds = Array.from(new Set([...(sub?.dates ?? []), it.date]));
        cur = { ...cur, collection: { ...cur.collection, submitted: { ...cur.collection.submitted, [staffId]: { at: cur.now, dates: ds } } } };
        notices.push(notice({ to: 'leader', kind: 'info', title: `${staffById(staffId).name}さんが希望休を更新`, body: ds.map(fmtMD).join('、'), link: 'collection' }));
      } else if (it.type === 'avail' && it.avail) {
        const cur0 = cur.availability[staffId] ?? []; undo.prefs = undo.prefs;
        cur = { ...cur, availability: { ...cur.availability, [staffId]: [...cur0.filter((x) => x.date !== it.avail!.date), it.avail] } };
      } else if (it.type === 'request' && it.kind && it.date) {
        const r: ShiftRequest = { id: uid('R'), staffId, date: it.date, kind: it.kind, reason: it.reason, detail: it.detail, status: it.needsApproval ? 'pending' : 'auto', via: 'ai', createdAt: nowStamp(), impact: it.impact };
        it.requestId = r.id; undo.requestIds.push(r.id);
        if (!it.needsApproval) {
          const target = cur.assignments.find((x) => x.staffId === staffId && x.date === it.date && x.status !== 'absent');
          if (target) undo.assignments.push(target);
          const before = new Set(cur.vacancies.map((v) => v.id));
          cur = { ...cur, ...applyRequestToRoster(cur, r) };
          cur.vacancies.forEach((v) => { if (!before.has(v.id)) undo.addedVacancyIds.push(v.id); });
        } else anyReview = true;
        cur = { ...cur, requests: [r, ...cur.requests] };
        notices.push(notice({ to: 'leader', kind: 'request', title: it.needsApproval ? `承認待ち：${staffById(staffId).name}さんの${it.kind}（AI正規化）` : `自動反映：${staffById(staffId).name}さんの${it.kind}`, body: it.normalized, link: 'requests' }));
      }
    }
    const proposal: AiProposal = { ...m.proposal, items, undo, state: anyReview ? 'review' : 'applied' };
    return { ...cur, messages: cur.messages.map((x) => (x.id === msgId ? { ...x, proposal } : x)), notices: [...notices, ...cur.notices] };
  });
  kickoffAutopilot();
}
/** 反映後の取り消し（承認待ちのものは申請を取り下げ、自動反映したものは元のシフトへ戻す） */
export function undoProposal(msgId: string, staffId: string) {
  set((s) => {
    const m = s.messages.find((x) => x.id === msgId); const u = m?.proposal?.undo;
    if (!m?.proposal || !u || (m.proposal.state !== 'applied' && m.proposal.state !== 'review')) return {};
    const restored = new Map(u.assignments.map((a) => [a.id, a]));
    const assignments = s.assignments.map((a) => restored.get(a.id) ?? a);
    return {
      assignments,
      vacancies: s.vacancies.filter((v) => !u.addedVacancyIds.includes(v.id)),
      requests: s.requests.filter((r) => !u.requestIds.includes(r.id)),
      prefs: u.prefs ? { ...s.prefs, [staffId]: { ...s.prefs[staffId], ...u.prefs } } : s.prefs,
      messages: s.messages.map((x) => (x.id === msgId ? { ...x, proposal: { ...m.proposal!, state: 'undone' as const } } : x)),
      notices: [notice({ to: 'leader', kind: 'request', title: `${staffById(staffId).name}さんが申請を取り消しました`, body: m.proposal.items.filter((i) => i.type !== 'unknown').map((i) => i.normalized).join(' ／ '), link: 'requests' }), ...s.notices],
    };
  });
}
export function cancelProposal(msgId: string) { set((s) => ({ messages: s.messages.map((x) => (x.id === msgId && x.proposal ? { ...x, proposal: { ...x.proposal, state: 'cancelled' as const } } : x)) })); }

// ---- 体調 ----
export function submitHealth(h: Omit<HealthCheck, 'id' | 'at'>) {
  set((s) => {
    const warn = h.temp >= 37.5 || h.symptoms.length > 0 || h.household !== '症状なし' || h.consult;
    return {
      health: [{ ...h, id: uid('H'), at: nowStamp() }, ...s.health.filter((x) => !(x.staffId === h.staffId && x.date === h.date))],
      notices: warn ? [notice({ to: 'leader', kind: 'health', title: `${staffById(h.staffId).name}さん：体調チェックに確認事項`, body: `体温${h.temp.toFixed(1)}℃${h.symptoms.length ? `／${h.symptoms.join('・')}` : ''}${h.consult ? '／相談希望' : ''}。就業可否はリーダーが本人と確認してください。`, link: 'health' }), ...s.notices] : s.notices,
    };
  });
}

// ---- 希望 ----
export function savePrefs(staffId: string, p: Partial<Prefs>, historyText: string) {
  set((s) => ({ prefs: { ...s.prefs, [staffId]: { ...s.prefs[staffId], ...p, history: [{ at: nowStamp(), text: historyText }, ...s.prefs[staffId].history] } } }));
}
export function saveSettings(id: string, p: Partial<Settings>) { set((s) => ({ settings: { ...s.settings, [id]: { ...s.settings[id], ...p } } })); }

// ---- お知らせ ----
export function readNotice(id: string) { set((s) => ({ notices: s.notices.map((n) => (n.id === id ? { ...n, read: true } : n)) })); }
export function readAll(to: string) { set((s) => ({ notices: s.notices.map((n) => (n.to === to ? { ...n, read: true } : n)) })); }

// ---- 欠員対応（シフト作成君の自動対応） ----
// 流れ：欠員を検知 → リーダーに「自動で進めてよいか」を1回確認 → 優先順に1人ずつ打診 → 入れる人がいれば充足
//        → 誰も入れなければ求人文を作成し、掲載の承認だけをリーダーに求める（実掲載・外部送信なし）
const vac = (s: State, id: string) => s.vacancies.find((x) => x.id === id);
const patchV = (s: State, id: string, fn: (v: Vacancy) => Vacancy): State => ({ ...s, vacancies: s.vacancies.map((v) => (v.id === id ? fn(v) : v)) });
const logS = (s: State, id: string, text: string, kind: AutoState['log'][number]['kind'] = 'info'): State =>
  patchV(s, id, (v) => (v.auto ? { ...v, auto: { ...v.auto, log: [...v.auto.log, { at: s.now, text, kind }] } } : v));
const autoS = (s: State, id: string, p: Partial<AutoState>): State => patchV(s, id, (v) => (v.auto ? { ...v, auto: { ...v.auto, ...p } } : v));
const noticeS = (s: State, n: Omit<Notice, 'id' | 'at' | 'read'>): State => ({ ...s, notices: [notice(n), ...s.notices] });
const aiSayS = (s: State, staffId: string, text: string, offer?: { vacancyId: string }): State => ({ ...s, messages: [...s.messages, { id: uid('M'), thread: `ai:${staffId}`, from: 'ai', text, at: s.now, offer }] });
export const effSettings = (s: State, v?: Vacancy): AutopilotSettings => ({ ...s.autopilot, ...(v?.opts ?? {}), adjustKinds: { ...s.autopilot.adjustKinds, ...(v?.opts?.adjustKinds ?? {}) }, priority: { ...s.autopilot.priority, ...(v?.opts?.priority ?? {}) } });
const MULT = { low: 0.5, normal: 1, high: 2 } as const;
const rankOf = (s: State, v: Vacancy) => { const e = effSettings(s, v); return rankCandidates(s.assignments, v, hopes(s), s.availability, { fair: s.spareUse, availBonus: e.priority.availFirst ? 60 : 0, skillMult: MULT[e.priority.skill], daysMult: MULT[e.priority.days] }); };
const requesterOf = (s: State, v: Vacancy) => s.assignments.find((a) => a.id === v.fromAssignmentId)?.staffId;
const vacLabel = (v: Vacancy) => `${fmtMD(v.date)} ${v.shift}（${unitName(v.unitId)}）${v.kind === 'gap' ? ' の応援' : ''}`;
const hopes = (s: State) => Object.fromEntries(Object.entries(s.prefs).map(([k, p]) => [k, p.shiftHope])) as Record<string, ShiftCode[]>;
export const inQuiet = (now: string, a: AutopilotSettings) => { const m = stampMin(now); const qs = toMin(a.quietStart); const qe = toMin(a.quietEnd); return qs > qe ? m >= qs || m < qe : m >= qs && m < qe; };
const nextQuietEnd = (now: string, a: AutopilotSettings) => { const day = stampMin(now) >= toMin(a.quietStart) ? addDays(stampDay(now), 1) : stampDay(now); return `${day} ${a.quietEnd}`; };

export function jobText(v: Vacancy, reward: string, note = 'ユニット型の少人数ケア。仮眠・休憩は交代で確実に取れます。') {
  const unit = UNITS_BY_ID(v.unitId);
  const skill = v.needSkills.length ? `\n必要スキル：${skillText(v.needSkills)}（要件確認済みの方）` : '';
  return `【さくら苑｜${v.shift}スタッフ募集（単発）】\n日時：${fmtMD(v.date)} ${v.shift} ${SHIFT_LABEL[v.shift]}\n配属：${unit}\n資格：介護福祉士または実務者研修修了${skill}\n業務：食事・排泄・入浴介助、巡回、記録\n対価：${reward}\n職場：${note}\n※応募後に資格を確認します。`;
}
import { SHIFTS as _SH, UNITS as _UN } from './facility';
const SHIFT_LABEL: Record<ShiftCode, string> = Object.fromEntries(Object.entries(_SH).map(([k, v]) => [k, v.label])) as Record<ShiftCode, string>;
const UNITS_BY_ID = (id: string) => { const u = _UN.find((x) => x.id === id); return u ? `${u.floor}階 ${u.name}（入居者${u.capacity}名）` : id; };

/** 欠員を検知したら、リーダーに自動対応の確認を出す（休み・遅刻・早退の申請が反映された直後に呼ぶ） */
export function kickoffAutopilot() {
  set((s) => {
    let cur = s;
    for (const v of s.vacancies) {
      if (!v.fromAssignmentId || v.auto || v.state !== 'open' || v.date < s.today) continue;
      if (!s.autopilot.enabled) { cur = patchV(cur, v.id, (x) => ({ ...x, auto: { mode: 'manual', queue: [], idx: 0, max: 0, log: [{ at: cur.now, text: '自動対応がオフのため、手動で対応してください', kind: 'warn' }] } })); continue; }
      cur = patchV(cur, v.id, (x) => ({ ...x, auto: { mode: 'ask', queue: [], idx: 0, max: effSettings(s, x).maxCandidates, log: [{ at: cur.now, text: `欠員を検知しました（${v.reason}）。自動で代わりを探してよいか、リーダーに確認します`, kind: 'info' }] } }));
      cur = noticeS(cur, { to: 'leader', kind: 'autopilot', title: `${v.id}：自動で代わりを探してよいですか？`, body: `${vacLabel(v)}。承認すると、候補へ優先順に1人ずつ打診し、入れる人がいれば自動で充足します。誰も入れない場合は求人文を作成し、掲載の承認だけをお願いします。`, link: `autopilot:${v.id}` });
      const who = requesterOf(cur, v);
      if (who) cur = aiSayS(cur, who, `${fmtMD(v.date)}の${v.shift}は、代わりの出勤者を探します。リーダーの確認が済み次第、こちらでお知らせします。`);
    }
    return cur;
  });
}

function quietDefer(s: State, id: string, staffId: string): State {
  const at = nextQuietEnd(s.now, effSettings(s, vac(s, id)));
  return logS(autoS(s, id, { waitUntil: at, pendingStaff: staffId }), id, `夜間の連絡禁止時間のため、${staffById(staffId).name}さんへの打診は${stampTime(at)}に送ります`, 'warn');
}
function sendOfferS(s: State, id: string, staffId: string): State {
  const v = vac(s, id)!; const E = effSettings(s, v); const wait = v.auto?.waitMin ?? (v.date === s.today ? E.waitSameDay : E.waitOther);
  let t = patchV(s, id, (x) => ({ ...x, state: 'offering', offers: [...x.offers.filter((o) => o.staffId !== staffId), { staffId, at: s.now, status: 'pending' }] }));
  t = autoS(t, id, { waitUntil: addMinutes(s.now, wait), pendingStaff: undefined });
  t = logS(t, id, `${staffById(staffId).name}さんに打診しました（返信待ち ${wait}分）`, 'offer');
  t = aiSayS(t, staffId, `${vacLabel(v)}に入れますか？\n人手が足りず、代わりの方を探しています。断っても評価には影響しません。`, { vacancyId: id });
  return noticeS(t, { to: staffId, kind: 'offer', title: `${fmtMD(v.date)} ${v.shift}に入れますか？`, body: `${unitName(v.unitId)}。シフト作成君からの打診です。断っても評価に影響しません。`, link: `offer:${id}` });
}
function draftPostS(s: State, id: string, why: string): State {
  const v = vac(s, id)!;
  const E = effSettings(s, v); const reward = E.defaultReward + (v.shift === '夜勤' ? '＋夜勤手当5,000円' : '');
  let t = patchV(s, id, (x) => ({ ...x, state: 'open', jobPost: { reward, text: jobText(x, reward, E.jobNote), status: 'draft' } }));
  t = autoS(t, id, { mode: 'waiting_post', waitUntil: undefined, pendingStaff: undefined });
  if (E.autoPost) {
    t = patchV(t, id, (x) => ({ ...x, state: 'posted', jobPost: { reward, text: x.jobPost?.text, status: 'posted', postedAt: s.now } }));
    t = autoS(t, id, { mode: 'posted' });
    t = logS(t, id, `${why}求人文を作成し、自動で掲載しました（掲載の取り消し・手動への切替はできます）`, 'ok');
    return noticeS(t, { to: 'leader', kind: 'autopilot', title: `${v.id}：求人を自動で掲載しました`, body: `${vacLabel(v)}。内部の候補では埋まらなかったため、対価（${reward}）で求人を掲載しました。内容は欠員の詳細で確認できます。`, link: `autopilot:${id}` });
  }
  t = logS(t, id, `${why}求人文を作成しました。掲載の承認をお願いします`, 'warn');
  return noticeS(t, { to: 'leader', kind: 'autopilot', title: `${v.id}：求人掲載の承認をお願いします`, body: `${vacLabel(v)}。内部の候補では埋まりませんでした。求人文と対価（${reward}）を確認してください。`, link: `autopilot:${id}` });
}
function stepS(s: State, id: string): State {
  const v = vac(s, id); const a = v?.auto; if (!v || !a || v.state === 'filled') return s;
  if (a.idx >= a.queue.length) return draftPostS(s, id, a.queue.length ? '候補全員に打診しましたが、入れる方が見つかりませんでした。' : '打診できる候補がいませんでした。');
  const staffId = a.queue[a.idx]; const t = autoS(s, id, { idx: a.idx + 1 });
  return inQuiet(s.now, effSettings(s, v)) ? quietDefer(t, id, staffId) : sendOfferS(t, id, staffId);
}
function fillS(s: State, id: string, staffId: string, source: Assignment['source']): State {
  const v = vac(s, id)!;
  const cleaned = s.assignments.filter((a) => !(a.date === v.date && a.shift === v.shift && a.unitId === v.unitId && a.status === 'absent' && v.kind !== 'gap'));
  const asg: Assignment = { id: uid('A'), date: v.date, staffId, shift: v.shift, unitId: v.unitId, status: 'assigned', source, note: v.kind === 'gap' ? '応援（遅刻・早退の補完）' : undefined };
  let t: State = { ...s, assignments: [...cleaned, asg], spareUse: availFor(s.availability, staffId, v.date, v.shift) ? { ...s.spareUse, [staffId]: (s.spareUse[staffId] ?? 0) + 1 } : s.spareUse };
  t = patchV(t, id, (x) => ({ ...x, resolution: { kind: source === 'offer' ? 'offer' : 'leader', at: s.now, staffId }, state: 'filled', filledBy: staffId, offers: x.offers.map((o) => (o.staffId === staffId ? { ...o, status: 'accepted' } : o.status === 'pending' ? { ...o, status: 'expired' } : o)) }));
  t = autoS(t, id, { mode: 'done', waitUntil: undefined, pendingStaff: undefined });
  t = logS(t, id, `${staffById(staffId).name}さんが入ることになり、充足しました。日次・月次シフトに反映済みです`, 'ok');
  t = noticeS(t, { to: 'leader', kind: 'shift', title: `${id} が充足しました`, body: `${staffById(staffId).name}さんが${vacLabel(v)}に入ります。`, link: 'vacancy' });
  t = noticeS(t, { to: staffId, kind: 'shift', title: 'シフトが追加されました', body: `${vacLabel(v)}`, link: 'shift' });
  const who = requesterOf(s, v);
  if (who && who !== staffId) {
    t = aiSayS(t, who, `${fmtMD(v.date)}の${v.shift}は、${staffById(staffId).name}さんが代わりに入ることになりました。ゆっくり休んでください。`);
    t = noticeS(t, { to: who, kind: 'shift', title: '代わりが決まりました', body: `${staffById(staffId).name}さんが${fmtMD(v.date)}の${v.shift}に入ります。`, link: 'shift' });
  }
  return t;
}

/** リーダーが「自動で進める」を承認（打診人数・返信待ち時間はここで上書き可） */
export function approveAutopilot(id: string, o: { max?: number; waitMin?: number; ai?: AiRank } = {}) {
  set((s) => {
    const v = vac(s, id); if (!v) return {};
    const E = effSettings(s, v);
    const max = o.max ?? v.auto?.max ?? E.maxCandidates;
    const ranked = rankOf(s, v);
    // 打診してよい人は画面の判定で決め、学習済みモデル（o.ai）があれば、その中の順番だけを並べ替える
    const okList = ranked.filter((c) => !c.blocked && !c.unfit && !v.offers.some((x) => x.staffId === c.staff.id));
    const queue = reorderByAi(okList, o.ai, E.priority.availFirst).slice(0, max).map((c) => c.staff.id);
    const prob = o.ai ? Object.fromEntries(okList.filter((c) => c.staff.id in o.ai!.prob).map((c) => [c.staff.id, o.ai!.prob[c.staff.id]])) : undefined;
    const unfit = ranked.filter((c) => !c.blocked && c.unfit);
    const req = requiredSkills(s.assignments, v);
    let t = patchV(s, id, (x) => ({ ...x, needSkills: req, auto: { mode: 'running', queue, idx: 0, max, waitMin: o.waitMin, log: x.auto?.log ?? [], ...(prob && Object.keys(prob).length ? { prob } : {}) } }));
    t = logS(t, id, 'リーダーがシフト作成君に任せました', 'ok');
    const who = requesterOf(t, v);
    // ① まず、時間をずらす調整（単独・組み合わせ）で足りるかを確認する
    if (E.useAdjust) {
      const kinds = (Object.keys(E.adjustKinds) as ('break' | 'support' | 'extend')[]).filter((k) => E.adjustKinds[k]);
      const plan = kinds.length ? proposeAdjustments(s.assignments, v, [...kinds, 'combo']).filter((p) => p.resolves && (p.kind !== 'combo' || true)).sort((a, b) => a.changes.length - b.changes.length)[0] : undefined;
      if (plan) {
        t = logS(autoS(t, id, { mode: 'waiting_adjust', planId: plan.id }), id, `時間をずらす方法で対応できます：${plan.title}（${plan.changes.map((c) => c.text).join('／')}）。ほかの職員の勤務に影響するため、承認をお願いします`, 'warn');
        if (who) t = aiSayS(t, who, `代わりの出勤者を探しています。まず、勤務時間の調整で対応できないか確認しています。`);
        return noticeS(t, { to: 'leader', kind: 'autopilot', title: `${id}：時間の調整で対応できます`, body: `${plan.title}。${plan.changes.map((c) => c.text).join('／')}`, link: `autopilot:${id}` });
      }
      t = logS(t, id, '時間をずらす調整だけでは足りないため、代わりの出勤者に打診します', 'info');
    }
    t = logS(t, id, `打診の前に、人数・必須スキル・休憩の交代・前後の勤務を確認しました${req.length ? `（必須スキル：${req.map((k) => (SKILLS as Record<string, { label: string }>)[k].label).join('・')}）` : ''}。${unfit.length ? `条件に合わない${unfit.length}人は自動の打診から外しました（理由は欠員の詳細で確認できます）` : '外した人はいません'}`, 'info');
    if (prob && Object.keys(prob).length) t = logS(t, id, `過去の打診の記録から学習したモデルで、応諾の見込みが高い順に並べ直しました${E.priority.availFirst ? '（「入れる日」に登録していた人を先にする設定は守っています）' : ''}`, 'info');
    t = logS(t, id, `優先順に最大${max}人へ1人ずつ打診します：${queue.map((q) => `${staffById(q).name}${prob?.[q] !== undefined ? `（応諾の見込み ${Math.round(prob[q] * 100)}%）` : ''}`).join(' → ') || '（候補なし）'}`, 'ok');
    if (who) t = aiSayS(t, who, `リーダーの確認が済みました。代わりの方に順番に連絡しています。`);
    return stepS(t, id);
  });
}
/** 時間調整案を見送り、代わりの出勤者への打診へ進む */
export function skipAdjustment(id: string) {
  set((s) => { const v = vac(s, id); if (!v?.auto) return {}; let t = logS(autoS(s, id, { mode: 'running', planId: undefined }), id, 'リーダーは時間調整を見送りました。代わりの出勤者に打診します', 'info'); t = logS(t, id, `優先順に打診します：${v.auto.queue.map((q) => staffById(q).name).join(' → ') || '（候補なし）'}`, 'ok'); return stepS(t, id); });
}
/** この欠員だけの詳細設定（全体の「自動対応」設定を上書き） */
export function setVacancyOpts(id: string, patch: Partial<AutopilotSettings>) { set((s) => patchV(s, id, (x) => ({ ...x, opts: { ...x.opts, ...patch } }))); }
export function clearVacancyOpts(id: string) { set((s) => patchV(s, id, (x) => ({ ...x, opts: undefined }))); }
/** 「自分で進める」を選んだ場合 */
export function declineAutopilot(id: string) { set((s) => logS(autoS(s, id, { mode: 'manual' }), id, 'リーダーが手動で対応することにしました', 'info')); }
export function pauseAutopilot(id: string) { set((s) => logS(autoS(s, id, { mode: 'paused' }), id, '自動対応を一時停止しました', 'warn')); }
export function resumeAutopilot(id: string) { set((s) => { const v = vac(s, id); if (!v?.auto) return {}; const t = logS(autoS(s, id, { mode: 'running' }), id, '自動対応を再開しました', 'info'); return v.offers.some((o) => o.status === 'pending') ? t : stepS(t, id); }); }
/** いまの打診を見送り扱いにして次の候補へ */
export function skipCandidate(id: string) {
  set((s) => { const v = vac(s, id); if (!v?.auto) return {}; let t = patchV(s, id, (x) => ({ ...x, offers: x.offers.map((o) => (o.status === 'pending' ? { ...o, status: 'expired' } : o)) })); t = logS(t, id, 'リーダーが次の候補へ進めました', 'info'); return stepS(autoS(t, id, { mode: 'running', pendingStaff: undefined }), id); });
}
/** 通常の欠員（月次案の不足など）にも、リーダー操作で自動対応を開始できる */
export function startAutopilot(id: string, o: { max?: number; waitMin?: number; ai?: AiRank } = {}) {
  set((s) => patchV(s, id, (x) => ({ ...x, auto: x.auto ?? { mode: 'ask', queue: [], idx: 0, max: effSettings(s, x).maxCandidates, log: [{ at: s.now, text: 'リーダーが自動対応を開始しました', kind: 'info' }] } })));
  approveAutopilot(id, o);
}
/**
 * 「任せる」の入口。学習済みモデルの順番を API に1回だけ聞き（最大3秒）、使えればそれで、使えなければ従来の順番で進める。
 * start=true は、まだ自動対応を始めていない欠員（startAutopilot）。同じ欠員の二重押しは無視する。
 */
const delegating = new Set<string>();
export const isDelegating = (id: string) => delegating.has(id);
export async function delegateAutopilot(id: string, o: { max?: number; waitMin?: number } = {}, start = false): Promise<void> {
  if (delegating.has(id)) return;
  delegating.add(id);
  let ai: AiRank | null = null;
  try { const v = vac(state, id); if (v) ai = await rankViaApi(state, v); } catch { ai = null; }
  try { (start ? startAutopilot : approveAutopilot)(id, ai ? { ...o, ai } : o); } finally { delegating.delete(id); }
}
/** デモ用：時間を進める（返信待ち時間の経過・夜間送信待ちの解除） */
export function advanceClock(min: number) {
  set((s) => {
    let t: State = { ...s, now: addMinutes(s.now, min) };
    for (const v of s.vacancies) {
      const a = v.auto; if (!a || a.mode !== 'running' || !a.waitUntil || a.waitUntil > t.now) continue;
      if (a.pendingStaff) { t = sendOfferS(logS(t, v.id, '連絡可能な時間になったため打診を送ります', 'info'), v.id, a.pendingStaff); continue; }
      const pend = v.offers.find((o) => o.status === 'pending');
      if (pend) { t = patchV(t, v.id, (x) => ({ ...x, offers: x.offers.map((o) => (o === pend || o.staffId === pend.staffId ? { ...o, status: 'expired' } : o)) })); t = logS(t, v.id, `${staffById(pend.staffId).name}さんから返信がなく、返信待ち時間を過ぎたため次の候補へ進みます`, 'warn'); t = aiSayS(t, pend.staffId, `${vacLabel(v)}の打診は、返信期限を過ぎたため次の方へ依頼しました。`); }
      t = stepS(autoS(t, v.id, { waitUntil: undefined }), v.id);
    }
    return t;
  });
}

export function offerTo(vacancyId_: string, staffId: string) { set((s) => (vac(s, vacancyId_) ? sendOfferS(s, vacancyId_, staffId) : {})); }
export function respondOffer(vacancyId_: string, staffId: string, accept: boolean) {
  set((s) => {
    const v = vac(s, vacancyId_); if (!v) return {};
    const o = v.offers.find((x) => x.staffId === staffId);
    if (v.state === 'filled' || o?.status === 'expired' || o?.status === 'accepted' || o?.status === 'declined') return aiSayS(s, staffId, 'この打診はすでに終了しています。');
    if (accept) return aiSayS(fillS(s, vacancyId_, staffId, 'offer'), staffId, `ありがとうございます。${vacLabel(v)}をシフトに追加しました。`);
    let t = patchV(s, vacancyId_, (x) => ({ ...x, offers: x.offers.map((p) => (p.staffId === staffId ? { ...p, status: 'declined' } : p)) }));
    t = aiSayS(t, staffId, '承知しました。今回は見送りとして連絡します。評価には影響しません。');
    if (v.auto) { t = logS(t, vacancyId_, `${staffById(staffId).name}さんは今回は見送りでした`, 'info'); if (v.auto.mode === 'running') t = stepS(autoS(t, vacancyId_, { waitUntil: undefined }), vacancyId_); }
    else t = noticeS(t, { to: 'leader', kind: 'info', title: `${staffById(staffId).name}さんは今回は見送り`, body: `${v.id}（${vacLabel(v)}）。次の候補へ打診できます。`, link: 'vacancy' });
    return t;
  });
}
export function assignStaff(vacancyId_: string, staffId: string, source: Assignment['source'] = 'leader') { set((s) => (vac(s, vacancyId_) ? fillS(s, vacancyId_, staffId, source) : {})); }

// 求人掲載（AIが作った求人文をリーダーが承認。モックのため実際の掲載・外部送信はしない）
export function approveJobPost(id: string, text: string, reward: string) {
  set((s) => { const v = vac(s, id); if (!v) return {}; let t = patchV(s, id, (x) => ({ ...x, state: 'posted', jobPost: { reward, text, status: 'posted', postedAt: s.now } })); t = autoS(t, id, { mode: 'posted' }); t = logS(t, id, 'リーダーが求人掲載を承認しました', 'ok'); return t; });
}
export function rejectJobPost(id: string) { set((s) => logS(autoS(patchV(s, id, (x) => ({ ...x, jobPost: undefined, state: x.state === 'posted' ? 'open' : x.state })), id, { mode: 'manual' }), id, 'リーダーが求人掲載を見送りました。手動で対応します', 'warn')); }
export function postJob(vacancyId_: string, reward: string) { patchVacancy(vacancyId_, (v) => ({ ...v, state: 'posted', jobPost: { reward, postedAt: nowStamp(), status: 'posted', text: v.jobPost?.text } })); }
export function simulateApplication(vacancyId_: string) {
  set((s) => {
    const v = vac(s, vacancyId_); if (!v) return {};
    const mk = (id: string, note: string): Applicant => { const st = staffById(id); const req = Array.from(new Set([...v.needSkills, ...requiredSkills(s.assignments, v), ...(v.shift === '夜勤' ? ['night' as const] : [])])); const missing = req.filter((k) => !st.skills.includes(k)); return { id: `AP-${id}`, staffId: id, name: st.name, skills: st.skills, years: st.years, license: st.license, ok: missing.length === 0, missing, note }; };
    const applicants = [mk('EMP-901', '平日の夜勤が中心。医療的ケアの研修は未修了'), mk('EMP-900', '夜勤の経験が豊富。直近は特養で勤務'), mk('EMP-902', '看取りケアの経験あり。単発の応募')];
    let t = patchV(s, vacancyId_, (x) => ({ ...x, state: 'applied', applicants, applicant: applicants.find((a) => a.ok) ?? applicants[0] }));
    t = logS(t, vacancyId_, `応募が${applicants.length}件ありました。必要スキルで自動照合：適合 ${applicants.filter((a) => a.ok).length}件／不足 ${applicants.filter((a) => !a.ok).length}件`, applicants.some((a) => a.ok) ? 'ok' : 'warn');
    return noticeS(t, { to: 'leader', kind: 'autopilot', title: `${vacancyId_}：応募が${applicants.length}件ありました`, body: `必要スキルに適合する応募は${applicants.filter((a) => a.ok).length}件です。内容を確認して、採用する方を決めてください。`, link: `autopilot:${vacancyId_}` });
  });
}
export function confirmApplicant(vacancyId_: string, applicantId?: string) {
  const v = state.vacancies.find((x) => x.id === vacancyId_); const ap = v?.applicants?.find((a) => a.id === applicantId) ?? v?.applicant;
  if (v && ap?.ok) assignStaff(vacancyId_, ap.staffId, 'leader');
}
/** 時間をずらす調整案を、リーダーが承認して反映する（影響する職員に通知） */
export function applyAdjustment(vacancyId_: string, planId: string) {
  set((s) => {
    const v = vac(s, vacancyId_); if (!v) return {};
    const plan = proposeAdjustments(s.assignments, v).find((p) => p.id === planId); if (!plan) return {};
    let assignments = applyAdjust(s.assignments, plan.changes);
    if (plan.resolves) assignments = assignments.map((a) => (a.id === v.fromAssignmentId ? { ...a, covered: true } : a));
    let t: State = { ...s, assignments };
    if (plan.resolves) t = patchV(t, vacancyId_, (x) => ({ ...x, resolution: { kind: 'adjust', at: s.now, title: plan.title, changes: plan.changes.map((c) => ({ assignmentId: c.assignmentId, staffId: c.staffId, text: c.text })) }, state: 'filled', resolvedBy: 'adjust', auto: x.auto ? { ...x.auto, mode: 'done', waitUntil: undefined, pendingStaff: undefined } : x.auto }));
    t = logS(t, vacancyId_, `リーダーが調整案「${plan.title}」を承認しました。${plan.changes.map((c) => c.text).join('／')}`, 'ok');
    for (const c of plan.changes) t = noticeS(t, { to: c.staffId, kind: 'shift', title: `${fmtMD(v.date)}の勤務が調整されました`, body: `${c.text}。欠員への対応です。都合が悪い場合はリーダーに相談してください。`, link: 'shift' });
    return noticeS(t, { to: 'leader', kind: 'shift', title: `${vacancyId_}：調整案を反映しました`, body: plan.changes.map((c) => c.text).join('／'), link: 'vacancy' });
  });
}
/** 手動で延ばした時間を確定する（欠員を「時間の調整で対応」として閉じ、影響する職員に通知） */
export function confirmManualAdjust(vacancyId_: string, changes: { assignmentId: string; staffId: string; text: string }[]) {
  set((s) => {
    const v = vac(s, vacancyId_); if (!v) return {};
    let t: State = { ...s, assignments: s.assignments.map((a) => (a.id === v.fromAssignmentId ? { ...a, covered: true } : a)) };
    t = patchV(t, vacancyId_, (x) => ({ ...x, resolution: { kind: 'adjust', at: s.now, title: '手動で時間を調整', changes }, state: 'filled', resolvedBy: 'adjust', auto: x.auto ? { ...x.auto, mode: 'done', waitUntil: undefined, pendingStaff: undefined } : x.auto }));
    t = logS(t, vacancyId_, `リーダーが手動で時間を調整しました。${changes.map((c) => c.text).join('／')}`, 'ok');
    for (const c of changes) t = noticeS(t, { to: c.staffId, kind: 'shift', title: `${fmtMD(v.date)}の勤務が調整されました`, body: `${c.text}。欠員への対応です。都合が悪い場合はリーダーに相談してください。`, link: 'shift' });
    return noticeS(t, { to: 'leader', kind: 'shift', title: `${vacancyId_}：手動の調整を反映しました`, body: changes.map((c) => c.text).join('／'), link: 'vacancy' });
  });
}
/** 「入れる日」の登録（希望提出時・シフト作成君から） */
export function setAvailability(staffId: string, items: { date: string; shifts: ShiftCode[] }[]) { set((s) => ({ availability: { ...s.availability, [staffId]: items.sort((a, b) => a.date.localeCompare(b.date)) } })); }
export function updateAutopilot(p: Partial<AutopilotSettings>) { set((s) => ({ autopilot: { ...s.autopilot, ...p } })); }
export const skillText = (ids: string[]) => ids.map((k) => (SKILLS as Record<string, { label: string }>)[k]?.label ?? k).join('・');
export { addDays };

// ---- 希望休の収集 ----
export function submitDayOff(staffId: string, dates: string[]) {
  set((s) => ({
    collection: { ...s.collection, submitted: { ...s.collection.submitted, [staffId]: { at: nowStamp(), dates } } },
    notices: [notice({ to: 'leader', kind: 'info', title: `${staffById(staffId).name}さんが希望休を提出`, body: dates.length ? dates.map(fmtMD).join('、') : '希望なし', link: 'collection' }), ...s.notices],
  }));
}
/** 未提出者に催促を送る。送った事実を残し、デモでは数名が数秒後に自動で提出する */
export function remindUnsubmitted(): number {
  const left = Object.entries(state.collection.submitted).filter(([, v]) => !v).map(([id]) => id);
  if (!left.length) return 0;
  set((s) => ({
    collection: { ...s.collection, remindedAt: nowStamp(), remindedN: left.length },
    notices: [...left.map((id) => notice({ to: id, kind: 'info', title: `${s.collection.month.slice(5)}月分の希望休の提出をお願いします`, body: `締切：${fmtMD(s.collection.deadline)}。シフトタブの「希望休を出す」から提出できます。`, link: 'dayoff' })), ...s.notices],
    messages: [...s.messages, ...left.map((id) => ({ id: uid('M'), thread: `ai:${id}`, from: 'ai', text: `${s.collection.month.slice(5)}月分の希望休の提出をお願いします（締切 ${fmtMD(s.collection.deadline)}）。`, at: s.now }))],
  }));
  const month = state.collection.month;
  // 全員が数秒以内にほぼ同時に提出（ほとんどは「希望休なし」、先頭の数名だけ希望休あり）
  left.forEach((id, i) => setTimeout(() => {
    if (state.collection.submitted[id]) return;
    const d = (n: number) => `${month}-${String(n).padStart(2, '0')}`;
    submitDayOff(id, i === 0 ? [d(12), d(13)] : i === 1 ? [d(20)] : []);
  }, 1200 + (i % 6) * 150));
  return left.length;
}

// ---- デモの自動進行（打診の返信・求人の応募） ----
const demoDone = new Set<string>();
/** デモの返信シナリオ：内部の候補が1人だけ→辞退（→求人へ）／複数→1人目は返信なし（期限切れで次へ）、2人目以降は承諾 */
/** デモ用の返信の筋書き。候補の順番が学習した予測で変わっても、加藤さんが「入れる」と返信し、後藤さんは返信しない（動画の筋と同じ） */
export function demoPlan(v: Vacancy, staffId?: string): 'silent' | 'decline' | 'accept' {
  if ((v.auto?.queue.length ?? 0) <= 1) return 'decline';
  const nm = staffId ? staffById(staffId)?.name ?? '' : '';
  if (nm.startsWith('加藤')) return 'accept';
  if (nm.startsWith('後藤')) return 'silent';
  return v.offers.length <= 1 ? 'silent' : 'accept';
}
export function demoReply(vacancyId_: string, staffId: string) {
  const v = state.vacancies.find((x) => x.id === vacancyId_); const o = v?.offers.find((x) => x.staffId === staffId && x.status === 'pending');
  if (!v || !o) return; const plan = demoPlan(v, staffId); if (plan === 'silent') return;
  const key = `${vacancyId_}:${staffId}:${o.at}`; if (demoDone.has(key)) return; demoDone.add(key);
  const decline = plan === 'decline';
  setTimeout(() => sendMessage(`ai:${staffId}`, staffId, decline ? '申し訳ありません、その日は予定があり入れません。' : 'はい、入れます。よろしくお願いします。'), 1800);
  setTimeout(() => respondOffer(vacancyId_, staffId, !decline), 3200);
}
/** 求人の掲載から数秒後に、応募が自動で届く */
export function demoApplication(vacancyId_: string) {
  const v = state.vacancies.find((x) => x.id === vacancyId_); if (!v || v.state !== 'posted') return;
  const key = `app:${vacancyId_}:${v.jobPost?.postedAt}`; if (demoDone.has(key)) return; demoDone.add(key);
  setTimeout(() => { if (state.vacancies.find((x) => x.id === vacancyId_)?.state === 'posted') simulateApplication(vacancyId_); }, 3500);
}
/** 手動対応：割り当ての始業・終業を延ばす（延長のみ） */
export function setAssignmentSpan(assignmentId: string, startAt?: number, endAt?: number) {
  set((s) => ({ assignments: s.assignments.map((a) => (a.id === assignmentId ? { ...a, adjust: { ...(a.adjust ?? {}), ...(startAt ? { startAt } : {}), ...(endAt ? { endAt } : {}) } } : a)) }));
}

// ---- 来月の希望（希望休・入れる日・勤務帯）をまとめて提出・編集 ----
export function submitMonthRequests(staffId: string, r: { dayOff: string[]; avail: { date: string; shifts: ShiftCode[] }[]; shiftHope: ShiftCode[]; note?: string }) {
  set((s) => {
    const m = s.collection.month;
    const keep = (s.availability[staffId] ?? []).filter((x) => !x.date.startsWith(m));
    const p = s.prefs[staffId];
    return {
      collection: { ...s.collection, submitted: { ...s.collection.submitted, [staffId]: { at: s.now, dates: r.dayOff.slice().sort() } } },
      availability: { ...s.availability, [staffId]: [...keep, ...r.avail].sort((a, b) => a.date.localeCompare(b.date)) },
      prefs: { ...s.prefs, [staffId]: { ...p, shiftHope: r.shiftHope, history: [{ at: s.now, text: `${+m.slice(5)}月の希望を提出（希望休${r.dayOff.length}日・入れる日${r.avail.length}日${r.shiftHope.length ? `・勤務帯希望：${r.shiftHope.join('・')}` : ''}）` }, ...p.history] } },
      notices: [notice({ to: 'leader', kind: 'info', title: `${staffById(staffId).name}さんが${+m.slice(5)}月の希望を提出`, body: `希望休${r.dayOff.length}日／入れる日${r.avail.length}日`, link: 'collection' }), ...s.notices],
    };
  });
}

// ---- 行事 ----
export function addEvent(e: Omit<FacilityEvent, 'id'>) { set((s) => ({ events: [...s.events, { ...e, id: uid('EV') }] })); }
export function updateEvent(id: string, p: Partial<FacilityEvent>) { set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, ...p } : e)) })); }
export function removeEvent(id: string) { set((s) => ({ events: s.events.filter((e) => e.id !== id) })); }

// ---- 月次シフトの作成・編集・公開 ----
const dayOffMap = (s: State, month: string): Record<string, string[]> => (s.collection.month === month ? Object.fromEntries(Object.entries(s.collection.submitted).filter(([, v]) => v).map(([k, v]) => [k, v!.dates])) : {});
export function createPlan(month: string, o: { nightMax?: number } = {}) {
  set((s) => ({ plan: planMonth(month, { assignments: s.assignments, dayOff: dayOffMap(s, month), avail: s.availability, events: s.events, nightMax: o.nightMax }), notices: [notice({ to: 'leader', kind: 'shift', title: `${+month.slice(5)}月のシフト案ができました`, body: '結果を確認し、必要なら編集してから公開してください。', link: 'plan' }), ...s.notices] }));
  startSolver(month, o.nightMax);
}

// ---- 最適化ソルバー（Cloud Run の CP-SAT）で組み直す ----
// 先に端末内の簡易計算の案を出しておき、ソルバーの結果が届いたら差し替える。届くまでに案が編集されていたら差し替えない。
// 失敗（接続不可・25秒で打ち切り・混雑 429/503・解なし）したら簡易計算の案のまま（メモに1行だけ残す）。
let solving: { month: string } | null = null;
let solveCtl: AbortController | null = null;
export const planSolving = () => solving;
function startSolver(month: string, nightMax?: number) {
  solveCtl?.abort();
  const base = state.plan;
  if (!base || base.month !== month || !solverEnabled()) { solving = null; solveCtl = null; return; }
  const ctl = new AbortController(); solveCtl = ctl;
  const timer = setTimeout(() => ctl.abort(), 25_000);
  solving = { month }; subs.forEach((f) => f());
  const ctx = { assignments: state.assignments, dayOff: dayOffMap(state, month), avail: state.availability, events: state.events, nightMax };
  solveMonth(month, ctx, ctl.signal).then(({ draft, res }) => {
    if (solveCtl !== ctl) return;
    set((s) => {
      if (s.plan !== base) return {};
      const p = finalize(month, draft, ctx, 'draft', base.createdAt);
      if (p.stats.vacantSlots > base.stats.vacantSlots) return { plan: { ...base, notes: [...base.notes, 'ソルバーの案は欠員枠が多かったため、簡易計算の案のままにしています'] } };
      return { plan: { ...p, notes: [...solverNote(draft, res), ...p.notes] } };
    });
  }).catch((e) => {
    if (solveCtl !== ctl) return;
    console.info('[solver] 簡易計算の案を使います:', e);
    set((s) => (s.plan === base ? { plan: { ...base, notes: [...base.notes, '最適化ソルバーに接続できなかったため、端末内の簡易計算で作成しました'] } } : {}));
  }).finally(() => {
    clearTimeout(timer);
    if (solveCtl === ctl) { solving = null; solveCtl = null; subs.forEach((f) => f()); }
  });
}
/** 作成中のシフトを手で直す：その日・勤務帯・ユニットの担当を入れ替える（staffId=null で空欄に） */
export function planAssign(date: string, shift: ShiftCode, unitId: string, staffId: string | null) {
  set((s) => {
    if (!s.plan) return {};
    const draft = s.plan.draft.filter((a) => !(a.date === date && a.shift === shift && a.unitId === unitId)).filter((a) => !(staffId && a.date === date && a.staffId === staffId && a.shift === shift));
    if (staffId) draft.push({ id: uid('P'), date, staffId, shift, unitId, status: 'assigned', source: 'leader' });
    const ctx = { dayOff: dayOffMap(s, s.plan.month), avail: s.availability, events: s.events, nightMax: s.plan.stats.nightMax };
    return { plan: finalize(s.plan.month, draft, ctx, 'draft', s.plan.createdAt) };
  });
}

// ---- シフト作成：表（エクセル風）の一括編集・有休・依頼 ----
export type PlanCode = ShiftCode | 'off' | 'paid';
export interface PlanEdit { staffId: string; date: string; code: PlanCode; unitId?: string }
export interface PlanSnap { draft: Assignment[]; paid: Record<string, string[]> }
const ctxOf = (s: State) => ({ dayOff: dayOffMap(s, s.plan!.month), avail: s.availability, events: s.events, nightMax: s.plan!.stats.nightMax });
/** 1つの勤務（担当）を差し替える。複数のマスをまとめて変えても、計算は1回 */
export function planEdit(edits: PlanEdit[]) {
  set((s) => {
    if (!s.plan) return {};
    let draft = s.plan.draft; const paid: Record<string, string[]> = { ...(s.paidLeave ?? {}) };
    for (const e of edits) {
      draft = draft.filter((a) => !(a.staffId === e.staffId && a.date === e.date && a.status !== 'absent'));
      paid[e.staffId] = (paid[e.staffId] ?? []).filter((d) => d !== e.date);
      if (e.code === 'paid') paid[e.staffId] = [...paid[e.staffId], e.date];
      else if (e.code !== 'off') {
        const unitId = e.unitId ?? staffById(e.staffId).homeUnit;
        draft = draft.filter((a) => !(a.date === e.date && a.shift === e.code && a.unitId === unitId));
        draft = [...draft, { id: uid('P'), date: e.date, staffId: e.staffId, shift: e.code, unitId, status: 'assigned', source: 'leader' }];
      }
    }
    return { plan: finalize(s.plan.month, draft, ctxOf(s), 'draft', s.plan.createdAt), paidLeave: paid };
  });
}
export function planRestore(snap: PlanSnap) {
  set((s) => (s.plan ? { plan: finalize(s.plan.month, snap.draft, ctxOf(s), 'draft', s.plan.createdAt), paidLeave: snap.paid } : {}));
}
/** 職員への依頼（出勤・希望休の修正・有休の打診）。デモでは数秒後に返事が届く */
export function sendPlanRequest(kind: PlanReqKind, staffId: string, date: string, o: { shift?: ShiftCode; unitId?: string } = {}): string {
  const id = uid('RQ'); const st = staffById(staffId);
  const what = kind === 'work' ? `${fmtMD(date)}の${o.shift ?? '勤務'}${o.unitId ? `（${unitName(o.unitId)}）` : ''}に入ってもらえませんか？` : kind === 'paid' ? `${fmtMD(date)}に有給休暇を取ってもらえませんか？（年5日の取得にあと少しです）` : `${fmtMD(date)}の希望休を見直してもらえませんか？その日は人手が足りません。`;
  const title = kind === 'work' ? '出勤のお願い' : kind === 'paid' ? '有休取得のお願い' : '希望休の見直しのお願い';
  set((s) => ({
    planRequests: [{ id, kind, staffId, date, shift: o.shift, unitId: o.unitId, status: 'pending' as const, at: nowStamp() }, ...(s.planRequests ?? [])].slice(0, 30),
    notices: [notice({ to: staffId, kind: 'info', title, body: what }), ...s.notices],
    messages: [...s.messages, { id: uid('M'), thread: `ai:${staffId}`, from: 'ai', text: what, at: s.now }],
  }));
  const ok = hash31(staffId + date) % 5 !== 0;
  setTimeout(() => {
    set((s) => {
      const reply = ok ? 'はい、大丈夫です。' : '申し訳ありません、その日は難しいです。';
      let patch: Partial<State> = {};
      if (ok && s.plan) {
        if (kind === 'work' && o.shift) { const unitId = o.unitId ?? st.homeUnit; let draft = s.plan.draft.filter((a) => !(a.staffId === staffId && a.date === date && a.status !== 'absent') && !(a.date === date && a.shift === o.shift && a.unitId === unitId)); draft = [...draft, { id: uid('P'), date, staffId, shift: o.shift, unitId, status: 'assigned', source: 'leader' }]; patch = { plan: finalize(s.plan.month, draft, ctxOf(s), 'draft', s.plan.createdAt) }; }
        if (kind === 'paid') { const draft = s.plan.draft.filter((a) => !(a.staffId === staffId && a.date === date && a.status !== 'absent')); patch = { plan: finalize(s.plan.month, draft, ctxOf(s), 'draft', s.plan.createdAt), paidLeave: { ...(s.paidLeave ?? {}), [staffId]: [...((s.paidLeave ?? {})[staffId] ?? []).filter((d) => d !== date), date] } }; }
      }
      if (ok && kind === 'dayoff' && s.collection.submitted[staffId]) patch = { ...patch, collection: { ...s.collection, submitted: { ...s.collection.submitted, [staffId]: { ...s.collection.submitted[staffId]!, dates: s.collection.submitted[staffId]!.dates.filter((d) => d !== date) } } } };
      return { ...patch, planRequests: (s.planRequests ?? []).map((r) => (r.id === id ? { ...r, status: ok ? ('accepted' as const) : ('declined' as const) } : r)),
        messages: [...s.messages, { id: uid('M'), thread: `ai:${staffId}`, from: staffId, text: reply, at: s.now }],
        notices: [notice({ to: 'leader', kind: 'info', title: `${st.name}さんが${ok ? '依頼を承諾' : '依頼を辞退'}`, body: `${title}（${fmtMD(date)}）`, link: 'plan' }), ...s.notices] };
    });
  }, 2200 + (hash31(staffId) % 5) * 300);
  return id;
}
const hash31 = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
export function publishPlan() {
  set((s) => {
    if (!s.plan || s.plan.status !== 'draft') return {};
    const m = s.plan.month; const end = monthEnd(m);
    const assignments = [...s.assignments.filter((a) => !a.date.startsWith(m)), ...s.plan.draft];
    const fresh = initialVacancies(assignments).filter((v) => v.date.startsWith(m));
    const vacancies = [...s.vacancies.filter((v) => !v.date.startsWith(m) || v.date < s.today), ...fresh.filter((v) => v.date >= s.today && v.date <= end && !s.vacancies.some((x) => x.id === v.id && x.date < s.today))];
    return { assignments, vacancies, plan: { ...s.plan, status: 'published' }, notices: [notice({ to: 'leader', kind: 'shift', title: `${+m.slice(5)}月のシフトを公開しました`, body: '勤務表・日次・月次に反映済みです。', link: 'shift' }), ...s.notices] };
  });
}

// ---- リーダーとシフト作成君のチャット ----
export function askLeaderAI(text: string) {
  if (!text.trim()) return;
  const first = interpretLeader(text, state); const aid = uid('M');
  set((s) => {
    const r = first.unknown ? { ...first, text: '内容を確認しています…', links: undefined, action: undefined } : first;
    const u: ChatMessage = { id: uid('M'), thread: 'ai:leader', from: 'leader', text: text.trim(), at: s.now };
    const a: ChatMessage = { id: aid, thread: 'ai:leader', from: 'ai', text: r.text, at: s.now, links: r.links, action: r.action ? { ...r.action, state: 'proposed' } : undefined };
    return { messages: [...s.messages, u, a] };
  });
  if (!first.unknown) return;
  // ルールで読めない言葉は Gemini に分類してもらい、定型の文に直して同じ提案の流れに乗せる
  const patch = (fn: (m: ChatMessage) => ChatMessage) => set((s) => ({ messages: s.messages.map((m) => (m.id === aid ? fn(m) : m)) }));
  askLeader(text.trim(), state.today).then((i) => {
    const c = leaderSentence(i); const r = c ? interpretLeader(c, state) : null;
    if (r && !r.unknown) patch((m) => ({ ...m, text: r.text, links: r.links, action: r.action ? { ...r.action, state: 'proposed' as const } : undefined }));
    else patch((m) => ({ ...m, text: i.reply || first.text }));
  }).catch((e: Error) => patch((m) => ({ ...m, text: `${e.message}\n\n${first.text}` })));
}
export function cancelLeaderAction(msgId: string) { set((s) => ({ messages: s.messages.map((m) => (m.id === msgId && m.action ? { ...m, action: { ...m.action, state: 'cancelled' as const } } : m)) })); }
export function runLeaderAction(msgId: string) {
  const m = state.messages.find((x) => x.id === msgId); const a = m?.action; if (!a || a.state !== 'proposed') return;
  let result = '実行しました。';
  if (a.kind === 'delegate') { for (const id of a.args.ids as string[]) { const v = state.vacancies.find((x) => x.id === id); if (!v) continue; void delegateAutopilot(id, {}, !(v.auto && v.auto.mode !== 'manual')); } result = '任せました。進み具合は各欠員の画面で確認できます。時間調整の承認や求人の承認が必要になったら、お知らせします。'; }
  else if (a.kind === 'remind') { remindUnsubmitted(); result = '未提出の人に催促を送りました。'; }
  else if (a.kind === 'approveRequests') { for (const id of a.args.ids as string[]) decideRequest(id, true, true); result = '承認しました。欠員が出たものは、シフト作成君に任せています。'; }
  else if (a.kind === 'createPlan') { createPlan(a.args.month as string, { nightMax: a.args.nightMax as number | undefined }); result = 'シフト案を作成しました。「シフト」の「シフト作成」で確認・編集できます。'; }
  else if (a.kind === 'publishPlan') { publishPlan(); result = 'シフトを公開しました。'; }
  set((s) => ({ messages: [...s.messages.map((x) => (x.id === msgId && x.action ? { ...x, action: { ...x.action, state: 'done' as const } } : x)), { id: uid('M'), thread: 'ai:leader', from: 'ai', text: result, at: s.now, links: a.kind === 'createPlan' ? [{ label: 'シフト作成を開く', target: 'plan' }] : undefined }] }));
}
