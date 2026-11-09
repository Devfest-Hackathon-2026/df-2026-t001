import type { Assignment, CoverageIssue, DayRow, ShiftCode, Staff, TaskBlock, TaskKind, Vacancy, SkillId } from './types';
import { DEMO_TODAY, SHIFTS, SHIFT_ORDER, STAFF, UNITS, floorOf, residentsOf, staffById, unitName, SKILLS } from './facility';
import { addDays, daysInRange, dow, fmtMin, toMin } from './dates';
import { eventExtra, eventsOn, holidayOf } from './events';
import type { FacilityEvent } from './events';

export const RANGE_START = '2026-10-26';
export const RANGE_END = '2026-12-31';
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return Math.abs(h); };
const SHIFT_LETTER: Record<ShiftCode, string> = { 早番: 'E', 日勤: 'D', 遅番: 'L', 夜勤: 'N' };
export const vacancyId = (date: string, shift: ShiftCode, unitId: string) => `VAC-${date.replace(/-/g, '')}-${SHIFT_LETTER[shift]}${unitId.slice(1).padStart(2, '0')}`;

export function canWork(s: Staff, shift: ShiftCode): boolean {
  if (!s.shifts.includes(shift)) return false;
  if (shift !== '夜勤' && s.leaveBy && SHIFTS[shift].end > toMin(s.leaveBy)) return false;
  return true;
}

// 初期データで意図的に欠員にする枠（デモ・動作確認用）
const FORCED_VACANT = new Set(['2026-11-22|遅番|U4', '2026-11-25|夜勤|U1', '2026-11-27|早番|U2']);
const FORCED: Assignment[] = [
  { id: 'A-F1', date: '2026-11-18', staffId: 'EMP-017', shift: '夜勤', unitId: 'U3', status: 'assigned', source: 'base' },
  { id: 'A-F2', date: '2026-11-20', staffId: 'EMP-017', shift: '夜勤', unitId: 'U3', status: 'assigned', source: 'base' },
  { id: 'A-F3', date: '2026-11-19', staffId: 'EMP-017', shift: '日勤', unitId: 'U3', status: 'assigned', source: 'base' }, // placeholder, replaced below
];

export interface GenOpts {
  start: string; end: string; history?: Assignment[]; forced?: Assignment[]; forcedVacant?: Set<string>;
  dayOff?: Record<string, string[]>; avail?: Record<string, { date: string; shifts: ShiftCode[] }[]>;
  extra?: (date: string, shift: ShiftCode) => number; nightMax?: number; idPrefix?: string;
}
/** ユニットへの割り当てやすさ（小さいほど良い）。所属ユニットなら 0 */
export const unitFit = (s: Staff, unitId: string) => (s.homeUnit === unitId ? 0 : 4);

/**
 * その日・その勤務帯に入る人（施設全体で決まったもの）を、ユニットに割り当てる。
 * 各ユニット1人を基本に、所属ユニットを優先。夜勤は各フロアに医療的ケアの人を1人以上置く（generateRoster と同じ方針）。
 * ユニット数より多い人は「追加配置」（extra）として所属ユニットに置く。少ないときは、空いたユニットが欠員になる。
 */
export function assignUnits(staffIds: string[], shift: ShiftCode): { staffId: string; unitId: string; extra: boolean }[] {
  const people = staffIds.map(staffById);
  const units = UNITS.map((u) => u.id);
  const pick: (number | null)[] = []; const used = new Set<number>();
  let best: (number | null)[] = []; let bestScore = Infinity;
  const evalPick = () => {
    let sc = 0;
    pick.forEach((i, k) => { sc += i === null ? 1000 : unitFit(people[i], units[k]); });
    if (shift === '夜勤') for (const fl of [1, 2]) if (!pick.some((i, k) => i !== null && floorOf(units[k]) === fl && people[i].skills.includes('medical'))) sc += 100;
    if (sc < bestScore) { bestScore = sc; best = pick.slice(); }
  };
  const rec = (k: number) => {
    if (k === units.length) { evalPick(); return; }
    let any = false;
    for (let i = 0; i < people.length; i++) { if (used.has(i)) continue; any = true; used.add(i); pick.push(i); rec(k + 1); pick.pop(); used.delete(i); }
    if (!any || people.length - used.size < units.length - k) { pick.push(null); rec(k + 1); pick.pop(); }
  };
  rec(0);
  const out: { staffId: string; unitId: string; extra: boolean }[] = [];
  best.forEach((i, k) => { if (i !== null) out.push({ staffId: people[i].id, unitId: units[k], extra: false }); });
  people.forEach((p, i) => { if (!best.includes(i)) out.push({ staffId: p.id, unitId: p.homeUnit, extra: true }); });
  return out;
}

