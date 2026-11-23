// buildInlineRequest（はじめの設定 -> solve-inline リクエスト変換）の確認スクリプト。
// 実行:
//   node_modules/.bin/esbuild scripts/check/setup-request.ts --bundle --platform=node --format=esm --outfile=/tmp/setup-request.mjs --log-level=warning
//   node /tmp/setup-request.mjs [--out /tmp/bench-ui/U1-hidamari.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { holidaysInMonth } from '../../src/core/holidays';
import { THREE_SHIFT_PRESET } from '../../src/setup/defaults';
import { buildInlineRequest, getTargetMonth, MAX_INLINE_STAFF } from '../../src/setup/solverRequest';
import type { SetupState } from '../../src/setup/types';

let fails = 0;
const check = (cond: boolean, label: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) fails += 1;
};

const raw = JSON.parse(readFileSync('scripts/setup-sample.json', 'utf8')) as SetupState;
const sample: SetupState = {
  ...raw,
  carryIn: raw.carryIn ?? {},
  rules: raw.rules ?? { nightMax: 8 },
};

// 1. 見本（setup-sample.json）の変換: 20人、ID 重複なし、名前が入っていない
const normal = buildInlineRequest(sample);
const ids = normal.payload.staff.map((s) => s.staff_id);
const jsonStr = JSON.stringify(normal.payload);
const hasAnyName = sample.staff.some((s) => s.name.trim() && jsonStr.includes(s.name.trim()));
check(normal.payload.staff.length === 20, `見本の変換: 20人 (got ${normal.payload.staff.length})`);
check(new Set(ids).size === 20, '見本の変換: staff_id が重複しない');
check(!hasAnyName, '見本の変換: payload に職員名が含まれない');

// 2. collide の並びで 10 秒以内に終わり、ID が重ならない
const collideState: SetupState = {
  ...sample,
  staff: [
    { ...sample.staff[1], id: 'S002' },
    { ...sample.staff[2], id: '' },
    { ...sample.staff[3], id: 'EMP-99' },
    { ...sample.staff[4], id: 'S002' },
  ],
  carryIn: { S002: '夜勤', 'EMP-99': '遅番' },
};
const t0 = Date.now();
const col = buildInlineRequest(collideState);
const elapsedMs = Date.now() - t0;
const colIds = col.payload.staff.map((s) => s.staff_id);
check(elapsedMs < 10_000, `collide: 10秒以内に完了 (${elapsedMs}ms)`);
check(new Set(colIds).size === 4, `collide: ID が重複しない (${colIds.join(', ')})`);

// 3. 入れない曜日が、その月の日付になっている
const tm = getTargetMonth();
const expectedWeekends: number[] = [];
for (let d = 1; d <= tm.days; d += 1) {
  const w = (tm.firstWeekday + d - 1) % 7;
  if (w === 0 || w === 6) expectedWeekends.push(d);
}
const s001Unavail = normal.payload.unavailable['S001'] ?? [];
check(
  JSON.stringify(s001Unavail) === JSON.stringify(expectedWeekends),
  `入れない曜日: S001 の土日 (${s001Unavail.length}日) が ${tm.monthStr} の暦と一致`
);

// 4. 退勤上限より後に終わる勤務帯が外れる。夜勤は外れない
const leaveState: SetupState = {
  ...sample,
  staff: [
    {
      ...sample.staff[1],
      id: 'S001',
      shifts: ['早番', '日勤', '遅番', '夜勤'],
      leaveBy: '17:00', // 早番(16:00) OK / 日勤(17:30) NG / 遅番(20:00) NG / 夜勤 OK
    },
  ],
};
const leaveRes = buildInlineRequest(leaveState);
const leaveShifts = leaveRes.payload.staff[0].shifts;
check(
  JSON.stringify(leaveShifts) === JSON.stringify(['早番', '夜勤']),
  `退勤上限 17:00: 日勤・遅番が外れ、早番と夜勤は残る (${leaveShifts.join(', ')})`
);

// 5. 前月末の勤務が、新しい ID に付け替わって carry_in に入る
const carryState: SetupState = {
  ...sample,
  staff: [
    { ...sample.staff[0], id: 'S001' },
    { ...sample.staff[1], id: 'CUSTOM-A' },
  ],
  carryIn: { 'CUSTOM-A': '夜勤', S001: '休' },
};
const carryRes = buildInlineRequest(carryState);
const reassignedId = carryRes.payload.staff[1].staff_id;
check(
  reassignedId !== 'CUSTOM-A' && carryRes.payload.carry_in[reassignedId] === '夜勤' && !('CUSTOM-A' in carryRes.payload.carry_in),
  `前月末勤務: CUSTOM-A -> ${reassignedId} に付け替わって carry_in に入る`
);

