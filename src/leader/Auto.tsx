import { useState } from 'preact/hooks';
import { SKILLS, staffById, unitName } from '../core/facility';
import type { Candidate } from '../core/roster';
import { CandBeforeAfter, MiniChecks } from './Impact';
import { Applicants, JobPreview, PRIORITY_NOTE, SkillWhy } from './Job';
import { CandReason } from './AiReason';
import { skillReasons } from '../core/roster';
import type { SkillReason } from '../core/roster';
import { fmtMD, stampTime } from '../core/dates';
import {
  advanceClock, approveJobPost, delegateAutopilot, clearVacancyOpts, declineAutopilot, decideRequest, effSettings, inQuiet, rejectJobPost,
  setVacancyOpts, updateAutopilot, jobText,
} from '../core/store';
import type { State } from '../core/store';
import type { Vacancy, ShiftRequest } from '../core/types';
import { Icon, Modal } from '../shared/ui';
import { hm } from './util';
import { SettingsForm } from './Settings';
export { Stepper } from './Settings';

export const vacTitle = (v: Vacancy) => `${fmtMD(v.date)} ${v.shift}／${unitName(v.unitId)}${v.kind === 'gap' ? '（応援）' : ''}`;

/** 欠員の確認カード：「シフト作成君に任せる」が主操作。細かい設定は「詳細設定」を開いたときだけ */
export function AskCard({ s, v }: { s: State; v: Vacancy }) {
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section class="card askcard">
      <div class="row" style="gap:8px"><Icon n="smart_toy" /><b style="font-weight:500">{vacTitle(v)}の欠員</b></div>
      <p class="muted" style="margin-top:4px">{v.reason}</p>
      <div class="row wrap" style="margin-top:12px">
        <button class="btn pri" disabled={busy} onClick={() => { setBusy(true); void delegateAutopilot(v.id, { max: effSettings(s, v).maxCandidates }).finally(() => setBusy(false)); }}>{busy ? '候補を確認中…' : '承認して、シフト作成君に任せる'}</button>
        <button class="btn" onClick={() => declineAutopilot(v.id)}>自分で対応する</button>
        <button class="btn sm" onClick={() => setMore(!more)} aria-expanded={more}>詳細設定</button>
      </div>
      {more && <div style="margin-top:12px"><p class="small" style="margin-bottom:8px">この欠員だけの設定です。</p><SettingsForm val={effSettings(s, v)} onChange={(p) => setVacancyOpts(v.id, p)} /></div>}
    </section>
  );
}

/** 申請カードの操作：1タップで「承認＋代わりを自動で探す」 */
export function ReqActions({ r, s }: { r: ShiftRequest; s: State }) {
  const [conf, setConf] = useState(false);
  if (r.status !== 'pending') return null;
  const absence = r.kind === '休み' || r.kind === '希望休';
  return (
    <div class="row wrap" style="margin-top:12px">
      {s.autopilot.enabled ? <button class="btn pri" onClick={() => decideRequest(r.id, true, true)}>承認して、シフト作成君に任せる</button> : null}
      <button class={s.autopilot.enabled ? 'btn' : 'btn pri'} onClick={() => decideRequest(r.id, true, false)}>承認のみ</button>
      <button class="btn danger" onClick={() => setConf(true)}>見送り</button>
      {conf && <Modal title="見送りにしますか？" onClose={() => setConf(false)} footer={<><button class="btn" onClick={() => setConf(false)}>戻る</button><button class="btn danger" onClick={() => { decideRequest(r.id, false); setConf(false); }}>見送りにする</button></>}>
        <p>{staffById(r.staffId).name}さんの{fmtMD(r.date)} {r.kind}を見送ります。本人に通知され、シフトは変わりません。</p></Modal>}
    </div>
  );
}