export const generateBaseRoster = () => generateRoster({ start: RANGE_START, end: RANGE_END, forced: FORCED.filter((f) => f.id !== 'A-F3'), forcedVacant: FORCED_VACANT });
export function generateRoster(o: GenOpts): Assignment[] {
  const out: Assignment[] = [];
  const byDate = new Map<string, Assignment[]>();
  const worked = new Map<string, Set<string>>(); // date -> staffIds working that day (any shift)
  const night = new Map<string, Set<string>>(); // date -> staffIds night
  const dates = daysInRange(o.start, o.end);
  const forced = o.forced ?? [];
  const FV = o.forcedVacant ?? new Set<string>();
  let n = 0;
  const put = (a: Omit<Assignment, 'id'>) => { const x = { ...a, id: `${o.idPrefix ?? 'A'}-${String(++n).padStart(5, '0')}` } as Assignment; out.push(x); (byDate.get(a.date) ?? byDate.set(a.date, []).get(a.date)!).push(x); (worked.get(a.date) ?? worked.set(a.date, new Set()).get(a.date)!).add(a.staffId); if (a.shift === '夜勤') (night.get(a.date) ?? night.set(a.date, new Set()).get(a.date)!).add(a.staffId); };
  for (const h of o.history ?? []) { if (h.status === 'absent') continue; (worked.get(h.date) ?? worked.set(h.date, new Set()).get(h.date)!).add(h.staffId); if (h.shift === '夜勤') (night.get(h.date) ?? night.set(h.date, new Set()).get(h.date)!).add(h.staffId); }
  const hasAvail = (id: string, d: string) => !!o.avail?.[id]?.some((x) => x.date === d);
  const recent = (id: string, d: string, days: number) => { let c = 0; for (let i = 1; i <= days; i++) if (worked.get(addDays(d, -i))?.has(id)) c++; return c; };
  const consec = (id: string, d: string) => { let c = 0; for (let i = 1; i <= 6; i++) { if (worked.get(addDays(d, -i))?.has(id) || night.get(addDays(d, -i + 1))?.has(id) && false) c++; else break; } return c; };
  const available = (s: Staff, d: string, shift: ShiftCode) => {
    if (worked.get(d)?.has(s.id)) return false;
    if (o.dayOff?.[s.id]?.includes(d)) return false; // 希望休
    if (shift === '夜勤' && o.nightMax && out.filter((a) => a.staffId === s.id && a.shift === '夜勤').length >= o.nightMax) return false;
    if (night.get(addDays(d, -1))?.has(s.id)) return false; // 夜勤明け
    if (s.isLeader && (dow(d) === 0 || dow(d) === 6)) return false;
    if (!canWork(s, shift)) return false;
    // 夜勤の翌々日までに連続夜勤は最大2回
    if (shift === '夜勤' && night.get(addDays(d, -2))?.has(s.id) && night.get(addDays(d, -4))?.has(s.id)) return false;
    // 翌日が夜勤明け→勤務が詰まらないよう、前日に遅番→当日早番は避ける
    if (shift === '早番' && out.some((a) => a.date === addDays(d, -1) && a.staffId === s.id && a.shift === '遅番')) return false;
    const cap = s.employment === 'パート' ? 3 : 5;
    if (recent(s.id, d, 7) >= cap) return false;
    if (consec(s.id, d) >= 5) return false;
    return true;
  };
  const score = (s: Staff, d: string, shift: ShiftCode, unitId: string, wantMedical = false) =>
    recent(s.id, d, 7) * 10 + unitFit(s, unitId) + (hash(s.id + d + shift) % 5) - (wantMedical && s.skills.includes('medical') ? 8 : 0) + (s.isLeader ? 6 : 0) + (hasAvail(s.id, d) ? 12 : 0);

  for (const d of dates) {
    for (const f of forced.filter((x) => x.date === d)) put({ ...f } as Omit<Assignment, 'id'>);
    // 夜勤：各フロアで医療的ケア可を最低1名
    const nightUnitsOrder = ['U1', 'U3', 'U2', 'U4'];
    for (const u of nightUnitsOrder) {
      if (FV.has(`${d}|夜勤|${u}`)) continue;
      if (byDate.get(d)?.some((a) => a.shift === '夜勤' && a.unitId === u)) continue;
      const floorHasMedical = UNITS.filter((x) => x.floor === floorOf(u)).some((x) => byDate.get(d)?.some((a) => a.shift === '夜勤' && a.unitId === x.id && staffById(a.staffId).skills.includes('medical')));
      const cands = STAFF.filter((s) => available(s, d, '夜勤')).sort((a, b) => score(a, d, '夜勤', u, !floorHasMedical) - score(b, d, '夜勤', u, !floorHasMedical));
      if (cands[0]) put({ date: d, staffId: cands[0].id, shift: '夜勤', unitId: u, status: 'assigned', source: 'base' });
    }
    for (const shift of ['早番', '日勤', '遅番'] as ShiftCode[]) {
      for (const u of UNITS.map((x) => x.id)) {
        if (FV.has(`${d}|${shift}|${u}`)) continue;
        const cands = STAFF.filter((s) => available(s, d, shift)).sort((a, b) => score(a, d, shift, u) - score(b, d, shift, u));
        if (cands[0]) put({ date: d, staffId: cands[0].id, shift, unitId: u, status: 'assigned', source: 'base' });
      }
    }
    // 行事などで必要人数が増える日は、追加の職員を配置する
    for (const shift of SHIFT_ORDER) {
      const ex = o.extra?.(d, shift) ?? 0;
      for (let k = 0; k < ex; k++) {
        const u = UNITS[(k + hash(d)) % UNITS.length].id;
        const cands = STAFF.filter((x) => available(x, d, shift)).sort((a, b) => score(a, d, shift, u) - score(b, d, shift, u));
        if (cands[0]) put({ date: d, staffId: cands[0].id, shift, unitId: u, status: 'assigned', source: 'base', note: '行事対応の追加配置' });
      }
    }
  }
  return out;
}

export function activeAssignments(all: Assignment[], date: string) {
  return all.filter((a) => a.date === date);
}

/** 欠員枠（割当なし or 欠勤）を列挙 */
export function vacantSlots(all: Assignment[], date: string): { shift: ShiftCode; unitId: string; fromAssignmentId?: string; reason: string }[] {
  const out: { shift: ShiftCode; unitId: string; fromAssignmentId?: string; reason: string }[] = [];
  for (const shift of SHIFT_ORDER) for (const u of UNITS) {
    const as = all.filter((a) => a.date === date && a.shift === shift && a.unitId === u.id);
    if (as.some((a) => a.status !== 'absent' || a.covered)) continue;
    const absent = as.find((a) => a.status === 'absent');
    out.push({ shift, unitId: u.id, fromAssignmentId: absent?.id, reason: absent ? `${staffById(absent.staffId).name}さんの休み` : '配置不足（月次案で埋まらず）' });
  }
  return out;
}

export function needSkillsFor(all: Assignment[], date: string, shift: ShiftCode, unitId: string): SkillId[] {
  if (shift !== '夜勤') return [];
  const fl = floorOf(unitId);
  const others = all.filter((a) => a.date === date && a.shift === '夜勤' && a.status !== 'absent' && floorOf(a.unitId) === fl && a.unitId !== unitId);
  return others.some((a) => staffById(a.staffId).skills.includes('medical')) ? [] : ['medical'];
}

export function initialVacancies(all: Assignment[]): Vacancy[] {
  const out: Vacancy[] = [];
  for (const d of daysInRange(DEMO_TODAY, addDays(DEMO_TODAY, 28))) for (const v of vacantSlots(all, d)) {
    out.push({ id: vacancyId(d, v.shift, v.unitId), date: d, shift: v.shift, unitId: v.unitId, needSkills: needSkillsFor(all, d, v.shift, v.unitId), reason: v.reason, state: 'open', offers: [], fromAssignmentId: v.fromAssignmentId });
  }
  return out;
}

