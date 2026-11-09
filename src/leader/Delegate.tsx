import { useMemo } from 'preact/hooks';
import { SKILLS, staffById, unitName } from '../core/facility';
import { fmtMD, stampTime } from '../core/dates';
import { proposeAdjustments, skillReasons } from '../core/roster';
import type { AdjustPlan, Candidate } from '../core/roster';
import {
  applyAdjustment, approveAutopilot, clearVacancyOpts, jobText, confirmApplicant, declineAutopilot, effSettings, pauseAutopilot, respondOffer,
  resumeAutopilot, setVacancyOpts, simulateApplication, skipAdjustment, skipCandidate, startAutopilot,
} from '../core/store';
import type { State } from '../core/store';
import type { Vacancy } from '../core/types';
import { Icon } from '../shared/ui';
import { DayImpact, PlanBeforeAfter, ResolvedView, SkillSituation } from './Impact';
import { Applicants, JobPreview, PRIORITY_NOTE, SkillWhy } from './Job';
import { PostFlow, PostSheet, RelayCard } from './Auto';
import { PLAN_LABEL } from './Adjust';
import { SettingsForm } from './Settings';
import { hm } from './util';
import type { Go } from './util';
import { useState } from 'preact/hooks';

export const findPlan = (s: State, v: Vacancy): AdjustPlan | undefined => (v.auto?.planId ? proposeAdjustments(s.assignments, v).find((p) => p.id === v.auto!.planId) : undefined);
const names = (ids: string[]) => ids.map((id) => staffById(id).name).join('、');

/** 4つの段階：時間調整の確認 → 打診 → 求人 → 充足 */
export function Steps4({ v, s }: { v: Vacancy; s: State }) {
  const a = v.auto; const m = a?.mode;
  const usedJob = !!v.jobPost || m === 'waiting_post' || m === 'posted' || v.state === 'applied' || v.state === 'posted';
  const adj = effSettings(s, v).useAdjust;
  const st: ('on' | 'cur' | 'skip' | '')[] =
    v.state === 'filled' ? (v.resolvedBy === 'adjust' ? ['on', 'skip', 'skip', 'on'] : usedJob ? ['on', 'on', 'on', 'on'] : [adj ? 'on' : 'skip', 'on', 'skip', 'on'])
      : m === 'waiting_adjust' ? ['cur', '', '', '']
        : m === 'running' || m === 'paused' ? [adj ? 'on' : 'skip', 'cur', '', '']
          : m === 'waiting_post' || m === 'posted' || usedJob ? [adj ? 'on' : 'skip', 'on', 'cur', '']
            : ['', '', '', ''];
  return <div class="stepper steps4">{['時間調整の確認', '打診', '求人', '充足'].map((t, i) => <div key={t} class={`st${st[i] === 'on' ? ' on' : ''}${st[i] === 'cur' ? ' cur' : ''}${st[i] === 'skip' ? ' skip' : ''}`}><span class="n">{st[i] === 'on' ? <Icon n="check" sm /> : i + 1}</span>{t}</div>)}</div>;
}

/** ほかの職員に影響する時間調整の承認 */
export function AdjustApprovalCard({ s, v, openStaff, onPreview }: { s: State; v: Vacancy; openStaff?: (id: string) => void; onPreview?: () => void }) {
  const plan = useMemo(() => findPlan(s, v), [s.assignments, v.id, v.auto?.planId]);
  return (
    <section class="card askcard">
      <div class="row spread wrap" style="gap:8px"><div class="row" style="gap:8px"><Icon n="swap_horiz" /><b style="font-weight:500">時間の調整の承認</b></div><span class="chip warn">あなたの承認待ち</span></div>
      <p class="muted" style="margin-top:4px">{fmtMD(v.date)} {v.shift}／{unitName(v.unitId)}：時間をずらす方法で対応できます。</p>
      {plan ? <div class="plan sel" style="margin-top:8px">
        <div class="row wrap" style="gap:6px"><b style="font-weight:500">{plan.title}</b>{plan.kind === 'combo' && <span class="chip pri">組み合わせ</span>}<span class="chip ok">手薄な時間が解消します</span></div>
        <ul>{plan.changes.map((c) => <li key={c.assignmentId}>{c.text}</li>)}</ul>
        <div style="margin-top:10px"><PlanBeforeAfter all={s.assignments} v={v} plan={plan} /></div>
        {plan.caution && <p class="small" style="margin-top:6px"><Icon n="info" sm /> {plan.caution}</p>}
        <p class="small" style="margin-top:6px;color:var(--tx)">承認すると、影響する職員に通知します：{openStaff ? plan.affected.map((id, i) => <span key={id}>{i ? '、' : ''}<button class="link" onClick={() => openStaff(id)}>{staffById(id).name}</button></span>) : names(plan.affected)}</p>
      </div> : <p class="small" style="margin-top:8px">この調整案は、状況が変わったため確認できません。別の方法に進めてください。</p>}
      <div class="row wrap" style="margin-top:12px">
        {plan && <button class="btn pri" onClick={() => applyAdjustment(v.id, v.auto!.planId!)}>この調整を承認</button>}
        <button class="btn" onClick={() => skipAdjustment(v.id)}>別の方法で（打診へ）</button>
        {onPreview && plan && <button class="btn sm" onClick={onPreview}>採用された後のようすを見る</button>}
      </div>
    </section>
  );
}