/** 求人掲載の承認（AIが作った文面を確認・編集して承認。外部には送信しない） */
export function PostSheet({ v, reasons, onClose }: { v: Vacancy; reasons: SkillReason[]; onClose: () => void }) {
  const [text, setText] = useState(v.jobPost?.text ?? '');
  const [reward, setReward] = useState(v.jobPost?.reward ?? '');
  return (
    <Modal wide title="求人掲載の承認" onClose={onClose} footer={<><button class="btn danger" onClick={() => { rejectJobPost(v.id); onClose(); }}>見送る</button><button class="btn pri" onClick={() => { approveJobPost(v.id, text, reward); onClose(); }}>掲載を承認</button></>}>
      <div class="airec">
        <div class="row" style="gap:6px"><Icon n="smart_toy" sm /><b style="font-weight:500">シフト作成君のおすすめ</b></div>
        <ul>
          <li><b style="font-weight:500">掲載する理由：</b>{vacTitle(v)}は、内部の候補全員に打診しても埋まりませんでした。外部に募集をかけるのが次の手です。</li>
          <li><b style="font-weight:500">対価：</b>{reward || '未入力'}。全体の設定の基本額{v.shift === '夜勤' ? 'に、夜勤の手当を足した金額' : ''}です。右の欄で変更できます。</li>
          <li><b style="font-weight:500">求人に書いたスキル：</b>{reasons.filter((r) => r.level === '必須').map((r) => SKILLS[r.skill].label).join('・') || '特別なスキルは不要'}。応募が来たら、この条件に合うか自動で照合します。</li>
        </ul>
        <p class="small">あなたが承認するまで、何も公開されません。</p>
      </div>
      <div class="postgrid" style="margin-top:16px">
        <div><h4 class="sec-title" style="margin-top:0">掲載プレビュー（このように表示されます）</h4><JobPreview v={v} text={text} reward={reward} reasons={reasons} /></div>
        <div class="stack"><div><h4 class="sec-title" style="margin-top:0">必要なスキルと、その理由</h4><SkillWhy reasons={reasons} /></div>
          <div class="field"><label>対価</label><input class="input" value={reward} onInput={(e) => setReward((e.target as HTMLInputElement).value)} /></div>
          <div class="field"><label>求人文（編集できます）</label><textarea class="input" rows={9} style="line-height:1.6" value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} /></div></div>
      </div>
    </Modal>
  );
}

const MODE_TEXT: Record<string, string> = {
  ask: 'あなたの確認待ちです。承認するとシフト作成君が打診を始めます。',
  running: '候補に順番に連絡しています。返事が来たら自動で次へ進みます。',
  paused: '一時停止中です。再開するか、手動で進められます。',
  waiting_adjust: '時間をずらす方法で対応できます。承認をお願いします。',
  waiting_post: '全員に打診しましたが埋まりませんでした。求人文を作成しました。掲載の承認をお願いします。',
  posted: '求人を掲載しました。応募を待っています。',
  manual: '手動で対応中です。',
  done: '充足しました。',
};
type CState = 'waiting' | 'quiet' | 'pending' | 'accepted' | 'declined' | 'expired';
const CS: Record<CState, { label: string; cls: string }> = {
  waiting: { label: '順番待ち', cls: '' }, quiet: { label: '夜間のため送信待ち', cls: 'warn' }, pending: { label: '返信待ち', cls: 'pri' },
  accepted: { label: '入れます', cls: 'ok' }, declined: { label: '見送り', cls: '' }, expired: { label: '返信なし', cls: 'warn' },
};