// ---------- 1日の業務ブロック ----------
type W = [string, string, TaskKind, string];
const TPL: Record<ShiftCode, (v: number) => W[]> = {
  早番: (v) => [
    ['07:00', '07:30', 'handover', '夜勤からの引き継ぎ'],
    ...(v === 0
      ? ([['07:30', '08:15', 'wake', '起床・整容'], ['08:15', '09:15', 'meal', '朝食介助']] as W[])
      : ([['07:30', '09:00', 'meal', '朝食介助'], ['09:00', '09:30', 'excretion', '排泄介助']] as W[])),
    ...(v === 0
      ? ([['09:15', '09:30', 'laundry', '食堂の環境整備'], ['09:30', '11:30', 'bath', '入浴介助']] as W[])
      : ([['09:30', '10:30', 'excretion', '排泄介助'], ['10:30', '11:30', 'rec', 'レク・機能訓練']] as W[])),
    ['11:30', '12:30', 'meal', '昼食介助'], ['12:30', '13:30', 'med', '配薬・服薬確認'], ['13:30', '14:30', 'excretion', '排泄介助'],
    ['14:30', '15:30', 'record', '介護記録'], ['15:30', '16:00', 'handover', '遅番・日勤への引き継ぎ'],
  ],
  日勤: (v) => [
    ['09:00', '10:00', 'excretion', '排泄介助'],
    ...(v === 0 ? ([['10:00', '11:30', 'bath', '入浴介助']] as W[]) : ([['10:00', '11:30', 'rec', 'レク・機能訓練']] as W[])),
    ['11:30', '12:30', 'meal', '昼食介助'], ['12:30', '13:00', 'med', '配薬・服薬確認'],
    ...(v === 0 ? ([['13:00', '14:30', 'rec', 'レク・機能訓練']] as W[]) : ([['13:00', '14:30', 'bath', '入浴介助']] as W[])),
    ['14:30', '15:30', 'record', '介護記録'], ['15:30', '16:30', 'excretion', '排泄介助'],
    ['16:30', '17:30', 'laundry', '夕食前の環境整備'], ['17:30', '18:00', 'meal', '夕食介助'],
  ],
  遅番: (v) => [
    ['12:00', '12:15', 'handover', '早番からの引き継ぎ'], ['12:15', '13:00', 'laundry', '食器・環境整備'],
    ...(v === 0 ? ([['13:00', '14:30', 'bath', '入浴介助']] as W[]) : ([['13:00', '14:30', 'rec', 'レク・機能訓練']] as W[])),
    ['14:30', '15:30', 'record', '介護記録'], ['15:30', '16:30', 'excretion', '排泄介助'], ['16:30', '17:30', 'med', '配薬・服薬確認'],
    ['17:30', '19:00', 'meal', '夕食介助'], ['19:00', '19:30', 'excretion', '排泄介助'], ['19:30', '20:45', 'bed', '就寝介助'], ['20:45', '21:00', 'handover', '夜勤への引き継ぎ'],
  ],
  夜勤: () => [
    ['16:30', '17:00', 'handover', '遅番・日勤からの引き継ぎ'], ['17:00', '17:30', 'med', '配薬・服薬確認'], ['17:30', '19:00', 'meal', '夕食介助'],
    ['19:00', '21:00', 'bed', '就寝介助'], ['21:00', '22:00', 'record', '介護記録'],
  ],
};

function nightFill(start: number, end: number): TaskBlock[] {
  const out: TaskBlock[] = []; let t = start; let i = 0;
  const cyc: [number, TaskKind, string][] = [[60, 'round', '巡回'], [30, 'excretion', '体位変換・排泄介助'], [30, 'watch', '見守り・待機']];
  while (t < end) { const [len, kind, label] = cyc[i % 3]; const e = Math.min(end, t + len); out.push({ start: t, end: e, kind, label }); t = e; i++; }
  return out;
}

function cut(blocks: TaskBlock[], from: number, to: number, kind: TaskKind, label: string): TaskBlock[] {
  const out: TaskBlock[] = [];
  for (const b of blocks) {
    if (b.end <= from || b.start >= to) { out.push(b); continue; }
    if (b.start < from) out.push({ ...b, end: from });
    if (b.end > to) out.push({ ...b, start: to });
  }
  out.push({ start: from, end: to, kind, label });
  return out.sort((a, b) => a.start - b.start);
}

function breakStart(s: Staff, shift: ShiftCode, unitId: string, nightRank: number): number {
  const ui = UNITS.findIndex((u) => u.id === unitId);
  if (shift === '早番') return toMin('12:30') + 60 * (ui % 2);
  if (shift === '日勤') return toMin('13:30') - 60 * (ui % 2);
  if (shift === '遅番') return toMin('15:00') + 60 * (ui % 2);
  // 夜勤の仮眠：同一フロアで時間をずらす。希望があれば優先
  const pref = s.breakPref ? toMin(s.breakPref.slice(0, 5)) : null;
  if (pref !== null) return 1440 + pref - 30;
  return nightRank === 0 ? 1440 - 60 : 1440 + toMin('02:30');
}

