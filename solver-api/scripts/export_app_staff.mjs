// 画面（src/core/facility.ts）の職員を、solve-inline に送る形の JSON に書き出す。テストの入力（tests/fixtures/app_staff.json）を作る。
// 名前は書き出さない。勤務区分は画面の canWork と同じく退勤上限で絞る（夜勤は対象外）。
//   node solver-api/scripts/export_app_staff.mjs   （Node 22.6+ は .ts の型を外して読める）
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STAFF, SHIFTS } from '../../src/core/facility.ts';

const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const canWork = (s, k) => s.shifts.includes(k) && (k === '夜勤' || !s.leaveBy || SHIFTS[k].end <= toMin(s.leaveBy));
const staff = STAFF.filter((s) => s.shifts.length).map((s) => ({
  staff_id: s.id, role: s.role, employment: s.employment, years: s.years, skills: s.skills,
  shifts: s.shifts.filter((k) => canWork(s, k)), home_unit: s.homeUnit, leave_by: s.leaveBy ?? null, is_leader: !!s.isLeader,
}));
const out = fileURLToPath(new URL('../tests/fixtures/app_staff.json', import.meta.url));
writeFileSync(out, JSON.stringify(staff, null, 1) + '\n');
console.log(`wrote ${staff.length} staff -> ${out}`);
