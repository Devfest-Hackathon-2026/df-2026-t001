// リーダー向け「シフト作成君」：状況の質問・操作の依頼・シフト作成の依頼を、自然文で受ける（ルールベース。ルールで読み取れない言い回しは、Gemini の分類 aiintent.ts が補う）
import type { State } from './store';
import { extractDates } from './shiftmaker';
import { fmtMD } from './dates';
import { rankCandidates } from './roster';
import { staffById, unitName, SKILLS } from './facility';
import type { ShiftCode } from './types';

export interface LeaderReply { unknown?: boolean; text: string; links?: { label: string; target: string }[]; action?: { kind: 'delegate' | 'remind' | 'approveRequests' | 'createPlan' | 'publishPlan'; args: Record<string, unknown>; label: string; detail: string } }
const shiftOf = (t: string): ShiftCode | undefined => (/夜勤|夜/.test(t) ? '夜勤' : /早番|朝/.test(t) ? '早番' : /遅番/.test(t) ? '遅番' : /日勤/.test(t) ? '日勤' : undefined);

export const LEADER_SUGGESTIONS = ['今日の状況をまとめて', '明日の欠員は？', '11/24の日勤に誰が入れる？', '今日体調の悪い人は？', '申請を承認して任せて', '12月のシフトを作って', '夜勤を減らして12月のシフトを作り直して', '希望休の未提出者に催促を送って'];