export function buildBlocks(a: Assignment, s: Staff, nightRank = 0, offset = 0): TaskBlock[] {
  const def = SHIFTS[a.shift];
  const v = hash(s.id + a.date) % 2;
  let blocks: TaskBlock[] = TPL[a.shift](v).map(([f, t, kind, label]) => ({ start: toMin(f), end: toMin(t), kind, label, unitId: a.unitId }));
  if (a.shift === '夜勤') {
    const nap = a.adjust?.breakAt ?? breakStart(s, '夜勤', a.unitId, nightRank);
    blocks = blocks.concat(nightFill(22 * 60, 1440 + 6 * 60).map((b) => ({ ...b, unitId: a.unitId })));
    blocks = blocks.concat([
      { start: 1440 + 6 * 60, end: 1440 + 7 * 60, kind: 'wake', label: '起床・整容', unitId: a.unitId },
      { start: 1440 + 7 * 60, end: 1440 + 7 * 60 + 30, kind: 'handover', label: '早番への引き継ぎ', unitId: a.unitId },
      { start: 1440 + 7 * 60 + 30, end: 1440 + 9 * 60, kind: 'meal', label: '朝食介助', unitId: a.unitId },
      { start: 1440 + 9 * 60, end: def.end, kind: 'record', label: '記録・終業', unitId: a.unitId },
    ]).sort((x, y) => x.start - y.start);
    blocks = cut(blocks, nap, nap + def.breakMin, 'nap', '仮眠休憩');
    blocks[blocks.findIndex((b) => b.kind === 'nap')].unitId = a.unitId;
  } else {
    const bs = a.adjust?.breakAt ?? breakStart(s, a.shift, a.unitId, 0);
    blocks = cut(blocks, bs, bs + def.breakMin, 'break', '休憩');
  }
  if (a.adjust?.startAt != null && a.adjust.startAt < def.start) blocks = [{ start: a.adjust.startAt, end: def.start, kind: 'watch', label: '早出（応援）', unitId: a.unitId }, ...blocks];
  if (a.adjust?.endAt != null && a.adjust.endAt > def.end) blocks = [...blocks, { start: def.end, end: a.adjust.endAt, kind: 'watch', label: '延長（応援）', unitId: a.unitId }];
  for (const sw of a.adjust?.swaps ?? []) { const x = blocks.find((b) => b.start === sw.from); const y = blocks.find((b) => b.start === sw.to); if (x && y) { const kx = { kind: x.kind, label: x.label }; x.kind = y.kind; x.label = y.label; y.kind = kx.kind; y.label = kx.label; } }
  if (a.adjust?.support) { const sp = a.adjust.support; const out: TaskBlock[] = []; for (const b of blocks) { if (b.end <= sp.from || b.start >= sp.to || b.kind === 'break' || b.kind === 'nap') { out.push(b); continue; } if (b.start < sp.from) out.push({ ...b, end: sp.from }); out.push({ ...b, start: Math.max(b.start, sp.from), end: Math.min(b.end, sp.to), unitId: sp.unitId, label: `応援：${b.label}` }); if (b.end > sp.to) out.push({ ...b, start: sp.to }); } blocks = out; }
  if (a.status === 'late' && a.lateMin) blocks = blocks.filter((b) => b.end > def.start + a.lateMin!).map((b) => (b.start < def.start + a.lateMin! ? { ...b, start: def.start + a.lateMin! } : b));
  if (a.status === 'early' && a.earlyAt) { let e = toMin(a.earlyAt); if (a.shift === '夜勤' && e < 12 * 60) e += 1440; blocks = blocks.filter((b) => b.start < e).map((b) => (b.end > e ? { ...b, end: e } : b)); }
  return offset ? blocks.map((b) => ({ ...b, start: b.start + offset, end: b.end + offset })) : blocks;
}

export function buildDay(all: Assignment[], date: string): DayRow[] {
  const today = all.filter((a) => a.date === date);
  const prev = all.filter((a) => a.date === addDays(date, -1) && a.shift === '夜勤');
  const rows: DayRow[] = [];
  const rankOf = (a: Assignment, group: Assignment[]) => { const fl = floorOf(a.unitId); const same = group.filter((x) => x.shift === '夜勤' && floorOf(x.unitId) === fl && x.status !== 'absent'); const sorted = same.slice().sort((x, y) => (staffById(x.staffId).breakPref ? 1 : 0) - (staffById(y.staffId).breakPref ? 1 : 0) || x.unitId.localeCompare(y.unitId)); return Math.max(0, sorted.findIndex((x) => x.id === a.id)); };
  for (const a of today) { const s = staffById(a.staffId); rows.push({ staff: s, assignment: a, blocks: a.status === 'absent' ? [] : buildBlocks(a, s, a.shift === '夜勤' ? rankOf(a, today) : 0) }); }
  for (const a of prev) { const s = staffById(a.staffId); if (a.status === 'absent') continue; const bl = buildBlocks(a, s, rankOf(a, prev)).map((b) => ({ ...b, start: b.start - 1440, end: b.end - 1440 })).filter((b) => b.end > 0).map((b) => (b.start < 0 ? { ...b, start: 0 } : b)); rows.push({ staff: s, assignment: a, blocks: bl, tail: true }); }
  const order = (r: DayRow) => (r.tail ? -1 : SHIFT_ORDER.indexOf(r.assignment.shift)) * 10 + UNITS.findIndex((u) => u.id === r.assignment.unitId);
  return rows.sort((x, y) => order(x) - order(y));
}

const isWork = (k: TaskKind) => k !== 'break' && k !== 'nap';
const PEAKS: [number, number][] = [[toMin('07:45'), toMin('08:45')], [toMin('11:45'), toMin('12:30')], [toMin('17:30'), toMin('18:30')]];

export function coverage(rows: DayRow[], step = 15, opts: { ignoreBreaks?: boolean } = {}): CoverageIssue[] {
  const issues: CoverageIssue[] = [];
  const push = (t: number, scope: string, kind: 'headcount' | 'skill', need: number, have: number, text: string) => {
    const last = issues[issues.length - 1 > -1 ? issues.length - 1 : 0];
    const prev = issues.find((i) => i.scope === scope && i.kind === kind && i.t1 === t && i.need === need && i.have === have);
    if (prev) prev.t1 = t + step; else issues.push({ t0: t, t1: t + step, scope, need, have, kind, text });
    void last;
  };
  const active = rows.filter((r) => r.assignment.status !== 'absent');
  for (let t = 0; t < 1440; t += step) {
    const on = (r: DayRow) => r.blocks.find((b) => t >= b.start && t < b.end);
    const unitAt = (r: DayRow) => on(r)?.unitId ?? r.assignment.unitId;
    const working = active.filter((r) => { const b = on(r); return b && (opts.ignoreBreaks || isWork(b.kind)); });
    if (t >= 420 && t < 1260) {
      for (const u of UNITS) {
        const have = working.filter((r) => unitAt(r) === u.id).length;
        const need = PEAKS.some(([a, b]) => t >= a && t < b) ? 2 : 1;
        if (have < need) push(t, u.name, 'headcount', need, have, `${u.name}の対応人数が不足`);
      }
    } else if (t >= 1260 || t < 420) {
      for (const fl of [1, 2]) {
        const have = working.filter((r) => floorOf(unitAt(r)) === fl).length;
        if (have < 1) push(t, `${fl}階`, 'headcount', 1, have, `${fl}階の夜間対応者がいない`);
      }
    }
  }
  // 医療的ケア：夜間は各階に1名、食事時間帯は施設で1名
  for (const fl of [1, 2]) {
    const has = active.some((r) => !r.tail && r.assignment.shift === '夜勤' && floorOf(r.assignment.unitId) === fl && r.staff.skills.includes('medical'));
    if (!has) issues.push({ t0: 1260, t1: 1440, scope: `${fl}階`, need: 1, have: 0, kind: 'skill', text: `${fl}階の夜間に医療的ケア可の職員がいない` });
  }
  return issues.sort((a, b) => a.t0 - b.t0);
}

