// 打診候補の「理由」を、Gemini が1文にする（care-solver-api の POST /api/v1/candidate-reasons）。
// 順番は画面の rankCandidates と学習済みモデルが決める。ここは理由の言い換えだけ。
// 送るのは、欠員の日付・勤務帯・ユニット名・必要スキル名と、候補ごとの「ルールが作った理由の文」（最大6件・30文字まで）だけ。氏名・職員IDは送らない。
// 失敗・遅い・形が違うときは null（画面は今までの理由チップのまま）。例外は投げない。
import type { Candidate } from './roster';
import type { Vacancy } from './types';
import { SKILLS, unitName } from './facility';
import { SOLVER } from '../leader/ai/api';

const TIMEOUT_MS = 4000;
const MAX = 6;

export function aiReasonsEnabled(): boolean {
  if ((import.meta.env?.VITE_AI_REASONS as string | undefined) === 'off') return false;
  try { if (localStorage.getItem('care-no-reasons') === '1') return false; } catch { /* 読めなくても既定はオン */ }
  return typeof fetch === 'function' && typeof AbortController === 'function';
}

export interface ReasonIn { staffId: string; facts: string[]; prob?: number }

export function reasonsRequest(v: Vacancy, cands: ReasonIn[]) {
  return {
    vacancy: { date: v.date, shift: v.shift, unit_label: unitName(v.unitId).slice(0, 20), need_skills_labels: (v.needSkills ?? []).map((k) => (SKILLS as Record<string, { label: string }>)[k]?.label).filter(Boolean).slice(0, 6) },
    candidates: cands.slice(0, MAX).map((c, i) => ({ ref: `c${i + 1}`, facts: c.facts.map((f) => f.trim().slice(0, 30)).filter(Boolean).slice(0, 6), ...(typeof c.prob === 'number' && c.prob >= 0 && c.prob <= 1 ? { prob: c.prob } : {}) })),
  };
}

/** 応答の形を厳しく確かめる。Gemini が書いた分（source='gemini'）だけ { 職員ID: 文 } で返す。なければ null */
export function parseReasons(j: unknown, ids: string[]): Record<string, string> | null {
  if (!j || typeof j !== 'object') return null;
  const items = (j as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const out: Record<string, string> = {};
  for (const it of items) {
    if (!it || typeof it !== 'object') return null;
    const { ref, reason, source } = it as { ref?: unknown; reason?: unknown; source?: unknown };
    if (typeof ref !== 'string' || typeof reason !== 'string' || (source !== 'gemini' && source !== 'template')) return null;
    const m = /^c([1-6])$/.exec(ref); const id = m ? ids[Number(m[1]) - 1] : undefined;
    if (!id || id in out) continue;
    const t = reason.trim();
    if (source === 'gemini' && t && t.length <= 60 && !t.includes('\n')) out[id] = t;
  }
  return Object.keys(out).length ? out : null;
}

/** 1回だけ呼ぶ（再試行なし・4秒で打ち切り）。エラー・タイムアウト・429・5xx は null */
export async function reasonsViaApi(v: Vacancy, cands: ReasonIn[]): Promise<Record<string, string> | null> {
  const use = cands.filter((c) => c.facts.length).slice(0, MAX);
  if (!use.length || !aiReasonsEnabled()) return null;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${SOLVER}/api/v1/candidate-reasons`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reasonsRequest(v, use)), signal: ctl.signal });
    if (!r.ok) return null;
    return parseReasons(await r.json(), use.map((c) => c.staffId));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 打診の列（先頭から最大6人）に、画面のルールが作った理由を添えて呼ぶ。応諾の見込み prob は事実として渡す */
export function reasonsForQueue(v: Vacancy, ranked: Candidate[]): Promise<Record<string, string> | null> {
  const q = v.auto?.queue ?? [];
  const cands: ReasonIn[] = q.slice(0, MAX).flatMap((id) => { const c = ranked.find((x) => x.staff.id === id); return c ? [{ staffId: id, facts: c.reasons, prob: v.auto?.prob?.[id] }] : []; });
  return reasonsViaApi(v, cands);
}