export function ResultCard({ s, v, go, openStaff }: { s: State; v: Vacancy; go: Go; openStaff: (id: string) => void }) {
  const adjustLog = [...(v.auto?.log ?? [])].reverse().find((l) => l.text.startsWith('リーダーが調整案'));
  const changes = adjustLog ? adjustLog.text.replace(/^リーダーが調整案「[^」]*」を承認しました。/, '').split('／').filter(Boolean) : [];
  const who = v.filledBy; const accepted = v.offers.find((o) => o.status === 'accepted');
  const rank = who ? (v.auto?.queue.indexOf(who) ?? -1) + 1 : 0;
  const hired = !!v.jobPost && who && who.startsWith('EMP-9');
  const title = v.resolvedBy === 'adjust' ? '時間の調整で対応しました' : hired ? `求人で採用しました：${staffById(who!).name}さんが入ります` : accepted && who ? `${rank > 0 ? `${rank}人目の` : ''}${staffById(who).name}さんが入ります` : who ? `${staffById(who).name}さんを割り当てました` : '対応済みです';
  return (
    <section class="card okcard">
      <h3 class="h3"><Icon n="check_circle" fill /> {title}</h3>
      <Steps4 v={v} s={s} />
      <h4 class="sec-title" style="margin:12px 0 6px">どう解消したか（該当の行だけ）</h4>
      {v.resolution ? <ResolvedView s={s} v={v} /> : v.resolvedBy === 'adjust' && changes.length > 0 ? <ul style="margin:8px 0 0 18px;font-size:14px">{changes.map((t, i) => <li key={i}>{t}</li>)}</ul> : <p class="small">対応の記録が残っていません。</p>}
      <p class="muted" style="margin-top:8px">日次・月次に反映済みで、関係する職員へ通知しました（モック）。{who && !v.resolvedBy && <> <button class="link" onClick={() => openStaff(who)}>{staffById(who).name}さんを見る</button></>}</p>
      <div class="row wrap" style="margin-top:8px"><button class="btn sm" onClick={() => go('day', { date: v.date })}><Icon n="schedule" sm /> その日の1日を見る</button></div>
    </section>
  );
}