export interface DaySummary {
  eventShort: number; events: FacilityEvent[]; holiday?: string;
  date: string; level: 'ok' | 'warn' | 'short';
  byShift: Record<ShiftCode, { need: number; have: number; absent: number }>;
  vacant: number; issues: CoverageIssue[]; staffCount: number;
}
export function summarizeDay(all: Assignment[], date: string, events: FacilityEvent[] = []): DaySummary {
  const ex = eventExtra(events, date); let eventShort = 0;
  const byShift = {} as DaySummary['byShift'];
  let vacant = 0; let staffCount = 0;
  for (const sh of SHIFT_ORDER) {
    const as = all.filter((a) => a.date === date && a.shift === sh);
    const have = as.filter((a) => a.status !== 'absent' || a.covered).length;
    byShift[sh] = { need: UNITS.length + ex[sh], have, absent: as.filter((a) => a.status === 'absent').length };
    eventShort += Math.max(0, ex[sh] - Math.max(0, have - UNITS.length));
    vacant += Math.max(0, UNITS.length - have); staffCount += have;
  }
  const issues = coverage(buildDay(all, date));
  const level = vacant > 0 ? 'short' : issues.length || eventShort > 0 ? 'warn' : 'ok';
  return { date, level, byShift, vacant, issues, staffCount, eventShort, events: eventsOn(events, date), holiday: holidayOf(date) };
}

export function weeklyCount(all: Assignment[], staffId: string, date: string) {
  const d0 = addDays(date, -dow(date)); // 日曜起点
  return all.filter((a) => a.staffId === staffId && a.status !== 'absent' && a.date >= d0 && a.date <= addDays(d0, 6)).length;
}

function laborBlock(all: Assignment[], s: Staff, date: string, shift: ShiftCode): string | undefined {
  const mine = all.filter((a) => a.staffId === s.id && a.status !== 'absent');
  const has = (d: string) => mine.some((a) => a.date === d) || mine.some((a) => a.shift === '夜勤' && addDays(a.date, 1) === d);
  let before = 0; for (let i = 1; i <= 6; i++) { if (has(addDays(date, -i))) before++; else break; }
  let after = 0; for (let i = 1; i <= 6; i++) { if (has(addDays(date, i))) after++; else break; }
  if (before + after + 1 > 5) return `${before + after + 1}連勤になる`;
  const prev = mine.find((a) => a.date === addDays(date, -1) && a.shift !== '夜勤');
  if (prev) { const gap = (1440 + SHIFTS[shift].start - SHIFTS[prev.shift].end) / 60; if (gap < 11) return `前日${prev.shift}との間隔が${gap}時間（11時間未満）`; }
  const next = mine.find((a) => a.date === addDays(date, 1));
  if (next && shift !== '夜勤') { const gap = (1440 + SHIFTS[next.shift].start - SHIFTS[shift].end) / 60; if (gap < 11) return `翌日${next.shift}との間隔が${gap}時間（11時間未満）`; }
  return undefined;
}

// ---------- 「現場は回るか」の評価 ----------
const MEANINGFUL: SkillId[] = ['medical', 'dementia', 'bath', 'swallow', 'terminal'];
const absentOf = (all: Assignment[], v: Vacancy) => all.find((a) => a.id === v.fromAssignmentId);
const absentSkills = (all: Assignment[], v: Vacancy): SkillId[] => { const a = absentOf(all, v); return a ? staffById(a.staffId).skills : []; };

/** 現場で不足するスキル：休む人が持っていて、同じユニット（夜勤は同じ階の夜勤）に他に持つ人がいないもの＋医療的ケアの階ルール */
export function requiredSkills(all: Assignment[], v: Vacancy): SkillId[] {
  const req = new Set<SkillId>(v.needSkills);
  const active = all.filter((a) => a.date === v.date && a.status !== 'absent' && a.id !== v.fromAssignmentId);
  // 医療的ケアは「同じユニット（夜勤は同じ階の夜勤）」で不足するかを見る。その他は同じ勤務帯の施設全体で誰も持たなくなる場合だけ必須にする
  const medScope = active.filter((a) => (v.shift === '夜勤' ? a.shift === '夜勤' && floorOf(a.unitId) === floorOf(v.unitId) : a.unitId === v.unitId));
  const shiftScope = active.filter((a) => a.shift === v.shift);
  for (const k of absentSkills(all, v).filter((x) => MEANINGFUL.includes(x))) {
    const scope = k === 'medical' ? medScope : shiftScope;
    if (!scope.some((a) => staffById(a.staffId).skills.includes(k))) req.add(k);
  }
  return [...req];
}

export interface Check { key: 'headcount' | 'skill' | 'rest' | 'labor'; ok: boolean; text: string }
export interface Assessment { ok: boolean; checks: Check[]; required: SkillId[]; shared: SkillId[]; after: Assignment[]; fixed: CoverageIssue[]; remaining: CoverageIssue[]; reasonsNg: string[] }
const scopeMatch = (v: Vacancy) => (i: CoverageIssue) => i.scope === unitName(v.unitId) || (v.shift === '夜勤' && i.scope === `${floorOf(v.unitId)}階`);
const sameIssue = (a: CoverageIssue, b: CoverageIssue) => a.scope === b.scope && a.kind === b.kind && a.t0 === b.t0;

/** 候補が入った場合の「人数・スキル・休憩の交代・前後の勤務」を、入る前と比べて評価する */
export function assessCandidate(all: Assignment[], v: Vacancy, s: Staff, required = requiredSkills(all, v)): Assessment {
  const cand: Assignment = { id: 'PREVIEW', date: v.date, staffId: s.id, shift: v.shift, unitId: v.unitId, status: 'assigned' };
  const after = [...all, cand];
  const days = v.shift === '夜勤' ? [v.date, addDays(v.date, 1)] : [v.date];
  const issues = (list: Assignment[], o?: { ignoreBreaks?: boolean }) => days.flatMap((d) => coverage(buildDay(list, d), 15, o)).filter(scopeMatch(v));
  const before = issues(all); const aft = issues(after); const aftNoBreak = issues(after, { ignoreBreaks: true });
  const fixed = before.filter((b) => !aft.some((x) => sameIssue(x, b)));
  const head = aft.filter((i) => i.kind === 'headcount'); const skillIss = aft.filter((i) => i.kind === 'skill');
  const restIssues = head.filter((i) => !aftNoBreak.some((x) => sameIssue(x, i)));
  const unit = v.shift === '夜勤' ? `${floorOf(v.unitId)}階` : unitName(v.unitId);
  const have = required.filter((k) => s.skills.includes(k));
  const checks: Check[] = [
    { key: 'headcount', ok: head.length - restIssues.length === 0, text: head.length - restIssues.length === 0 ? (fixed.some((i) => i.kind === 'headcount') ? `${unit}の対応人数：不足が解消します` : `${unit}の対応人数：問題なし`) : `${unit}の対応人数：${issueTime(head.filter((i) => !restIssues.includes(i))[0])}がまだ不足` },
    { key: 'skill', ok: required.every((k) => s.skills.includes(k)) && skillIss.length === 0, text: required.length ? (required.every((k) => s.skills.includes(k)) && skillIss.length === 0 ? `必須スキル（${required.map((k) => SKILLS[k].label).join('・')}）：保有` : `必須スキル（${required.filter((k) => !s.skills.includes(k)).map((k) => SKILLS[k].label).join('・') || required.map((k) => SKILLS[k].label).join('・')}）が不足`) : '必須スキル：他の職員が保有（条件なし）' },
    { key: 'rest', ok: restIssues.length === 0, text: restIssues.length === 0 ? '休憩・仮眠の交代：成立' : `休憩・仮眠が重なり${issueTime(restIssues[0])}に手薄` },
    { key: 'labor', ok: !laborBlock(all, s, v.date, v.shift), text: laborBlock(all, s, v.date, v.shift) ?? '連勤・勤務間隔・夜勤明け：問題なし' },
  ];
  const shared = absentSkills(all, v).filter((k) => s.skills.includes(k));
  return { ok: checks.every((c) => c.ok), checks, required, shared, after, fixed, remaining: aft, reasonsNg: checks.filter((c) => !c.ok).map((c) => c.text) };
}

