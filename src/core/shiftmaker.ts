// 「シフト作成君」：自然文 → 構造化 → 正規化 → 影響チェック（モック／ルールベース）
// 将来は Gemini（Gemini Enterprise Agent Platform）の出力を同じ AiItem スキーマで差し替える。
import type { AiItem, AiProposal, Assignment, ShiftCode, RequestKind } from './types';
import { addDays, dow, fmtMD, parseYmd, toYmd, fmtHM, toMin, DOW_JA } from './dates';
import { coverage, buildDay } from './roster';
import { SHIFTS, staffById, unitName } from './facility';

const REASONS: [RegExp, string][] = [
  [/(子ども|子供|息子|娘).{0,3}(発熱|熱)/, '子どもの熱'], [/体調|熱|風邪|発熱|具合|頭痛|腹痛|吐き気/, '体調不良'], [/送迎|送り迎え|お迎え|保育園|学校|子ども|子供|息子|娘/, '子どもの送迎'],
  [/通院|病院|検診|診察/, '通院'], [/介護|親|母|父|家族/, '家族の事情'], [/冠婚葬祭|葬儀|結婚式|法事/, '冠婚葬祭'], [/用事|私用|役所|手続き/, '私用'],
];

export function extractDates(text: string, today: string): string[] {
  const out: string[] = [];
  const y = parseYmd(today).getFullYear();
  for (const m of text.matchAll(/(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/g)) out.push(`${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`);
  if (!out.length) for (const m of text.matchAll(/(?<![\d\/月])(\d{1,2})日/g)) { const d = parseYmd(today); const cand = new Date(d.getFullYear(), d.getMonth(), +m[1]); if (cand < d) cand.setMonth(cand.getMonth() + 1); out.push(toYmd(cand)); }
  if (/明後日/.test(text)) out.push(addDays(today, 2)); else if (/明日/.test(text)) out.push(addDays(today, 1));
  if (/今日|本日/.test(text)) out.push(today);
  const wk = text.match(/(来週|今週)?の?([日月火水木金土])曜/);
  if (wk && !out.length) { const base = wk[1] === '来週' ? addDays(today, 7 - dow(today)) : today; const t = DOW_JA.indexOf(wk[2]); let d = base; for (let i = 0; i < 8; i++) { if (dow(d) === t && d >= today) break; d = addDays(d, 1); } out.push(d); }
  return [...new Set(out)];
}
const shiftIn = (t: string): ShiftCode | undefined => (/夜勤|夜/.test(t) ? '夜勤' : /早番|朝/.test(t) ? '早番' : /遅番|夕/.test(t) ? '遅番' : /日勤/.test(t) ? '日勤' : undefined);

export function proposeFromText(raw: string, staffId: string, today: string, all: Assignment[], collectionMonth?: string): AiProposal {
  const items: AiItem[] = [];
  const t = raw.replace(/\s+/g, '');
  const reason = REASONS.find(([r]) => r.test(raw))?.[1];
  const dates = extractDates(t, today);

  // 個人希望（休憩・退勤上限・勤務帯）
  const prefs: NonNullable<AiItem['prefs']> = {};
  const br = t.match(/休憩[はを]?(?:いつも)?(\d{1,2})[:時](\d{2})?/);
  if (br) prefs.breakPref = `${String(+br[1]).padStart(2, '0')}:${br[2] ?? '00'}ごろ`;
  const lv = t.match(/(\d{1,2})[:時](\d{2})?までに(?:帰|退勤)/);
  const isHabit = /いつも|毎回|夕勤の日|普段|基本/.test(t);
  if (lv && (isHabit || !dates.length)) { prefs.leaveBy = `${String(+lv[1]).padStart(2, '0')}:${lv[2] ?? '00'}`; if (reason) prefs.leaveReason = reason; }
  const hope: ShiftCode[] = [];
  if (/夜勤(希望|多め|入りたい|入れ)/.test(t)) hope.push('夜勤'); if (/(朝|早番)(希望|多め)/.test(t)) hope.push('早番'); if (/(夕|遅番)(希望|多め)/.test(t)) hope.push('遅番');
  if (hope.length) prefs.shiftHope = hope;
  if (Object.keys(prefs).length) {
    const parts = [prefs.breakPref && `休憩：${prefs.breakPref}`, prefs.leaveBy && `退勤上限：${prefs.leaveBy}${prefs.leaveReason ? `（${prefs.leaveReason}）` : ''}`, prefs.shiftHope && `勤務帯希望：${prefs.shiftHope.join('・')}`].filter(Boolean);
    items.push({ type: 'prefs', prefs, normalized: parts.join(' ／ '), impact: '本人の希望として保存し、次回以降の月次案と日次配置に反映します（必須条件ではありません）。', detail: raw });
  }

  // 「入れる日」の登録（欠員が出たら優先して打診する）
  const availWords = /(入れます|入れる|入れそう|出られます|出れます|出勤できます|出勤可能|応援できます|手伝えます)/.test(t) && !/(入れない|出られない|出れない|休)/.test(t);
  if (availWords && dates.length) {
    const sh = shiftIn(t);
    for (const d of dates) items.push({ type: 'avail', date: d, avail: { date: d, shifts: sh ? [sh] : [] }, normalized: `${fmtMD(d)} ${sh ? `${sh}は` : 'どの勤務帯でも'}入れる日として登録`, impact: all.some((a) => a.staffId === staffId && a.date === d && a.status !== 'absent') ? 'この日はすでにシフトが入っています。欠員が出たときの打診の対象にはなりません。' : '欠員が出たとき、この日・勤務帯は優先して連絡します（出勤の確定ではありません）。' });
  }

  // 休み・遅刻・早退・変更
  let kind: RequestKind | undefined;
  if (/遅刻|遅れ|遅く/.test(t) || (/(から|に)出勤/.test(t) && /\d[:時]/.test(t))) kind = '遅刻';
  else if (/早退|早く帰|早めに帰|早上がり/.test(t) || (lv && dates.length && !isHabit)) kind = '早退';
  else if (/休み|休ま|欠勤|休暇|休め|行けない|出られない|出れない/.test(t)) kind = /希望休|休みたい|休み希望|休みを取/.test(t) && dates.some((d) => d > addDays(today, 2)) ? '希望休' : '休み';
  else if (/変更|変えて|交代|代わっ|入れ替|替わ/.test(t)) kind = 'シフト変更';
  if (kind) {
    const ds = dates.length ? dates : [today];
    for (const d of ds) {
      if (kind === '希望休' && collectionMonth && d.startsWith(collectionMonth)) { items.push({ type: 'dayoff', date: d, reason, normalized: `${fmtMD(d)} を希望休として提出${reason ? `（理由：${reason}）` : ''}`, impact: '来月のシフト作成のときに、できるだけ休みにします（確定ではありません）。締切まで何度でも変更できます。' }); continue; }
      const mine = all.find((a) => a.staffId === staffId && a.date === d && a.status !== 'absent');
      const sh = shiftIn(t);
      const target = mine && (!sh || mine.shift === sh) ? mine : undefined;
      let detail = '';
      if (kind === '遅刻') { const mm = t.match(/(\d+)分/); const hh = t.match(/翌?(\d{1,2})[:時](\d{2})?[頃ごろ]?(から|に)/); detail = mm ? `${mm[1]}分遅れ` : hh ? `${String(+hh[1]).padStart(2, '0')}:${hh[2] ?? '00'}出勤` : '30分遅れ（仮）'; }
      if (kind === '早退') { const e = t.match(/(\d{1,2})[:時](\d{2})?(までに|で|に)/); detail = e ? `${String(+e[1]).padStart(2, '0')}:${e[2] ?? '00'}退勤` : '1時間早め（仮）'; }
      const it: AiItem = { type: 'request', kind, date: d, reason, detail, normalized: '', impact: '' };
      it.normalized = `${fmtMD(d)} ${target ? target.shift : sh ?? '勤務'}${target ? `（${unitName(target.unitId)}）` : ''} を「${kind}」${detail ? `／${detail}` : ''}${reason ? `／理由：${reason}` : ''}`;
      const sim = simulate(all, staffId, d, kind, detail);
      it.before = target ? `${target.shift} ${SHIFTS[target.shift].label}（${unitName(target.unitId)}）` : '勤務予定なし';
      it.after = !target ? `${kind}として登録` : kind === '休み' || kind === '希望休' ? '休み（欠員1名が発生）' : kind === '遅刻' ? `${detail}（その間は他の職員が対応）` : kind === '早退' ? `${detail}` : '調整中';
      it.impact = sim.text; it.needsApproval = sim.needsApproval;
      items.push(it);
    }
  }
  if (!items.length) items.push({ type: 'unknown', normalized: '読み取れませんでした', impact: '日付と内容（例：「11/20の夜勤を休みたい。体調不良です」「休憩は02:00ごろがいい」）を添えて送ってください。' });
  const known = items.filter((i) => i.type !== 'unknown');
  const summary = known.length ? `${known.length}件の内容を読み取りました。` : '内容を特定できませんでした。';
  return { id: `P-${Date.now()}`, raw, items, state: 'draft', summary };
}

export function simulate(all: Assignment[], staffId: string, date: string, kind: RequestKind, detail?: string): { text: string; needsApproval: boolean } {
  const mine = all.find((a) => a.staffId === staffId && a.date === date && a.status !== 'absent');
  if (!mine) return { text: `${fmtMD(date)}は勤務予定がないため、シフトへの影響はありません。自動で反映します。`, needsApproval: false };
  const days = mine.shift === '夜勤' ? [date, addDays(date, 1)] : [date]; // 夜勤は翌朝までの影響も見る
  const issuesOf = (list: Assignment[]) => days.flatMap((d) => coverage(buildDay(list, d)));
  const before = issuesOf(all).length;
  const next = all.map((a) => (a.id === mine.id ? applyKind(a, kind, detail) : a));
  const after = issuesOf(next);
  if (kind === '休み' || kind === '希望休') return { text: `${mine.shift}（${unitName(mine.unitId)}）に欠員1名が発生します。リーダーの承認後、シフト作成君が代わりの方への打診を自動で進めます（開始前にリーダーが確認します）。`, needsApproval: true };
  const added = after.length - before;
  if (added > 0) return { text: `${after[0].text}（${fmtHM(after[0].t0)}〜${fmtHM(after[0].t1)}）。配置に穴ができるためリーダーの承認待ちにします。`, needsApproval: true };
  return { text: `対応人数・休憩の検証で問題なし。自動で反映し、リーダーへ通知します。`, needsApproval: false };
}

export function applyKind(a: Assignment, kind: RequestKind, detail?: string): Assignment {
  if (kind === '休み' || kind === '希望休') return { ...a, status: 'absent' };
  if (kind === '遅刻') { const m = detail?.match(/(\d+)分/); const h = detail?.match(/(\d{2}):(\d{2})/); let hm = h ? toMin(`${h[1]}:${h[2]}`) : 0; if (h && a.shift === '夜勤' && hm < 12 * 60) hm += 1440; const min = m ? +m[1] : h ? hm - SHIFTS[a.shift].start : 30; return { ...a, status: 'late', lateMin: Math.max(15, min) }; }
  if (kind === '早退') { const h = detail?.match(/(\d{2}:\d{2})/); return { ...a, status: 'early', earlyAt: h ? h[1] : fmtHM(SHIFTS[a.shift].end - 60) }; }
  return a;
}
void staffById;