/** 欠員の主カード（いつも最上部）。1画面1つの主操作 */
export function MainCard({ s, v, openStaff, onSettings, onManual, onPreviewPlan }: { s: State; v: Vacancy; openStaff: (id: string) => void; onSettings: () => void; onManual: () => void; onPreviewPlan: () => void }) {
  const a = v.auto; const m = a?.mode;
  const [post, setPost] = useState(false);
  const reasons = useMemo(() => skillReasons(s.assignments, v), [s.assignments, v.id]);
  if (m === 'waiting_adjust') return <div class="stack" style="gap:8px"><Steps4 v={v} s={s} /><AdjustApprovalCard s={s} v={v} openStaff={openStaff} onPreview={onPreviewPlan} /></div>;
  const pend = v.offers.find((o) => o.status === 'pending');
  const req = reasons.filter((r) => r.level === '必須' && r.skill !== 'night');
  return (
    <section class="card delegate">
      <div class="row spread wrap" style="gap:8px"><div class="row" style="gap:8px"><Icon n="smart_toy" /><b style="font-weight:500">シフト作成君</b></div>
        {m === 'running' && <span class="chip pri">対応中</span>}{m === 'paused' && <span class="chip">一時停止</span>}{m === 'waiting_post' && <span class="chip warn">求人の承認待ち</span>}{m === 'posted' && <span class="chip pri">求人掲載中</span>}</div>

      {(!a || m === 'ask') && <>
        <p style="margin-top:8px">この欠員を、シフト作成君に任せますか？</p>
        <button class="btn pri block mainbtn" onClick={() => { const o = { max: effSettings(s, v).maxCandidates }; if (a) approveAutopilot(v.id, o); else startAutopilot(v.id, o); }}>シフト作成君に任せる</button>
        <p class="small" style="margin-top:8px">時間をずらして足りるか確認 → 代わりの出勤者に打診 → 求人。他の職員に影響する調整と、求人の掲載だけ、あなたの承認を待ちます。</p>
        <div class="row wrap" style="margin-top:8px;gap:16px"><button class="linkbtn" onClick={onSettings}>詳細設定</button><button class="linkbtn" onClick={onManual}>自分で対応する（手動）</button></div>
      </>}

      {(m === 'running' || m === 'paused') && a && <>
        <div style="margin-top:12px"><Steps4 v={v} s={s} /></div>
        <p style="margin-top:12px">{m === 'paused' ? '一時停止中です。' : a.pendingStaff && a.waitUntil ? `夜間のため、${staffById(a.pendingStaff).name}さんへは ${stampTime(a.waitUntil)} に連絡します。` : pend ? `${staffById(pend.staffId).name}さんの返事を待っています${a.waitUntil ? `（〜${stampTime(a.waitUntil)}）` : ''}。` : '次の候補を選んでいます。'}</p>
        {a.queue.length > 0 && <p class="small" style="margin-top:2px">{Math.min(a.idx, a.queue.length)}人目／全{a.queue.length}人。返事がなければ自動で次の方へ進みます。</p>}
        <div class="row wrap" style="margin-top:12px">{m === 'paused' ? <button class="btn sm pri" onClick={() => resumeAutopilot(v.id)}><Icon n="play_arrow" sm /> 再開</button> : <button class="btn sm" onClick={() => pauseAutopilot(v.id)}><Icon n="pause" sm /> 一時停止</button>}
          <button class="btn sm" onClick={onManual}>手動に切替</button></div>
        {m === 'running' && pend && <div class="demo-sim row wrap"><span class="small">デモ：返信を模擬</span><button class="btn sm" onClick={() => respondOffer(v.id, pend.staffId, true)}>入れる</button><button class="btn sm" onClick={() => respondOffer(v.id, pend.staffId, false)}>見送る</button></div>}
      </>}

      {m === 'waiting_post' && <>
        <div style="margin-top:12px"><Steps4 v={v} s={s} /></div>
        <p style="margin-top:12px">打診では埋まりませんでした。求人文を作成しました。掲載の承認をお願いします。</p>
        <div class="row wrap" style="gap:6px;margin-top:8px"><span class="chip">対価：{v.jobPost?.reward}</span>{req.map((r) => <span key={r.skill} class="chip bad">必須：{SKILLS[r.skill].label}</span>)}</div>
        <div class="row wrap" style="margin-top:12px"><button class="btn pri" onClick={() => setPost(true)}>求人文を確認して承認</button><button class="btn sm" onClick={onManual}>手動に切替</button></div>
      </>}

      {m === 'posted' && <>
        <div style="margin-top:12px"><Steps4 v={v} s={s} /></div>
        {v.state === 'posted' && <><p style="margin-top:12px">求人を掲載しました（モック）。応募を待っています。</p>
          <div class="demo-sim row wrap"><span class="small">デモ：応募の受付</span><button class="btn sm" onClick={() => simulateApplication(v.id)}>応募を受け取る</button></div></>}
        {v.state === 'applied' && <div style="margin-top:12px"><h4 class="sec-title" style="margin-top:0">応募者（必須スキルを自動で照合しました）</h4><Applicants v={v} reasons={reasons} onHire={(id) => confirmApplicant(v.id, id)} /></div>}
      </>}
      {post && v.jobPost && <PostSheet v={v} reasons={reasons} onClose={() => setPost(false)} />}
    </section>
  );
}