/** 打診リレー：誰に・いつ・どんな文面を送り・どう返ってきたかを1枚ずつ見せる */
export function RelayCard({ s, v, id, rank, cand, openStaff, setPv }: { s: State; v: Vacancy; id: string; rank: number; cand?: Candidate; openStaff: (id: string) => void; setPv: (id: string | null) => void }) {
  const reasons = cand?.reasons ?? [];
  const [open, setOpen] = useState(false);
  const [sched, setSched] = useState(false);
  const st = staffById(id); const a = v.auto!;
  const p0 = a.prob?.[id]; const prob = typeof p0 === 'number' && Number.isFinite(p0) ? Math.min(Math.max(p0, 0), 1) : undefined;
  const offer = v.offers.find((o) => o.staffId === id);
  const state: CState = offer ? offer.status : a.pendingStaff === id ? 'quiet' : 'waiting';
  const sent = s.messages.find((m) => m.thread === `ai:${id}` && m.offer?.vacancyId === v.id);
  const label = `${fmtMD(v.date)} ${v.shift}（${unitName(v.unitId)}）`;
  const planned = `${label}に入れますか？\n人手が足りず、代わりの方を探しています。断っても評価には影響しません。`;
  const cur = state === 'pending' || state === 'quiet';
  return (
    <div class={`rcard${cur ? ' cur' : ''}${state === 'waiting' ? ' wait' : ''}`}>
      <div class="row spread wrap" style="gap:8px">
        <div class="row" style="gap:10px;min-width:0">
          <span class="rank">{rank}</span>
          <div style="min-width:0"><button class="link" onClick={() => openStaff(id)}>{st.name}</button><div class="small">{st.role}・{unitName(st.homeUnit)}</div></div>
        </div>
        <span class={`chip ${CS[state].cls}`}>{CS[state].label}{state === 'pending' && a.waitUntil ? `（〜${stampTime(a.waitUntil)}）` : ''}</span>
      </div>
      {prob !== undefined && <div class="row wrap" style="gap:4px;margin-top:6px"><span class="chip pri" title="過去の打診の記録から学習したモデルの予測です">応諾の見込み {Math.round(prob * 100)}%</span></div>}
      {cand && <CandReason v={v} id={id} cand={cand} />}
      {cand && <MiniChecks c={cand} />}
      <div class="chatprev" style="margin-top:12px">
        <div class="small" style="margin-bottom:4px"><Icon n="chat" sm /> {st.name}さんの「シフト作成君」チャットに{state === 'waiting' || state === 'quiet' ? '送る予定の文面' : '送った文面'}{sent ? `（${hm(sent.at)}）` : ''}</div>
        <div class={`bub bub-ai${state === 'waiting' || state === 'quiet' ? ' plan' : ''}`}>{sent?.text ?? planned}</div>
        {(state === 'pending' || state === 'accepted' || state === 'declined') && <div class="small" style="margin:6px 0 4px;text-align:right">本人の画面：「入れる」「今回は見送る」ボタンが表示されます</div>}
        {state === 'accepted' && <div class="bub bub-me">入れます</div>}
        {state === 'declined' && <div class="bub bub-me">今回は見送ります</div>}
        {state === 'expired' && <div class="bub bub-sys">返信期限を過ぎたため、次の方へ進みました</div>}
        {state === 'pending' && <div class="bub bub-sys">まだ返信がありません</div>}
      </div>
      <div class="row spread wrap" style="margin-top:8px"><span class="row" style="gap:6px"><span class="small">{offer ? `送信 ${hm(offer.at)}` : ''}</span>{cand?.assess && <button class="btn sm" onClick={() => { setPv(id); setSched(!sched); }} aria-expanded={sched}>{sched ? '入った後のスケジュールを閉じる' : 'この人が入った後を見る'}</button>}</span>
        <button class="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '閉じる' : 'この人とのやり取りを全部見る'}</button></div>
      {sched && cand?.assess && <div style="margin-top:10px"><CandBeforeAfter all={s.assignments} v={v} cand={cand} /></div>}
      {open && <div class="thread">
        {s.messages.filter((m) => m.thread === `ai:${id}` && (m.offer?.vacancyId === v.id || (m.at >= (offer?.at ?? '9999') && m.from === 'ai' && !m.proposal))).map((m) => <div key={m.id} class="bub bub-ai"><span class="small">{hm(m.at)} シフト作成君</span><div>{m.text}</div></div>)}
        {!offer && <p class="small">まだ連絡していません。</p>}
      </div>}
    </div>
  );
}

/** 求人が出るまでの道筋。内部の候補で埋まらなかったときだけ進む */
export function PostFlow({ s, v }: { s: State; v: Vacancy }) {
  const a = v.auto!; const [pv, setPv] = useState(false); const [edit, setEdit] = useState(false);
  const exhausted = a.mode === 'waiting_post' || a.mode === 'posted' || !!v.jobPost;
  const filledInside = v.state === 'filled' && !v.jobPost;
  const stage = v.state === 'filled' ? 4 : v.state === 'applied' ? 3 : a.mode === 'posted' || v.state === 'posted' ? 2 : a.mode === 'waiting_post' ? 1 : 0;
  const steps = ['求人文を自動作成', 'あなたが承認', '掲載', '応募→スキル照合', 'あなたが採用'];
  const reasons = skillReasons(s.assignments, v);
  const sp = (i: number) => (filledInside ? 'skip' : exhausted && i < (stage === 4 ? 5 : stage + 1) ? 'on' : exhausted && i === (stage === 4 ? 5 : stage + 1) ? 'cur' : '');
  const E = effSettings(s, v); const reward = E.defaultReward + (v.shift === '夜勤' ? '＋夜勤手当5,000円' : '');
  return (
    <div class={`postflow${exhausted ? ' active' : ''}${filledInside ? ' skipped' : ''}`}>
      <div class="row spread wrap"><b style="font-weight:500"><Icon n="campaign" sm /> {exhausted ? '求人掲載' : '誰も入れなかった場合は、ここから求人になります'}</b>
        {filledInside && <span class="chip ok">打診で埋まったため不要</span>}</div>
      <ol class="pf">{steps.map((t, i) => <li key={t} class={sp(i)}><span class="n">{sp(i) === 'on' ? <Icon n="check" sm /> : i + 1}</span>{t}</li>)}</ol>
      {!exhausted && !filledInside && <p class="small">候補全員に打診しても埋まらないときだけ、シフト作成君が求人文を作ります。掲載はあなたの承認が必要です。</p>}
      {!exhausted && !filledInside && <><button class="btn sm" onClick={() => setPv(!pv)} aria-expanded={pv}>{pv ? '閉じる' : '求人の掲載イメージと必要スキルを見る'}</button>{pv && <div class="postgrid" style="margin-top:8px"><JobPreview v={v} text={jobText(v, reward, E.jobNote)} reward={reward} reasons={reasons} /><div><h4 class="sec-title" style="margin-top:0">必要なスキルと、その理由</h4><SkillWhy reasons={reasons} /></div></div>}</>}
      {exhausted && v.jobPost && <div style="margin-top:8px"><div class="row spread wrap"><span class="small">対価：{v.jobPost.reward}</span><button class="btn sm" onClick={() => setEdit(!edit)}>{edit ? '閉じる' : '求人文を見る'}</button></div>{edit && <pre class="jobtext">{v.jobPost.text}</pre>}</div>}
    </div>
  );
}

