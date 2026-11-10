// 欠員の候補を、ソルバーの必須ルール（夜勤明けは休み・連勤の上限・公休・遅番→早番・夜勤の上限）で API に確かめてもらう。
// rank-candidates に、その月の勤務（cells: 職員ID → 日ごとの勤務。"" は休み）を添えて送る。氏名は送らない。
// API が「引き受けると必須ルールを破る」と返した人（excluded のうち rule_id があるもの）は、打診の列から外す。
// API が使えないときは何も外さない（画面の判定 rankCandidates がすでに明らかな衝突を止めている）。
import { STAFF, staffById } from './facility';
import { addDays } from './dates';
import type { Vacancy } from './types';
import type { State } from './store';

export interface HardExcluded { staffId: string; reason: string; ruleId: string }

/** rank-candidates に足す本文（その月の勤務・月の日数・1日の曜日・前月末日の勤務） */
export function monthCells(s: State, v: Vacancy) {
  const [y, m] = v.date.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const month = v.date.slice(0, 7);
  const prevLast = addDays(`${month}-01`, -1);
  const ids = new Set(STAFF.filter((x) => !x.isLeader && x.shifts.length).map((x) => x.id));
  const cells: Record<string, string[]> = {};
  const carry_in: Record<string, string> = {};
  for (const id of ids) cells[id] = Array.from({ length: days }, () => '');
  for (const a of s.assignments) {
    if (a.status === 'absent' || !ids.has(a.staffId)) continue;
    if (a.date.slice(0, 7) === month) { const i = Number(a.date.slice(8, 10)) - 1; if (!cells[a.staffId][i]) cells[a.staffId][i] = a.shift; }
    else if (a.date === prevLast) carry_in[a.staffId] = a.shift;
  }
  return { cells, month_days: days, first_weekday: new Date(y, m - 1, 1).getDay(), carry_in };
}

/** 応答の excluded から、必須ルールで外された人だけを取り出す（形が違う行・知らない職員IDは無視） */
export function parseHard(j: unknown): HardExcluded[] {
  const ex = j && typeof j === 'object' ? (j as { excluded?: unknown }).excluded : undefined;
  if (!Array.isArray(ex)) return [];
  const known = new Set(STAFF.map((x) => x.id));
  const out: HardExcluded[] = [];
  for (const e of ex) {
    if (!e || typeof e !== 'object') continue;
    const { staff_id: id, reason, rule_id: rid } = e as { staff_id?: unknown; reason?: unknown; rule_id?: unknown };
    if (typeof id !== 'string' || typeof reason !== 'string' || typeof rid !== 'string' || !known.has(id)) continue;
    if (!out.some((x) => x.staffId === id)) out.push({ staffId: id, reason: reason.slice(0, 80), ruleId: rid });
  }
  return out;
}

/** 欠員のログに出す1行（名前は画面の中だけで使う）。外す人がいなければ undefined */
export function hardLogText(hard: HardExcluded[] | undefined, ids: string[]): string | undefined {
  const hit = (hard ?? []).filter((h) => ids.includes(h.staffId));
  if (!hit.length) return undefined;
  const short = (r: string) => r.replace(/（[^（）]*）$/, ''); // 末尾の補足（デモ用の仮値など）は省く
  return `ソルバーの必須ルールを破るため除外: ${hit.map((h) => `${staffById(h.staffId).name}さん（${short(h.reason)}）`).join('、')}`;
}
