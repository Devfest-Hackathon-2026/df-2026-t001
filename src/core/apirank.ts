// 欠員の打診の順番を、学習済みの応諾予測（care-solver-api の POST /api/v1/rank-candidates）で並べ直す。
// 画面の rankCandidates が「打診してよい人」を決める（連勤・夜勤明け・スキル不足などはここで変えない）。
// API は、その中の順番を並べ替え、応諾の見込み（0〜1）を添えるだけ。失敗・遅い・形が違うときは null を返し、従来の順番のまま進む。
// 例外: その月の勤務も送り、ソルバーの必須ルールを破る人（hard）は打診の列から外す（apiverify.ts）。
// 送るのは職員ID・役割・雇用形態・スキル・勤務可能帯・所属ユニット・経験年数と、欠員日の前後の勤務だけ（氏名は送らない）。
import type { Candidate } from './roster';
import { requiredSkills } from './roster';
import { STAFF } from './facility';
import { addDays, stampDay } from './dates';
import type { ShiftCode, Vacancy } from './types';
import type { State } from './store';
import { SOLVER } from '../leader/ai/api';
import { monthCells, parseHard, type HardExcluded } from './apiverify';

export interface AiRank { order: string[]; prob: Record<string, number>; hard?: HardExcluded[] }

const TIMEOUT_MS = 3000;
const HOURS: Record<ShiftCode, number> = { 早番: 8, 日勤: 8, 遅番: 8, 夜勤: 13 };

export function aiRankEnabled(): boolean {
  if ((import.meta.env.VITE_AI_RANK as string | undefined) === 'off') return false;
  try { if (localStorage.getItem('care-no-rank') === '1') return false; } catch { /* 読めなくても既定はオン */ }
  return typeof fetch === 'function' && typeof AbortController === 'function';
}

/** API に送る本文（氏名なし） */
export function rankRequest(s: State, v: Vacancy) {
  const lo = addDays(v.date, -7); const hi = addDays(v.date, 2); const lo30 = addDays(v.date, -30); const since14 = addDays(stampDay(s.now), -14);
  const month = v.date.slice(0, 7);
  const absent = s.assignments.find((a) => a.id === v.fromAssignmentId)?.staffId
    ?? s.assignments.find((a) => a.date === v.date && a.shift === v.shift && a.unitId === v.unitId && a.status === 'absent')?.staffId;
  const staff = STAFF.filter((x) => !x.isLeader && x.shifts.length).map((x) => {
    const mine = s.assignments.filter((a) => a.staffId === x.id && a.status !== 'absent' && a.date < v.date);
    return {
      id: x.id, role: x.role, employment: x.employment, skills: [...x.skills], shifts: [...x.shifts], home_unit: x.homeUnit, years: x.years, leave_by: x.leaveBy ?? null,
      month_hours_before: mine.filter((a) => a.date.slice(0, 7) === month).reduce((n, a) => n + HOURS[a.shift], 0),
      nights_last30: mine.filter((a) => a.date >= lo30 && a.shift === '夜勤').length,
      offers_last14: s.vacancies.reduce((n, y) => n + y.offers.filter((o) => o.staffId === x.id && o.at.slice(0, 10) >= since14).length, 0),
    };
  });
  return {
    date: v.date, shift: v.shift, unit_id: v.unitId, absent_staff_id: absent ?? null, need_skills: requiredSkills(s.assignments, v), discovered_at: s.now,
    staff,
    assignments: s.assignments.filter((a) => a.date >= lo && a.date <= hi).map((a) => ({ staff_id: a.staffId, date: a.date, shift: a.shift, status: a.status })),
    avail: Object.entries(s.availability ?? {}).flatMap(([id, xs]) => xs.filter((x) => x.date === v.date).map((x) => ({ staff_id: id, date: x.date, shifts: x.shifts }))),
    ...monthCells(s, v), // その月の勤務 → API がソルバーの必須ルールで候補を確かめる（apiverify.ts）
  };
}

/** 応答の形を厳しく確かめる。合わなければ null（知らない職員IDは無視する） */
export function parseRank(j: unknown): AiRank | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as { model?: unknown; candidates?: unknown };
  if (o.model !== 'champion' || !Array.isArray(o.candidates)) return null;
  const known = new Set(STAFF.map((x) => x.id));
  const order: string[] = []; const prob: Record<string, number> = {};
  for (const c of o.candidates) {
    if (!c || typeof c !== 'object') return null;
    const { staff_id: id, accept_probability: p } = c as { staff_id?: unknown; accept_probability?: unknown };
    if (typeof id !== 'string') return null;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
    if (!known.has(id) || id in prob) continue;
    order.push(id); prob[id] = p;
  }
  return order.length ? { order, prob } : null;
}

/** 1回だけ呼ぶ（再試行なし・3秒で打ち切り）。エラー・タイムアウト・429・5xx はすべて null */
export async function rankViaApi(s: State, v: Vacancy): Promise<AiRank | null> {
  if (!aiRankEnabled()) return null;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${SOLVER}/api/v1/rank-candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rankRequest(s, v)), signal: ctl.signal });
    if (!r.ok) return null;
    const j: unknown = await r.json(); const ai = parseRank(j); const hard = parseHard(j);
    return hard.length ? { ...(ai ?? { order: [], prob: {} }), hard } : ai;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Cloud Run のコールドスタート対策。リーダー画面を開いたときに1回だけ、結果は見ない */
let warmed = false;
export function warmRanker() {
  if (warmed || !aiRankEnabled()) return; warmed = true;
  try { void fetch(`${SOLVER}/api/healthz`, { cache: 'no-store' }).catch(() => { /* 無視 */ }); } catch { /* 無視 */ }
}

/**
 * 打診の列（画面の判定で打診してよい人だけ・画面の優先順）を、API の順番で並べ直す。
 * 「入れる日」に登録していた人を先にする設定（availFirst）は守り、その中・その外それぞれで並べ替える。API が知らない人は後ろ（元の順のまま）。
 */
export function reorderByAi(cands: Candidate[], ai: AiRank | undefined, availFirst: boolean): Candidate[] {
  if (!ai) return cands;
  const pos = new Map(ai.order.map((id, i) => [id, i]));
  const key = (c: Candidate) => pos.get(c.staff.id) ?? Number.MAX_SAFE_INTEGER;
  return cands.map((c, i) => ({ c, i })).sort((a, b) => (availFirst ? (a.c.available ? 0 : 1) - (b.c.available ? 0 : 1) : 0) || key(a.c) - key(b.c) || a.i - b.i).map((x) => x.c);
}