export function AutoSettings({ s }: { s: State }) {
  const a = s.autopilot;
  return (
    <div class="page scroll">
      <h1 class="ptitle">自動対応の設定</h1>
      <p class="muted" style="margin-bottom:12px">欠勤・遅刻・早退で欠員が出たときの、シフト作成君の動き方を決めます。欠員ごとに上書きもできます。</p>
      <section class="card">
        <label class="row spread" style="min-height:48px"><span><b style="font-weight:500">シフト作成君に任せる機能を使う</b><div class="small">オフにすると、欠員は手動で対応します。</div></span>
          <input type="checkbox" class="sw" checked={a.enabled} onChange={(e) => updateAutopilot({ enabled: (e.target as HTMLInputElement).checked })} /></label>
        <div style={a.enabled ? 'margin-top:8px' : 'opacity:.5;pointer-events:none;margin-top:8px'}><SettingsForm val={a} onChange={updateAutopilot} /></div>
        <p class="small" style="margin-top:12px">現在の判定：{inQuiet(s.now, a) ? '連絡しない時間です。打診は終了時刻まで待ちます。' : '連絡できる時間です。'}</p>
      </section>
      <div class="grid2" style="margin-top:12px">
        <section class="card"><h3 class="h3"><Icon n="smart_toy" sm /> 「任せる」を押すと</h3>
          <ol class="flow"><li><b>① 時間調整の確認</b>休憩をずらす・他ユニットの応援・出退勤の調整を、単独または組み合わせて確認します。</li><li><b>② 代わりの出勤者に打診</b>優先順に1人ずつ連絡し、返信がなければ次へ進みます。</li><li><b>③ 求人</b>誰も入れない場合だけ、条件から求人文を作ります。</li></ol></section>
        <section class="card"><h3 class="h3"><Icon n="how_to_reg" sm /> あなたが承認すること</h3>
          <ul class="flow"><li><b>ほかの職員に影響する時間調整</b>反映前に必ず承認を求めます。</li><li><b>求人の掲載</b>必ず承認が必要です。</li><li><b>応募者の採用</b>必須スキルを確認してから、あなたが決めます。</li><li><b>いつでも止められます</b>一時停止・手動への切替ができます。</li></ul></section>
      </div>
      <section class="card" style="margin-top:12px"><h3 class="h3">候補の選び方（自動で守るルール）</h3>
        <ul class="flow"><li>連勤（6連勤以上）、勤務間11時間未満、夜勤明け、退勤上限、週の勤務上限に当てはまる人には打診しません。</li><li>人数・必須スキル・休憩の交代が成り立たない人は、自動では打診しません（理由は欠員の詳細で確認できます）。</li><li>休みの連絡をした本人には打診しません。</li><li>提案は本人の承諾ではありません。断っても評価に影響しない旨を本人に伝えます。</li></ul></section>
    </div>
  );
}

/** デモ用：時刻を進める（返信待ち時間の経過や夜間の連絡禁止を見せる）。実際の業務画面とは別枠 */
export function DemoClock({ s }: { s: State }) {
  const pend = s.vacancies.filter((v) => v.auto?.mode === 'running' && v.offers.some((o) => o.status === 'pending')).length;
  return (
    <div class="demo-bar" style="flex-wrap:wrap">
      <span>デモ時刻 {s.now}{inQuiet(s.now, s.autopilot) ? '（連絡しない時間）' : ''}</span>
      <button onClick={() => advanceClock(30)}>+30分</button>
      <button onClick={() => advanceClock(120)}>+2時間</button>
      {pend > 0 && <span>打診中 {pend}件</span>}
    </div>
  );
}