export interface Candidate { staff: Staff; score: number; reasons: string[]; blocked?: string; unfit?: string[]; assess?: Assessment; available?: boolean }
export type Availability = Record<string, { date: string; shifts: ShiftCode[] }[]>;
export const availFor = (avail: Availability | undefined, staffId: string, date: string, shift: ShiftCode) => (avail?.[staffId] ?? []).find((x) => x.date === date && (x.shifts.length === 0 || x.shifts.includes(shift)));
export interface RankOpts { availBonus?: number; skillMult?: number; daysMult?: number; fair?: Record<string, number> }
export function rankCandidates(all: Assignment[], v: Vacancy, hopes: Record<string, ShiftCode[]> = {}, avail?: Availability, w: RankOpts = {}): Candidate[] {
  const AB = w.availBonus ?? 60; const SM = w.skillMult ?? 1; const DM = w.daysMult ?? 1;
  const res: Candidate[] = [];
  const required = requiredSkills(all, v);
  for (const s of STAFF) {
    if (s.isLeader) continue;
    const reasons: string[] = []; let score = 50; let blocked: string | undefined;
    const mine = all.filter((a) => a.staffId === s.id);
    if (mine.some((a) => a.date === v.date && a.status === 'absent')) blocked = '本人が休みの連絡済み';
    else if (mine.some((a) => a.date === v.date && a.status !== 'absent')) blocked = '当日は別の勤務あり';
    else if (mine.some((a) => a.date === addDays(v.date, -1) && a.shift === '夜勤' && a.status !== 'absent')) blocked = '前日夜勤のため夜勤明け';
    else if (v.shift === '夜勤' && mine.some((a) => a.date === addDays(v.date, 1) && a.status !== 'absent' && a.shift !== '夜勤')) blocked = '翌日に日中勤務あり（連続で負担大）';
    else if (!canWork(s, v.shift)) blocked = s.leaveBy && v.shift !== '夜勤' ? `退勤上限${s.leaveBy}のため不可` : `${v.shift}は不可`;
    else if (weeklyCount(all, s.id, v.date) >= (s.employment === 'パート' ? 3 : 5)) blocked = '週の勤務上限に達している';
    else if (laborBlock(all, s, v.date, v.shift)) blocked = laborBlock(all, s, v.date, v.shift);
    if (blocked) { res.push({ staff: s, score: 0, reasons: [], blocked }); continue; }
    const as = assessCandidate(all, v, s, required);
    reasons.push('当日の勤務なし（空き）');
    const av = availFor(avail, s.id, v.date, v.shift);
    if (av) { reasons.unshift(`希望提出で「入れる日」に登録済み（${v.shift}）`); score += AB; }
    if (required.length && required.every((k) => s.skills.includes(k))) { reasons.push(`現場で不足するスキルを保有（${required.map((k) => SKILLS[k].label).join('・')}）`); score += 20 * SM; }
    if (as.shared.length) { reasons.push(`欠勤者と共通のスキル：${as.shared.slice(0, 3).map((k) => SKILLS[k].label).join('・')}`); score += as.shared.length * 5 * SM; }
    if (as.fixed.length) { reasons.push('入ると不足が解消'); score += 10; }
    if ((hopes[s.id] ?? []).includes(v.shift)) { reasons.push(`過去に${v.shift}希望あり`); score += 25; }
    if (s.homeUnit === v.unitId) { reasons.push(`${unitName(v.unitId)}の経験あり`); score += 12; }
    const wk = weeklyCount(all, s.id, v.date);
    if (wk <= 3) { reasons.push(`今週の勤務は${wk}日（余裕あり）`); score += 10 * DM; } else score -= wk * 2 * DM;
    if (s.skills.includes('follow')) score += 3;
    if (w.fair?.[s.id]) { score -= w.fair[s.id] * 8; reasons.push(`直近で補欠として${w.fair[s.id]}回出勤（公平に回すため順位を調整）`); }
    res.push({ staff: s, score, reasons, assess: as, unfit: as.ok ? undefined : as.reasonsNg, available: !!av });
  }
  return res.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || (a.unfit ? 1 : 0) - (b.unfit ? 1 : 0) || b.score - a.score);
}

/** 同じスキルを持つ人は、その日どうなっているか */
export interface Holder { staff: Staff; status: 'absent' | 'working' | 'free' | 'blocked'; text: string }
export function skillSituation(all: Assignment[], v: Vacancy, ranked: Candidate[]): { skill: SkillId; required: boolean; holders: Holder[]; onDuty: number }[] {
  const req = requiredSkills(all, v);
  const skills = Array.from(new Set<SkillId>([...req, ...absentSkills(all, v).filter((k) => MEANINGFUL.includes(k))]));
  return skills.map((skill) => {
    const holders: Holder[] = STAFF.filter((x) => !x.isLeader && x.shifts.length && x.skills.includes(skill)).map((x) => {
      const a = all.find((y) => y.date === v.date && y.staffId === x.id);
      if (a?.status === 'absent') return { staff: x, status: 'absent' as const, text: '休み' };
      if (a) return { staff: x, status: 'working' as const, text: `${a.shift}・${unitName(a.unitId)}` };
      const c = ranked.find((y) => y.staff.id === x.id);
      if (c?.blocked) return { staff: x, status: 'blocked' as const, text: `空きだが打診不可（${c.blocked}）` };
      if (c?.unfit) return { staff: x, status: 'blocked' as const, text: '空きだが、人数・スキルの条件に合わない' };
      return { staff: x, status: 'free' as const, text: '空き（打診できる）' };
    });
    return { skill, required: req.includes(skill), holders, onDuty: holders.filter((h) => h.status === 'working').length };
  });
}