// 6. 81人入れたときの扱い（80人で打ち切り、droppedStaffCount === 1 を返す）
const staff81 = Array.from({ length: MAX_INLINE_STAFF + 1 }, (_, i) => ({
  ...sample.staff[i % sample.staff.length],
  id: `S${String(i + 1).padStart(3, '0')}`,
  name: `職員${i + 1}`,
}));
const res81 = buildInlineRequest({ ...sample, staff: staff81 });
check(
  res81.payload.staff.length === MAX_INLINE_STAFF && res81.droppedStaffCount === 1,
  `81人入力: payload=${res81.payload.staff.length}人, droppedStaffCount=${res81.droppedStaffCount}`
);

// 7. 曜日別の必要人数（S3）: 既定（useWeekdayNeed: false）では need_by_weekday / holidays を送らない
check(
  normal.payload.need_by_weekday === undefined && normal.payload.holidays === undefined,
  'S3 曜日別オフ: need_by_weekday と holidays は送らない'
);

// 8. 曜日別の必要人数（S3）: 差がある勤務帯だけ need_by_weekday に入り、同値や無効シフトは送らない
const weekdayState: SetupState = {
  ...sample,
  shifts: sample.shifts.map((s) => (s.id === '夜勤' ? { ...s, enabled: false } : s)),
  useWeekdayNeed: true,
  needByWeekday: {
    早番: [0, 2, 2, 2, 2, 2, 0],
    日勤: [3, 5, 5, 5, 5, 5, 3],
    遅番: [2, 2, 2, 2, 2, 2, 2],
    夜勤: [1, 2, 2, 2, 2, 2, 1],
  },
};
const wdRes = buildInlineRequest(weekdayState);
const expectedHolidays = holidaysInMonth(tm.monthStr);
check(
  JSON.stringify(wdRes.payload.need_by_weekday) ===
    JSON.stringify({ 早番: [0, 2, 2, 2, 2, 2, 0], 日勤: [3, 5, 5, 5, 5, 5, 3] }),
  'S3 曜日別オン: 差がある有効勤務帯だけ need_by_weekday に入り、全曜日同値（遅番）と無効（夜勤）は送らない'
);
check(
  wdRes.payload.need_per_shift['早番'] === 0 &&
    wdRes.payload.need_per_shift['日勤'] === 3 &&
    wdRes.payload.need_per_shift['遅番'] === 2 &&
    wdRes.payload.need_per_shift['夜勤'] === 0,
  'S3 曜日別オン: need_per_shift に最小値（無効は0）が入る'
);
check(
  expectedHolidays.length > 0
    ? JSON.stringify(wdRes.payload.holidays) === JSON.stringify(expectedHolidays)
    : wdRes.payload.holidays === undefined,
  `S3 祝日暦: ${tm.monthStr} の祝日 (${expectedHolidays.join(',') || 'なし'}) が整合する`
);
check(
  JSON.stringify(holidaysInMonth('2026-09')) === JSON.stringify([21, 22, 23]) &&
    JSON.stringify(holidaysInMonth('2026-11')) === JSON.stringify([3, 23]) &&
    JSON.stringify(holidaysInMonth('2027-03')) === JSON.stringify([21, 22]) &&
    JSON.stringify(holidaysInMonth('2027-05')) === JSON.stringify([3, 4, 5]),
  'S3 祝日暦: 2026〜2027年の祝日（国民の休日・振替休日含む）が正しく引ける'
);

// 9. 個人の上下限（S4）: 空欄は limits 自体を送らない
const emptyLimitsState: SetupState = {
  ...sample,
  staff: [
    { ...sample.staff[0] },
    {
      ...sample.staff[1],
      limits: {
        workDays: { min: null, max: null },
        byShift: { 夜勤: {}, 日勤: { min: null } },
      },
    },
  ],
};
const emptyLimitsRes = buildInlineRequest(emptyLimitsState);
check(
  normal.payload.staff.every((s) => s.limits === undefined) &&
    emptyLimitsRes.payload.staff.every((s) => s.limits === undefined),
  'S4 個人上下限オフ: 空欄の職員には limits を送らない'
);

// 10. 個人の上下限（S4）: 勤務日数・夜勤・他勤務帯が limits に変換され、無効勤務帯はスキップされる
const withLimitsState: SetupState = {
  ...sample,
  shifts: sample.shifts.map((s) => (s.id === '遅番' ? { ...s, enabled: false } : s)),
  staff: [
    {
      ...sample.staff[1],
      limits: {
        workDays: { max: 10 },
        byShift: {
          夜勤: { min: 4, max: 8 },
          早番: { min: 2 },
          日勤: { max: 0 },
          遅番: { min: 5, max: 3 },
        },
      },
    },
    {
      ...sample.staff[2],
      limits: {
        workDays: { min: 15, max: 12 }, // min > max は送信前にクランプされる
      },
    },
  ],
};
const limitsRes = buildInlineRequest(withLimitsState);
check(
  JSON.stringify(limitsRes.payload.staff[0].limits) ===
    JSON.stringify([
      { shifts: null, at_most: 10 },
      { shifts: ['早番'], at_least: 2 },
      { shifts: ['日勤'], at_most: 0 },
      { shifts: ['夜勤'], at_least: 4, at_most: 8 },
    ]) &&
    JSON.stringify(limitsRes.payload.staff[1].limits) ===
      JSON.stringify([{ shifts: null, at_least: 12, at_most: 12 }]),
  'S4 個人上下限オン: workDays/byShift が limits に変換され、空欄や無効勤務帯は送らない'
);

