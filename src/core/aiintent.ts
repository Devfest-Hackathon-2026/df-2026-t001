// 言葉の「意図の分類」を Gemini（care-solver-api）に頼む共通部分。Gemini は分類だけで、何も実行しない。
// 返ってきた分類は、画面側の定型の文に直して、既存のルール解釈に通す（承認つきの提案になる）。
import { SOLVER } from '../leader/ai/api';
import { UNITS, STAFF } from './facility';

export class IntentError extends Error {}
const TIMEOUT = 20000;

async function post<T>(path: string, body: unknown): Promise<T> {
  let last: unknown;
  for (let n = 0; n < 2; n++) {                       // 一時的な失敗（503・接続）は1回だけ再試行
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(`${SOLVER}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      if (r.ok) return ((await r.json()) as { intent: T }).intent;
      let m = ''; try { m = ((await r.json()) as { error?: string }).error ?? ''; } catch { /* 本文なし */ }
      if (r.status === 429) throw new IntentError(m || 'AI の利用上限に達しました。しばらくしてからお試しください');
      if (r.status === 400) throw new IntentError(m || '文章を短くして、もう一度お試しください');
      last = new IntentError(m || `AI につながりませんでした（${r.status}）`);
      if (r.status < 500) throw last;
    } catch (e) {
      if (e instanceof IntentError && !(e.message.startsWith('AI につながりませんでした（5'))) throw e;
      last = e instanceof IntentError ? e : new IntentError('AI につながりませんでした。ネットワークを確認して、もう一度お試しください');
    } finally { clearTimeout(timer); }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw last instanceof IntentError ? last : new IntentError('AI につながりませんでした');
}

// ---- シフト作成（人・日付・勤務帯）
export interface PlanOp { intent: string; staff_ids: string[]; date: string | null; shift: string | null; unit_id: string | null }
export interface PlanIntent extends PlanOp { night_max: number | null; reply: string; extra: PlanOp[] }
export const askPlan = (text: string, month: string, today: string) => post<PlanIntent>('/api/v1/plan-intent', { text, month, today, staff: STAFF.filter((x) => x.shifts.length).map((x) => ({ id: x.id, name: x.name })), units: UNITS.map((u) => ({ id: u.id, name: u.name })) });

// ---- リーダー画面のチャット
export interface LeaderIntent { intent: string; date: string | null; shift: string | null; night_max: number | null; reply: string }
export const askLeader = (text: string, today: string) => post<LeaderIntent>('/api/v1/leader-intent', { text, today });
const md = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
export function leaderSentence(i: LeaderIntent): string | null {
  const d = i.date ? md(i.date) : '';
  switch (i.intent) {
    case 'status': return '今日の状況をまとめて';
    case 'vacancies': return d ? `${d}の欠員は？` : '欠員は？';
    case 'candidates': return d && i.shift ? `${d}の${i.shift}に誰が入れる？` : null;
    case 'delegate': return d ? `${d}の欠員を任せて` : '欠員を任せて';
    case 'remind': return '未提出者に催促して';
    case 'approve': return '申請を承認して任せて';
    case 'create_plan': return i.night_max ? '夜勤を減らしてシフトを作って' : 'シフトを作って';
    case 'publish_plan': return 'シフトを公開して';
    case 'health': return '今日体調の悪い人は？';
    default: return null;
  }
}

// ---- 職員画面の申請
export interface EmployeeIntent { kind: string; dates: string[]; shift: string | null; time: string | null; minutes_late: number | null; reason: string | null; break_at: string | null; leave_by: string | null; shift_hope: string[]; reply: string }
export const askEmployee = (text: string, today: string) => post<EmployeeIntent>('/api/v1/employee-intent', { text, today });
export function employeeSentence(i: EmployeeIntent): string | null {
  const ds = i.dates.map(md).join('、'); const sh = i.shift ?? ''; const why = i.reason ? `（${i.reason}）` : '';
  switch (i.kind) {
    case 'off': return `${ds}の${sh}を休みます${why}`;
    case 'dayoff_hope': return `${ds}を休みたい${why}`;
    case 'late': return i.time ? `${ds}は${i.time}に出勤します${why}` : i.minutes_late ? `${ds}は${i.minutes_late}分遅刻します${why}` : null;
    case 'early': return i.time ? `${ds}は${i.time}までに帰ります${why}` : `${ds}は早退します${why}`;
    case 'change': return `${ds}の${sh}を変更したい${why}`;
    case 'avail': return `${ds}の${sh}なら入れます`;
    case 'pref': { const p = [i.break_at && `休憩はいつも${i.break_at}`, i.leave_by && `いつも${i.leave_by}までに帰りたい${why}`, ...i.shift_hope.map((h) => `${h}希望`)].filter(Boolean); return p.length ? p.join('、') : null; }
    default: return null;
  }
}

// ---- 職員の申請文を Gemini に整えてもらう（選択肢だけを送る。失敗・無効のときは null＝画面側の定型文を使う）
export interface ComposeIn { kind: '休み' | '遅刻' | '早退' | 'シフト変更'; date: string; shift: string; reason: string; detail?: string }
export function composeEnabled(): boolean {
  if (import.meta.env?.VITE_AI_COMPOSE === 'off') return false;
  try { if (localStorage.getItem('care-no-compose') === '1') return false; } catch { /* 保存領域なし */ }
  return true;
}
/** 1回だけ・6秒で打ち切る。再試行しない。 */
export async function composeEmployee(b: ComposeIn, signal?: AbortSignal): Promise<string | null> {
  if (!composeEnabled()) return null;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 6000);
  signal?.addEventListener('abort', () => ctl.abort());
  try {
    const r = await fetch(`${SOLVER}/api/v1/employee-compose`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: ctl.signal });
    if (!r.ok) return null;
    const j = (await r.json()) as { text?: string; source?: string };
    return j.source === 'gemini' && j.text ? j.text : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
/** サーバーの起動待ちを減らすための先読み（失敗しても何もしない）。 */
export function warmUpSolver(): void {
  if (!composeEnabled()) return;
  try { void fetch(`${SOLVER}/api/healthz`, { method: 'GET' }).catch(() => undefined); } catch { /* 無視 */ }
}