export const issueTime = (i: CoverageIssue) => `${fmtMin(i.t0)}〜${fmtMin(i.t1)}`;


// ---------- 勤務中の人の時間をずらして対応する調整案 ----------
export interface AdjustChange { assignmentId: string; staffId: string; adjust: NonNullable<Assignment['adjust']>; text: string }
export interface AdjustPlan { id: string; kind: 'break' | 'support' | 'extend' | 'swap' | 'combo'; title: string; summary: string; changes: AdjustChange[]; resolves: boolean; remaining: CoverageIssue[]; before: CoverageIssue[]; affected: string[]; caution?: string }
export const applyAdjust = (all: Assignment[], changes: AdjustChange[]): Assignment[] => all.map((a) => { const c = changes.find((x) => x.assignmentId === a.id); return c ? { ...a, adjust: { ...a.adjust, ...c.adjust } } : a; });

export function proposeAdjustments(all: Assignment[], v: Vacancy, allowed?: AdjustPlan['kind'][]): AdjustPlan[] {
  const ok = (k: AdjustPlan['kind']) => !allowed || allowed.includes(k);
  const days = v.shift === '夜勤' ? [v.date, addDays(v.date, 1)] : [v.date];
  const issuesOf = (list: Assignment[], scoped = true) => days.flatMap((d) => coverage(buildDay(list, d))).filter((i) => !scoped || scopeMatch(v)(i));
  const before = issuesOf(all).filter((i) => i.kind === 'headcount');
  if (!before.length) return [];
  const total0 = issuesOf(all, false).length;
  const win = { t0: Math.min(...before.map((i) => i.t0)), t1: Math.max(...before.map((i) => i.t1)) };
  const unitStaff = all.filter((a) => a.date === v.date && a.status !== 'absent' && !a.covered && (v.shift === '夜勤' ? a.shift === '夜勤' && floorOf(a.unitId) === floorOf(v.unitId) : a.unitId === v.unitId));
  const nm = (id: string) => staffById(id).name;
  const mk = (kind: AdjustPlan['kind'], title: string, summary: string, changes: AdjustChange[], caution?: string): AdjustPlan => {
    const list = applyAdjust(all, changes); const rem = issuesOf(list); const remHead = rem.filter((i) => i.kind === 'headcount');
    return { id: `${kind}:${v.id}`, kind, title, summary, changes, resolves: remHead.length === 0 && issuesOf(list, false).length <= total0 - before.length + (rem.length - remHead.length), remaining: remHead, before, affected: Array.from(new Set(changes.map((c) => c.staffId))), caution };
  };
  const plans: AdjustPlan[] = [];
  const breakOf = (a: Assignment) => buildBlocks(a, staffById(a.staffId), 0).find((b) => b.kind === 'break' || b.kind === 'nap');

  // A 休憩・仮眠をずらす
  { let cur = all; const ch: AdjustChange[] = [];
    for (const a of unitStaff) { const b = breakOf(a); if (!b || b.end <= win.t0 || b.start >= win.t1) continue;
      const def = SHIFTS[a.shift]; let best: number | undefined; let bestN = issuesOf(cur).length; const lo = a.shift === '夜勤' ? 22 * 60 : def.start + 120; const hi = a.shift === '夜勤' ? 1440 + 4 * 60 : def.end - 120 - def.breakMin;
      for (let t = lo; t <= hi; t += 30) { if (t === b.start) continue; const n = issuesOf(applyAdjust(cur, [{ assignmentId: a.id, staffId: a.staffId, adjust: { breakAt: t }, text: '' }])).length; if (n < bestN || (n === bestN && best !== undefined && Math.abs(t - b.start) < Math.abs(best - b.start))) { best = t; bestN = n; } }
      if (best !== undefined) { const c = { assignmentId: a.id, staffId: a.staffId, adjust: { breakAt: best }, text: `${nm(a.staffId)}さんの${b.kind === 'nap' ? '仮眠' : '休憩'}を ${fmtMin(b.start)} → ${fmtMin(best)} にずらす` }; ch.push(c); cur = applyAdjust(cur, [c]); } }
    if (ch.length && ok('break')) plans.push(mk('break', '休憩・仮眠の時間をずらす', '手薄になる時間に重なる休憩を、前後にずらして人数を確保します。', ch, v.shift === '夜勤' ? '夜間は仮眠の交代が成立する範囲で調整しています' : undefined)); }

  // B 他ユニットの余裕のある職員が一時応援
  if (v.shift !== '夜勤') {
    const donors = all.filter((a) => a.date === v.date && a.status !== 'absent' && !a.covered && a.shift !== '夜勤' && a.unitId !== v.unitId && SHIFTS[a.shift].start <= win.t0 && SHIFTS[a.shift].end >= win.t1);
    let best: { a: Assignment; n: number } | undefined;
    for (const a of donors) { const ch: AdjustChange = { assignmentId: a.id, staffId: a.staffId, adjust: { support: { unitId: v.unitId, from: win.t0, to: win.t1 } }, text: '' }; const list = applyAdjust(all, [ch]); const n = issuesOf(list, false).length; if (!best || n < best.n) best = { a, n }; }
    if (best && best.n < total0 && ok('support')) { const a = best.a; plans.push(mk('support', `${unitName(a.unitId)}から一時応援に入る`, '人数に余裕のある時間帯だけ、別ユニットの職員が応援します。応援元の人数も確認済みです。', [{ assignmentId: a.id, staffId: a.staffId, adjust: { support: { unitId: v.unitId, from: win.t0, to: win.t1 } }, text: `${nm(a.staffId)}さん（${unitName(a.unitId)}）が ${fmtMin(win.t0)}〜${fmtMin(win.t1)} だけ${unitName(v.unitId)}を応援` }], best.n >= total0 - before.length + 1 ? '応援元の対応人数に余裕がない時間があります' : undefined)); }
  }

  // C 出勤・退勤時間の前倒し／延長（早出・残業）
  if (v.shift !== '夜勤') {
    const next = (a: Assignment) => all.find((x) => x.staffId === a.staffId && x.date === addDays(a.date, 1) && x.status !== 'absent');
    const cands: AdjustChange[] = [];
    for (const a of unitStaff) { const def = SHIFTS[a.shift]; const s = staffById(a.staffId); const n = next(a);
      if (win.t0 >= def.end - 30 && win.t1 - def.end <= 120 && (!s.leaveBy || toMin(s.leaveBy) >= win.t1) && (!n || (1440 + SHIFTS[n.shift].start - win.t1) / 60 >= 11)) cands.push({ assignmentId: a.id, staffId: a.staffId, adjust: { endAt: win.t1 }, text: `${nm(a.staffId)}さんの退勤を ${fmtMin(def.end)} → ${fmtMin(win.t1)} に延長（残業${win.t1 - def.end}分）` });
      if (win.t1 <= def.start + 30 && def.start - win.t0 <= 120) cands.push({ assignmentId: a.id, staffId: a.staffId, adjust: { startAt: win.t0 }, text: `${nm(a.staffId)}さんの出勤を ${fmtMin(def.start)} → ${fmtMin(win.t0)} に前倒し（早出${def.start - win.t0}分）` }); }
    if (cands.length && ok('extend')) { let bestC = cands[0]; let bn = Infinity; for (const c of cands) { const n = issuesOf(applyAdjust(all, [c])).length; if (n < bn) { bn = n; bestC = c; } } plans.push(mk('extend', '出勤・退勤の時間を調整する', '同じユニットの職員の退勤を延ばす（または出勤を早める）ことで、手薄な時間をつなぎます。', [bestC], '退勤上限・勤務間隔（11時間）・翌日の勤務を確認済みです。本人の同意が必要です')); }
  }

  // D 業務の入れ替え（入浴・レクなどを後ろにずらし、直接介助に回す）
  { const MOV = ['bath', 'rec', 'laundry', 'record'] as const; const ch: AdjustChange[] = [];
    for (const a of unitStaff) { const bl = buildBlocks(a, staffById(a.staffId), 0); const x = bl.find((b) => (MOV as readonly string[]).includes(b.kind) && b.end > win.t0 && b.start < win.t1); if (!x) continue;
      const y = bl.find((b) => b.start >= win.t1 && b.kind !== 'break' && b.kind !== 'nap' && !(MOV as readonly string[]).includes(b.kind) && b.kind !== 'handover'); if (!y) continue;
      ch.push({ assignmentId: a.id, staffId: a.staffId, adjust: { swaps: [{ from: x.start, to: y.start }] }, text: `${nm(a.staffId)}さんの「${x.label}」（${fmtMin(x.start)}）と「${y.label}」（${fmtMin(y.start)}）を入れ替える` }); }
    if (ch.length && ok('swap')) { const p = mk('swap', '業務を入れ替えて、直接介助を優先する', '人数は変わりませんが、入浴・レクなどを後ろにずらし、手薄な時間は食事・排泄介助と見守りを優先できます。', ch, '人数の不足そのものは解消しません。ほかの案と組み合わせて使います'); p.resolves = false; plans.push(p); } }

  // 方法の組み合わせ：単独では足りないとき、2つの案を組み合わせて解消できるか試す
  if (!plans.some((p) => p.resolves)) {
    const base = plans.filter((p) => p.kind !== 'swap' && p.changes.length);
    for (let i = 0; i < base.length; i++) for (let j = i + 1; j < base.length; j++) {
      const A = base[i]; const B = base[j];
      if (A.changes.some((c) => B.changes.some((d) => d.assignmentId === c.assignmentId))) continue;
      const m = mk('combo', `${A.title.replace(/する$|に入る$/, '')}＋${B.title.replace(/する$|に入る$/, '')}`, '1つの方法では足りないため、2つの方法を組み合わせます。', [...A.changes, ...B.changes], [A.caution, B.caution].filter(Boolean).join('／') || undefined);
      if (m.resolves) plans.push(m);
    }
  }
  return plans.filter((p) => p.resolves || p.remaining.length < p.before.length || p.kind === 'swap').sort((a, b) => Number(b.resolves) - Number(a.resolves) || a.remaining.length - b.remaining.length);
}