/** 詳細を見る（読み取り中心。AIが何を検討し、何をしたか） */
export function DetailPanel({ s, v, ranked, plans, pv, setPv, pp, setPp, openStaff, open, setOpen, showImpact }: { s: State; v: Vacancy; ranked: Candidate[]; plans: AdjustPlan[]; pv: string | null; setPv: (id: string | null) => void; pp: string | null; setPp: (id: string | null) => void; openStaff: (id: string) => void; open: boolean; setOpen: (b: boolean) => void; showImpact: boolean }) {
  const a = v.auto; const plan = plans.find((p) => p.id === pp) ?? null;
  const ids = a ? Array.from(new Set([...a.queue, ...v.offers.map((o) => o.staffId)])) : [];
  const E = effSettings(s, v); const reasons = skillReasons(s.assignments, v);
  const reward = E.defaultReward + (v.shift === '夜勤' ? '＋夜勤手当5,000円' : '');
  const filled = v.state === 'filled';
  return (
    <details class="card detailcard" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary class="h3" style="cursor:pointer">詳細を見る <span class="small">（時間調整の検討・打診の経過・求人・スキル・スケジュール・ログ）</span></summary>
      {open && <div class="stack" style="gap:20px;margin-top:12px">
        {showImpact && <DayImpact s={s} v={v} ranked={ranked} pv={pv} setPv={setPv} plan={plan} planName={plan ? PLAN_LABEL[plans.indexOf(plan)] : undefined} closePlan={() => setPp(null)} />}

        <div><h4 class="sec-title" style="margin-top:0">時間調整の検討結果</h4>
          {!filled && plans.length === 0 && <p class="muted">時間のずらしだけで対応できる案はありません。代わりの出勤者を探します。</p>}
          {filled && v.resolvedBy !== 'adjust' && <p class="muted">時間調整は使わずに対応しました。</p>}
          <div class="stack" style="gap:8px">{!filled && plans.map((p, i) => (
            <div key={p.id} class={`plan${a?.planId === p.id ? ' sel' : ''}`}>
              <div class="row spread wrap" style="gap:6px"><div class="row wrap" style="gap:6px"><span class="lab">{PLAN_LABEL[i]?.slice(1) ?? '・'}</span><b style="font-weight:500">{p.title}</b>{p.kind === 'combo' && <span class="chip pri">組み合わせ</span>}{a?.planId === p.id && <span class="chip warn">承認待ち</span>}</div>
                <span class={`chip ${p.resolves ? 'ok' : p.kind === 'swap' ? '' : 'warn'}`}>{p.resolves ? '手薄な時間が解消します' : p.kind === 'swap' ? '人数は変わりません' : `${p.remaining.length}か所まだ手薄`}</span></div>
              <ul>{p.changes.map((c) => <li key={c.assignmentId}>{c.text}</li>)}</ul>
              <details class="ba" open><summary class="small" style="cursor:pointer;margin-top:8px">いま／この案の後のスケジュール（該当の行だけ）</summary><div style="margin-top:8px"><PlanBeforeAfter all={s.assignments} v={v} plan={p} name={PLAN_LABEL[i]} /></div></details>
            </div>))}</div>
          <p class="small" style="margin-top:6px">単独で足りないときは、方法を組み合わせて確認します。反映には必ずあなたの承認が必要です。</p>
        </div>

        {ids.length > 0 && a && <div><h4 class="sec-title" style="margin-top:0">打診リレー（優先順）</h4><p class="small" style="margin:-4px 0 8px">{PRIORITY_NOTE}</p>
          <div class="relay">{ids.map((id, i) => <RelayCard key={id} s={s} v={v} id={id} rank={i + 1} cand={ranked.find((c) => c.staff.id === id)} openStaff={openStaff} setPv={setPv} />)}</div>
          {a.mode === 'running' && v.offers.some((o) => o.status === 'pending') && <div class="row wrap" style="margin-top:8px"><button class="btn sm" onClick={() => skipCandidate(v.id)}>いまの方を飛ばして次の候補へ</button></div>}</div>}

        <div><h4 class="sec-title" style="margin-top:0">求人（誰も入れない場合）</h4>
          {a ? <PostFlow s={s} v={v} /> : <div class="postgrid"><JobPreview v={v} text={jobText(v, reward, E.jobNote)} reward={reward} reasons={reasons} /><div><h4 class="sec-title" style="margin-top:0">必要なスキルと、その理由</h4><SkillWhy reasons={reasons} /></div></div>}</div>

        {!filled && <SkillSituation s={s} v={v} ranked={ranked} openStaff={openStaff} />}

        {a && <div><h4 class="sec-title" style="margin-top:0">シフト作成君の動き（時系列）</h4>
          <ol class="alog">{a.log.map((l, i) => <li key={i} class={l.kind}><span class="at">{hm(l.at)}</span><span class="mk" aria-hidden="true" /><span>{l.text}</span></li>)}</ol></div>}
      </div>}
    </details>
  );
}

/** 詳細設定（この欠員だけ。全体の設定を上書き） */
export function SettingsPanel({ s, v, open, setOpen }: { s: State; v: Vacancy; open: boolean; setOpen: (b: boolean) => void }) {
  return (
    <details class="card detailcard" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary class="h3" style="cursor:pointer">詳細設定 <span class="small">（この欠員だけ）</span>{v.opts && <span class="chip pri" style="margin-left:8px">上書き中</span>}</summary>
      {open && <div style="margin-top:12px">
        <p class="small" style="margin-bottom:8px">この欠員だけの設定です。任せたあとに変えた内容は、これからの手順に反映されます（すでに終わった手順は変わりません）。</p>
        <SettingsForm val={effSettings(s, v)} onChange={(p) => setVacancyOpts(v.id, p)} />
        {v.opts && <div class="row wrap" style="margin-top:12px"><button class="btn sm" onClick={() => clearVacancyOpts(v.id)}>全体の設定に戻す</button></div>}
      </div>}
    </details>
  );
}

export { declineAutopilot };