// 11. 前月の7日表（S6）: 未入力・全員休みのときは history を送らない
const allOffHistoryState: SetupState = {
  ...sample,
  carryIn: {},
  history: {
    S001: ['', '', '', '', '', '', ''],
    S002: ['休', '', '', '', '', '', ''],
  },
};
const allOffHistRes = buildInlineRequest(allOffHistoryState);
check(
  normal.payload.history === undefined && allOffHistRes.payload.history === undefined,
  'S6 前月7日オフ: 未設定・全員休みのときは history を送らない'
);

// 12. 前月の7日表（S6）: 勤務が入った職員だけ 7日分の配列で history に入り、ID 付け替え・最終日 carry_in も揃う
const historyState: SetupState = {
  ...sample,
  staff: [
    { ...sample.staff[0], id: 'S001' },
    { ...sample.staff[1], id: 'CUSTOM-B' },
    { ...sample.staff[2], id: 'S003' },
  ],
  carryIn: {},
  history: {
    S001: ['', '', '', '', '', '', ''], // 全員休み → 送らない
    'CUSTOM-B': ['日勤', '遅番', '休', '夜勤', '', '日勤', '遅番'],
    S003: ['', '早番', '日勤', '日勤', '日勤', '日勤', '休'],
  },
};
const histRes = buildInlineRequest(historyState);
const customBId = histRes.payload.staff[1].staff_id;
check(
  customBId !== 'CUSTOM-B' &&
    JSON.stringify(histRes.payload.history) ===
      JSON.stringify({
        [customBId]: ['日勤', '遅番', '', '夜勤', '', '日勤', '遅番'],
        S003: ['', '早番', '日勤', '日勤', '日勤', '日勤', ''],
      }) &&
    histRes.payload.carry_in[customBId] === '遅番' &&
    !('CUSTOM-B' in (histRes.payload.history ?? {})) &&
    !('S003' in histRes.payload.carry_in) &&
    !('S001' in (histRes.payload.history ?? {})),
  `S6 前月7日オン: CUSTOM-B -> ${customBId} に付け替わり history（7日配列）と carry_in に入る`
);

// 13. S2 既定（2交代4区分）の shift_types 出力
const stNormal = normal.payload.shift_types ?? [];
const nightSt = stNormal.find((s) => s.id === '夜勤');
check(
  stNormal.length === 4 &&
    stNormal.map((s) => s.id).join(',') === '早番,日勤,遅番,夜勤' &&
    nightSt?.group === '夜勤系' &&
    nightSt?.next_day === '明け',
  'S2 既定（2交代）: shift_types に4区分（夜勤は夜勤系・明け）が入る'
);

// 14. S2 3交代雛形 + 人数対象外（研修）区分
const threeShiftState: SetupState = {
  ...sample,
  shifts: [
    ...THREE_SHIFT_PRESET,
    { id: '研修', name: '研修', short: '研', enabled: true, startTime: '09:00', endTime: '17:00', group: '日勤系', counts: false, nextDay: 'なし' },
  ],
  needPerShift: { 日: 4, 準: 2, 深: 2 },
  staff: sample.staff.slice(0, 6).map((m, idx) => ({
    ...m,
    shifts: idx === 0 ? ['日', '研修'] : ['日', '準', '深'],
  })),
  carryIn: {},
  history: {},
};
const tsRes = buildInlineRequest(threeShiftState);
const tsTypes = tsRes.payload.shift_types ?? [];
const tsById = Object.fromEntries(tsTypes.map((s) => [s.id, s]));
check(
  tsTypes.length === 4 &&
    tsById['準']?.group === '夜勤系' &&
    tsById['準']?.next_day === 'なし' &&
    tsById['深']?.group === '夜勤系' &&
    tsById['深']?.next_day === 'なし' &&
    tsById['研修']?.counts === false &&
    tsRes.payload.need_per_shift['日'] === 4 &&
    !('研修' in tsRes.payload.need_per_shift),
  'S2 3交代 + 研修: shift_types に4区分が出力され、counts=false の研修は必要人数に入らない'
);

// 任意: --out 指定時は bench.run 用の入力 JSON を書き出す
const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) {
  const outPath = process.argv[outIdx + 1];
  mkdirSync(dirname(outPath), { recursive: true });
  const benchInst = {
    name: 'U1-ひだまりの郷（setup の変換を通した）',
    meta: {
      kind: '画面の変換',
      days: normal.targetMonth.days,
      cover: Array.from({ length: normal.targetMonth.days }, () => ({ ...normal.payload.need_per_shift })),
    },
    request: normal.payload,
  };
  writeFileSync(outPath, JSON.stringify(benchInst, null, 1));
  console.log(`WROTE ${outPath}`);
}

process.exit(fails > 0 ? 1 : 0);