// ---------- 求人：必要スキルと「なぜ必要か」 ----------
export interface SkillReason { skill: SkillId; level: '必須' | '歓迎'; why: string }
export function skillReasons(all: Assignment[], v: Vacancy): SkillReason[] {
  const req = new Set<SkillId>([...v.needSkills, ...requiredSkills(all, v)]);
  const units = v.shift === '夜勤' ? UNITS.filter((u) => u.floor === floorOf(v.unitId)) : UNITS.filter((u) => u.id === v.unitId);
  const res = units.flatMap((u) => residentsOf(u.id));
  const where = v.shift === '夜勤' ? `${floorOf(v.unitId)}階の夜間` : `${unitName(v.unitId)}の${v.shift}`;
  const out: SkillReason[] = [];
  const why = (k: SkillId): string => {
    if (k === 'medical') { const n = res.filter((r) => r.medical.length).length; return `${where}に、喀痰吸引・経管栄養ができる職員が他にいなくなるため。対象の入居者が${n}名います。`; }
    if (k === 'dementia') { const n = res.filter((r) => r.notes.some((t) => /不穏|徘徊/.test(t))).length; return `${where}に認知症ケアができる職員が他にいなくなるため。見守りが必要な入居者が${n}名います。`; }
    if (k === 'swallow') { const n = res.filter((r) => r.notes.some((t) => /嚥下/.test(t))).length; return `食事介助で誤嚥を防ぐため。とろみ等の配慮が必要な入居者が${n}名います。`; }
    if (k === 'bath') return '入浴介助（機械浴・特浴）の操作ができる職員が、この勤務帯に他にいなくなるため。';
    if (k === 'terminal') return '看取り期の入居者への対応ができる職員が、この勤務帯に他にいなくなるため。';
    return SKILLS[k].note;
  };
  for (const k of req) out.push({ skill: k, level: '必須', why: why(k) });
  const a = all.find((x) => x.id === v.fromAssignmentId);
  if (a) for (const k of staffById(a.staffId).skills.filter((x) => ['medical', 'dementia', 'bath', 'swallow', 'terminal'].includes(x) && !req.has(x))) out.push({ skill: k, level: '歓迎', why: `休む職員が担当していた分野。持っていると配置の自由度が上がります。` });
  if (v.shift === '夜勤') out.push({ skill: 'night', level: '必須', why: '夜勤（16:30〜翌09:30）に入れること。仮眠は交代で2時間とれます。' });
  return out;
}
