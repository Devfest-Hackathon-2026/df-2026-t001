import { SHIFTS, SKILLS, UNITS } from '../core/facility';
import { fmtMD } from '../core/dates';
import type { SkillReason } from '../core/roster';
import type { Applicant, Vacancy } from '../core/types';
import type { Candidate } from '../core/roster';
import { Icon } from '../shared/ui';

/** 候補の理由チップ。「入れる日」登録は最初に、目立つ色で */
export function ReasonChips({ c, max = 3 }: { c: Candidate; max?: number }) {
  const first = c.reasons.find((r) => r.startsWith('希望提出で'));
  const rest = c.reasons.filter((r) => r !== first);
  return (
    <div class="row wrap" style="gap:4px;margin-top:6px">
      {first && <span class="chip pri"><Icon n="event_available" sm /> 入れる日として登録済み</span>}
      {rest.slice(0, first ? max - 1 : max).map((r) => <span key={r} class="chip">{r}</span>)}
    </div>
  );
}
export const PRIORITY_NOTE = '優先順：①希望提出で「入れる日」に登録していた人 → ②必要スキル・当日の空き・過去の希望の順';

/** 必須・歓迎スキルと、なぜ必要か */
export function SkillWhy({ reasons }: { reasons: SkillReason[] }) {
  if (!reasons.length) return <p class="small">この勤務では、特別に必要なスキルはありません。</p>;
  return (
    <div class="stack" style="gap:8px">
      {reasons.map((r) => (
        <div key={r.skill + r.level} class="skwhy">
          <div class="row" style="gap:6px"><span class={`chip ${r.level === '必須' ? 'bad' : 'pri'}`}>{r.level}</span><b style="font-weight:500">{SKILLS[r.skill].label}</b></div>
          <div class="small" style="margin-top:4px;color:var(--tx)"><b style="font-weight:500">なぜ必要？</b> {r.why}</div>
          <div class="small" style="margin-top:2px"><b style="font-weight:500">目安の資格・経験：</b>{SKILLS[r.skill].note}</div>
          <div class="small" style="margin-top:2px">{r.level === '必須' ? '応募者がこのスキルを持っていない場合は「不適合」と表示し、採用できません。' : '持っていると優先して案内します（なくても応募できます）。'}</div>
        </div>
      ))}
    </div>
  );
}

/** 求人サイト風の掲載プレビュー */
export function JobPreview({ v, text, reward, reasons }: { v: Vacancy; text: string; reward: string; reasons: SkillReason[] }) {
  const u = UNITS.find((x) => x.id === v.unitId)!;
  const req = reasons.filter((r) => r.level === '必須'); const wel = reasons.filter((r) => r.level === '歓迎');
  const body = text.split('\n').filter((l) => !/^(【|日時|配属|資格|業務|対価|職場|必要スキル)/.test(l) && l.trim());
  return (
    <div class="jobcard">
      <div class="jobhead">
        <div class="row" style="gap:6px"><span class="chip">単発</span><span class="chip">{v.shift}</span><span class="chip">{u.floor}階</span></div>
        <h3 class="jobtitle">【さくら苑】{v.shift}スタッフ募集（単発）</h3>
        <div class="small">特別養護老人ホーム（架空）</div>
      </div>
      <dl class="kv jobkv">
        <dt>日時</dt><dd>{fmtMD(v.date)} {SHIFTS[v.shift].label}</dd>
        <dt>勤務地</dt><dd>{u.floor}階 {u.name}（入居者{u.capacity}名）</dd>
        <dt>対価</dt><dd><b style="font-weight:500">{reward || '（未入力）'}</b></dd>
        <dt>資格</dt><dd>介護福祉士または実務者研修修了</dd>
        <dt>必須スキル</dt><dd class="row wrap" style="gap:4px">{req.length ? req.map((r) => <span key={r.skill} class="chip bad">{SKILLS[r.skill].label}</span>) : <span class="muted">なし</span>}</dd>
        <dt>歓迎スキル</dt><dd class="row wrap" style="gap:4px">{wel.length ? wel.map((r) => <span key={r.skill} class="chip pri">{SKILLS[r.skill].label}</span>) : <span class="muted">なし</span>}</dd>
      </dl>
      <div class="jobbody">{body.map((l, i) => <p key={i}>{l}</p>)}</div>
      <button class="btn block" disabled>応募する</button>
    </div>
  );
}

/** 応募者：必須スキルを自動で照合 */
export function Applicants({ v, reasons, onHire }: { v: Vacancy; reasons: SkillReason[]; onHire: (id: string) => void }) {
  const list = v.applicants ?? (v.applicant ? [v.applicant] : []);
  const req = reasons.filter((r) => r.level === '必須').map((r) => r.skill);
  return (
    <div class="stack" style="gap:10px">
      <p class="small">照合ルール：必須スキルをすべて持つ方だけ採用できます。応募だけでは充足にしません。</p>
      {list.map((a: Applicant) => (
        <div key={a.id} class={`apcard${a.ok ? ' ok' : ''}`}>
          <div class="row spread wrap" style="gap:8px"><div><b style="font-weight:500">{a.name}</b><div class="small">経験{a.years}年・{a.license}</div></div>
            <span class={`chip ${a.ok ? 'ok' : 'bad'}`}>{a.ok ? '必須スキルに適合' : `不足：${a.missing.map((k) => SKILLS[k].label).join('・')}`}</span></div>
          <div class="row wrap" style="gap:4px;margin-top:8px">
            {req.map((k) => <span key={k} class={`chip ${a.skills.includes(k) ? 'ok' : 'bad'}`}>{a.skills.includes(k) ? '✓' : '✕'} {SKILLS[k].label}</span>)}
            {a.skills.filter((k) => !req.includes(k)).slice(0, 3).map((k) => <span key={k} class="chip">{SKILLS[k].label}</span>)}
          </div>
          <p class="small" style="margin-top:6px">{a.note}</p>
          <div class="row wrap" style="margin-top:8px;gap:8px">
            <button class="btn pri sm" disabled={!a.ok} onClick={() => onHire(a.id)}>この方を採用して充足にする</button>
            {!a.ok && <span class="small" style="color:var(--bad)">必須スキルが足りないため採用できません</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