export function interpretLeader(raw: string, s: State): LeaderReply {
  const t = raw.replace(/\s+/g, '');
  const dates = extractDates(t, s.today);
  const sh = shiftOf(t);
  const open = s.vacancies.filter((v) => v.state !== 'filled' && v.date >= s.today);
  const pending = s.requests.filter((r) => r.status === 'pending');

  // シフト作成の依頼
  if (/(シフト).*(作|つく|組)/.test(t) || /(作成|作って|作り直)/.test(t) && /シフト/.test(t)) {
    const mm = t.match(/(\d{1,2})月/); const month = mm ? `${s.today.slice(0, 4)}-${String(+mm[1]).padStart(2, '0')}` : /来月/.test(t) ? '2026-12' : s.collection.month;
    const nm = /(夜勤).*(減ら|少なく|抑え)/.test(t) ? 6 : undefined;
    return { text: `${+month.slice(5)}月のシフトを作ります。希望休（${Object.values(s.collection.submitted).filter(Boolean).length}名が提出済み）、入れる日、行事、労務ルールを反映します。${nm ? `夜勤は1人あたり月${nm}回までにします。` : ''}作成後は、結果を確認・編集してから公開できます。`, action: { kind: 'createPlan', args: { month, nightMax: nm }, label: `${+month.slice(5)}月のシフトを作成する`, detail: nm ? '夜勤を月6回までに抑えて作成します' : '希望休・入れる日・行事を反映して作成します' } };
  }
  if (/(公開|確定|発表)/.test(t) && /シフト/.test(t)) {
    return s.plan?.status === 'draft' ? { text: `${+s.plan.month.slice(5)}月の作成中のシフトを公開します。公開すると、勤務表と日次・月次に反映されます。`, action: { kind: 'publishPlan', args: {}, label: 'シフトを公開する', detail: '公開後は従業員のシフト画面に反映されます' } } : { text: '公開できる作成中のシフトがありません。先に「12月のシフトを作って」と送ってください。' };
  }
  // 操作の依頼
  if (/催促|リマインド|未提出/.test(t)) {
    const n = Object.values(s.collection.submitted).filter((v) => !v).length;
    return { text: `${+s.collection.month.slice(5)}月分の希望休が未提出の人は${n}名です。催促の通知を送ります。`, links: [{ label: '提出状況を見る', target: 'collection' }], action: { kind: 'remind', args: {}, label: `未提出の${n}名に催促を送る`, detail: `締切：${fmtMD(s.collection.deadline)}` } };
  }
  if (/承認/.test(t)) {
    if (!pending.length) return { text: '承認待ちの申請はありません。' };
    return { text: `承認待ちの申請が${pending.length}件あります。承認して、欠員が出る場合はシフト作成君に任せます。`, links: [{ label: '申請を見る', target: 'requests' }], action: { kind: 'approveRequests', args: { ids: pending.map((r) => r.id) }, label: `${pending.length}件を承認して任せる`, detail: pending.map((r) => `${staffById(r.staffId).name}さん ${fmtMD(r.date)} ${r.kind}`).join('／') } };
  }
  if (/(任せ|おまかせ)/.test(t)) {
    let targets = open.filter((v) => (!dates.length || dates.includes(v.date)) && (!sh || v.shift === sh) && (!v.auto || v.auto.mode === 'ask' || v.auto.mode === 'manual'));
    if (!targets.length) return { text: '任せられる欠員が見つかりませんでした。日付を添えて送ってください（例：「11/24の欠員を任せて」）。', links: [{ label: '欠員を見る', target: 'vacancies' }] };
    if (!dates.length && targets.length > 3) targets = targets.slice(0, 3);
    return { text: `${targets.length}件の欠員をシフト作成君に任せます。時間の調整で足りるかを確認し、足りなければ候補に順番に打診します。`, links: targets.map((v) => ({ label: `${fmtMD(v.date)} ${v.shift}を開く`, target: `vacancy:${v.id}` })), action: { kind: 'delegate', args: { ids: targets.map((v) => v.id) }, label: `${targets.length}件を任せる`, detail: targets.map((v) => `${fmtMD(v.date)} ${v.shift}（${unitName(v.unitId)}）`).join('／') } };
  }
  // 状況の質問
  if (/体調/.test(t)) {
    const today = s.health.filter((h) => h.date === s.today); const ng = today.filter((h) => h.consult || h.symptoms.length || h.temp >= 37.5);
    const duty = new Set(s.assignments.filter((a) => a.date === s.today && a.status !== 'absent').map((a) => a.staffId));
    const miss = [...duty].filter((id) => !today.some((h) => h.staffId === id)).length;
    return { text: `今日の体調チェック：入力済み${today.length}名、未入力${miss}名（勤務予定の職員のうち）。${ng.length ? `確認が必要な人：${ng.map((h) => `${staffById(h.staffId).name}さん（${h.temp.toFixed(1)}℃${h.symptoms.length ? `・${h.symptoms.join('・')}` : ''}${h.consult ? '・相談希望' : ''}）`).join('、')}。就業可否は本人と相談して決めてください。` : '確認が必要な人はいません。'}未入力は健康とはみなしていません。`, links: [{ label: '体調チェックを開く', target: 'health' }] };
  }
  if (dates.length && /(誰|入れる|候補|打診|空い)/.test(t)) {
    const d = dates[0]; const v = open.find((x) => x.date === d && (!sh || x.shift === sh));
    if (!v) { const av = Object.entries(s.availability).flatMap(([id, l]) => l.filter((x) => x.date === d && (!sh || !x.shifts.length || x.shifts.includes(sh))).map(() => staffById(id).name)); return { text: `${fmtMD(d)}${sh ? sh : ''}に欠員はありません。${av.length ? `「入れる日」を出している人：${av.join('、')}（補欠として最優先で打診します）。` : ''}`, links: [{ label: `${fmtMD(d)}の1日を見る`, target: `day:${d}` }] }; }
    const r = rankCandidates(s.assignments, v, Object.fromEntries(Object.entries(s.prefs).map(([k, p]) => [k, p.shiftHope])), s.availability).filter((c) => !c.blocked && !c.unfit).slice(0, 3);
    return { text: `${fmtMD(v.date)} ${v.shift}（${unitName(v.unitId)}）に入れる人の上位です。${v.needSkills.length ? `必須スキル：${v.needSkills.map((k) => SKILLS[k].label).join('・')}。` : ''}\n${r.map((c, i) => `${i + 1}. ${c.staff.name}さん：${c.reasons.slice(0, 2).join('、')}`).join('\n') || '条件に合う人がいません。求人への切り替えを検討してください。'}`, links: [{ label: '欠員の詳細を開く', target: `vacancy:${v.id}` }] };
  }
  if (/欠員|人手|足りない|不足/.test(t)) {
    const l = dates.length ? open.filter((v) => dates.includes(v.date)) : /明日/.test(t) ? open.filter((v) => v.date === s.today.replace(/\d+$/, (x) => String(+x + 1).padStart(2, '0'))) : open;
    if (!l.length) return { text: dates.length || /明日/.test(t) ? '該当の日に欠員はありません。' : '欠員はありません。' };
    return { text: `欠員は${l.length}件です。\n${l.slice(0, 6).map((v) => `・${fmtMD(v.date)} ${v.shift}（${unitName(v.unitId)}）：${v.auto ? { ask: '確認待ち', running: '自動対応中', paused: '一時停止', waiting_adjust: '時間調整の承認待ち', waiting_post: '求人承認待ち', posted: '求人掲載中', manual: '手動', done: '対応済み' }[v.auto.mode] : '未対応'}`).join('\n')}`, links: l.slice(0, 3).map((v) => ({ label: `${fmtMD(v.date)} ${v.shift}を開く`, target: `vacancy:${v.id}` })) };
  }
  if (/(まとめ|要約|状況|サマリ|今日)/.test(t)) {
    const duty = s.assignments.filter((a) => a.date === s.today && a.status !== 'absent').length;
    const miss = Object.values(s.collection.submitted).filter((v) => !v).length;
    return { text: `今日（${fmtMD(s.today)}）のまとめです。\n・勤務予定：${duty}名\n・欠員：${open.length}件（うち自動対応中${open.filter((v) => v.auto?.mode === 'running').length}件）\n・承認待ちの申請：${pending.length}件\n・時間調整・求人の承認待ち：${open.filter((v) => v.auto?.mode === 'waiting_adjust' || v.auto?.mode === 'waiting_post').length}件\n・希望休の未提出：${miss}名`, links: [{ label: '要対応を開く', target: 'vacancies' }] };
  }
  return { unknown: true, text: '次のようなことを聞いたり、頼んだりできます。\n・「今日の状況をまとめて」\n・「明日の欠員は？」「11/24の日勤に誰が入れる？」\n・「今日体調の悪い人は？」\n・「申請を承認して任せて」「希望休の未提出者に催促を送って」\n・「12月のシフトを作って」「夜勤を減らして作り直して」' };
}
