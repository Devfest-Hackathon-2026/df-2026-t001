import { useEffect, useMemo } from 'preact/hooks';
import { SHIFTS, SKILLS, staffById, unitName } from '../core/facility';
import { addDays, fmtMD, stampTime } from '../core/dates';
import { proposeAdjustments, skillReasons } from '../core/roster';
import type { AdjustPlan, Candidate } from '../core/roster';
import {
  applyAdjustment, clearVacancyOpts, delegateAutopilot, demoApplication, demoPlan, demoReply, jobText, confirmApplicant, declineAutopilot, effSettings, pauseAutopilot, rejectJobPost, resumeAutopilot, setVacancyOpts, skipAdjustment, skipCandidate, startAutopilot,
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
import { ReplanNote, SolverPlanCard } from './ReplanCard';
import type { Go } from './util';
import { useState } from 'preact/hooks';

export const findPlan = (s: State, v: Vacancy): AdjustPlan | undefined => (v.auto?.planId ? proposeAdjustments(s.assignments, v).find((p) => p.id === v.auto!.planId) : undefined);
const names = (ids: string[]) => ids.map((id) => staffById(id).name).join('、');

/** 調整案が通した確認（勤務間隔11時間・翌日の勤務）を、変更ごとに文章にする（roster.ts の判定結果をそのまま表示） */
export function adjustChecks(all: State['assignments'], plan: AdjustPlan): string[] {
  const out: string[] = [];
  for (const c of plan.changes) {
    const a = all.find((x) => x.id === c.assignmentId); const nm = staffById(c.staffId).name; if (!a) continue;
    const end = c.adjust.endAt;
    if (end === undefined) { out.push(`${nm}さん：勤務時間は延びないため、勤務間隔への影響はありません`); continue; }
    const n = all.find((x) => x.staffId === a.staffId && x.date === addDays(a.date, 1) && x.status !== 'absent');
    out.push(n ? `${nm}さん：翌日は${n.shift}。勤務間隔 ${Math.floor((1440 + SHIFTS[n.shift].start - end) / 60)}時間（基準 11時間以上）で問題ありません` : `${nm}さん：翌日の勤務はなく、勤務間隔 11時間以上を確保しています`);
  }
  return out;
}

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
  const nPlans = useMemo(() => { const E = effSettings(s, v); const k = (Object.keys(E.adjustKinds) as ('break' | 'support' | 'extend')[]).filter((x) => E.adjustKinds[x]); return proposeAdjustments(s.assignments, v, [...k, 'combo']).filter((p) => p.resolves).length; }, [s.assignments, v.id]);
  if (v.auto?.planId === 'solver') return <SolverPlanCard v={v} />;
  return (
    <section class="card askcard">
      <div class="row spread wrap" style="gap:8px"><div class="row" style="gap:8px"><Icon n="swap_horiz" /><b style="font-weight:500">時間の調整の承認</b></div><span class="chip warn">あなたの承認待ち</span></div>
      <p style="margin-top:4px">{fmtMD(v.date)} {v.shift}／{unitName(v.unitId)}：時間をずらして対応できます。</p>
      {plan ? <div class="plan sel" style="margin-top:8px">
        {nPlans > 0 && <p class="small" style="margin-bottom:4px">条件を満たす {nPlans} 案のうち、変更が最小の案</p>}
        <div class="row wrap" style="gap:6px"><b style="font-weight:500">{plan.title}</b>{plan.kind === 'combo' && <span class="chip pri">組み合わせ</span>}<span class="chip ok">手薄な時間が解消します</span></div>
        <ul>{plan.changes.map((c) => <li key={c.assignmentId}>{c.text}</li>)}</ul>
        <ul class="small" style="margin-top:6px">{adjustChecks(s.assignments, plan).map((x, i) => <li key={i}><Icon n="check" sm /> {x}</li>)}</ul>
        <ReplanNote v={v} />
        <details class="more"><summary>変更前後のスケジュール</summary><PlanBeforeAfter all={s.assignments} v={v} plan={plan} />{plan.caution && <p class="small" style="margin-top:6px"><Icon n="info" sm /> {plan.caution}</p>}</details>
        <p class="small" style="margin-top:6px;color:var(--tx)">承認すると通知する職員：{openStaff ? plan.affected.map((id, i) => <span key={id}>{i ? '、' : ''}<button class="link" onClick={() => openStaff(id)}>{staffById(id).name}</button></span>) : names(plan.affected)}</p>
      </div> : <p class="small" style="margin-top:8px">この調整案は、状況が変わったため確認できません。別の方法に進めてください。</p>}
      <div class="row wrap" style="margin-top:12px">
        {plan && <button class="btn pri" onClick={() => applyAdjustment(v.id, v.auto!.planId!)}>この調整を承認</button>}
        <button class="btn" onClick={() => skipAdjustment(v.id)}>別の方法で（打診へ）</button>
        
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
      <p class="muted" style="margin-top:8px">日次・月次に反映済みで、関係する職員へ通知しました。{who && !v.resolvedBy && <> <button class="link" onClick={() => openStaff(who)}>{staffById(who).name}さんを見る</button></>}</p>
      <div class="row wrap" style="margin-top:8px"><button class="btn sm" onClick={() => go('day', { date: v.date })}><Icon n="schedule" sm /> その日の1日を見る</button></div>
    </section>
  );
}

/** 打診の相手とのチャット（アコーディオン）。開くとデモの返信が自動で進む */
function OfferChat({ s, v, staffId }: { s: State; v: Vacancy; staffId: string }) {
  const [open, setOpen] = useState(false);
  const msgs = s.messages.filter((m) => m.thread === `ai:${staffId}`).slice(-4);
  const replied = msgs.some((m) => m.from === staffId);
  useEffect(() => { if (open) demoReply(v.id, staffId); }, [open, staffId, v.id]);
  return (
    <details class="ochat" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary><Icon n="chat" sm /> {staffById(staffId).name}さんとのチャット</summary>
      <div class="ochat-body">
        {msgs.map((m) => <div key={m.id} class={`ob ${m.from === 'ai' ? 'l' : 'r'}`}><span class="small">{m.from === 'ai' ? 'シフト作成君' : staffById(m.from).name}</span><div>{m.text}</div></div>)}
        {open && !replied && demoPlan(v, staffId) !== 'silent' && <div class="ob r typing"><span class="small">{staffById(staffId).name}さん</span><div>入力中…</div></div>}
        {open && !replied && demoPlan(v, staffId) === 'silent' && <p class="small">まだ返信がありません（未読）。期限を過ぎると、自動で次の候補へ進みます。</p>}
      </div>
    </details>
  );
}

/** 広い画面で欠員詳細の右に常設するチャット（シフト作成君と打診先のやり取り） */
export function ChatPanel({ s, v }: { s: State; v: Vacancy }) {
  const a = v.auto;
  const ids = Array.from(new Set(v.offers.map((o) => o.staffId)));
  const pend = v.offers.find((o) => o.status === 'pending')?.staffId;
  const [tab, setTab] = useState<string>('all');
  const sel = tab !== 'all' && !ids.includes(tab) ? 'all' : tab;
  useEffect(() => { if (a?.mode === 'running' && pend) demoReply(v.id, pend); }, [a?.mode, pend, v.id]);
  const msgs = s.messages.filter((m) => (sel === 'all' ? ids.some((i) => m.thread === `ai:${i}`) : m.thread === `ai:${sel}`));
  const typing = a?.mode === 'running' && !!pend && (sel === 'all' || sel === pend) && !s.messages.some((m) => m.thread === `ai:${pend}` && m.from === pend);
  return (
    <aside class="chatdock" aria-label="打診のチャット">
      <div class="row" style="gap:8px;padding:12px 14px 8px"><Icon n="chat" /><b style="font-weight:500">打診のチャット</b></div>
      <div class="chatdock-tabs" role="tablist"><button role="tab" aria-selected={sel === 'all'} onClick={() => setTab('all')}>全体</button>
        {ids.map((id) => <button key={id} role="tab" aria-selected={sel === id} onClick={() => setTab(id)}>{staffById(id).name}{id === pend && <span class="dot" />}</button>)}</div>
      <div class="chatdock-body scroll">
        {msgs.map((m) => <div key={m.id} class={`ob ${m.from === 'ai' ? 'l' : 'r'}`}><span class="small">{m.from === 'ai' ? 'シフト作成君' : staffById(m.from).name}</span><div>{m.text}</div></div>)}
        {typing && pend && <div class="ob r typing"><span class="small">{staffById(pend).name}さん</span><div>入力中…</div></div>}
        {!msgs.length && !typing && <div class="empty">まだやり取りはありません。</div>}
      </div>
    </aside>
  );
}

/** 欠員の主カード（いつも最上部）。1行の状態＋主ボタン1つ。ほかは折りたたみ */
export function MainCard({ s, v, openStaff, onSettings, onManual, onPreviewPlan, docked }: { docked?: boolean; s: State; v: Vacancy; openStaff: (id: string) => void; onSettings: () => void; onManual: () => void; onPreviewPlan: () => void }) {
  const a = v.auto; const m = a?.mode;
  const [post, setPost] = useState(false);
  const [busy, setBusy] = useState(false);
  const reasons = useMemo(() => skillReasons(s.assignments, v), [s.assignments, v.id]);
  useEffect(() => { if (v.state === 'posted' && m === 'posted') demoApplication(v.id); }, [v.state, m, v.id]);
  if (m === 'waiting_adjust') return <div class="stack" style="gap:8px"><AdjustApprovalCard s={s} v={v} openStaff={openStaff} onPreview={onPreviewPlan} /></div>;
  const pend = v.offers.find((o) => o.status === 'pending');
  return (
    <section class="card delegate">
      <div class="row spread wrap" style="gap:8px"><div class="row" style="gap:8px"><Icon n="smart_toy" /><b style="font-weight:500">シフト作成君</b></div>
        {m === 'running' && <span class="chip pri">対応中</span>}{m === 'paused' && <span class="chip">一時停止</span>}{m === 'waiting_post' && <span class="chip warn">承認待ち</span>}{m === 'posted' && <span class="chip pri">求人掲載中</span>}</div>

      {(!a || m === 'ask') && <>
        <p style="margin-top:8px">この欠員を、シフト作成君に任せますか？</p>
        <button class="btn pri block mainbtn" disabled={busy} onClick={() => { setBusy(true); void delegateAutopilot(v.id, { max: effSettings(s, v).maxCandidates }, !a).finally(() => setBusy(false)); }}>{busy ? '候補を確認中…' : '承認して、シフト作成君に任せる'}</button>
        <details class="more"><summary>くわしく</summary>
          <p class="small">時間をずらして足りるか確認 → 代わりの出勤者に打診 → 求人。他の職員に影響する調整と、求人の掲載だけ、あなたの承認を待ちます。</p>
          <div class="row wrap" style="gap:16px"><button class="linkbtn" onClick={onSettings}>詳細設定</button><button class="linkbtn" onClick={onManual}>自分で対応する（手動）</button></div></details>
      </>}

      {(m === 'running' || m === 'paused') && a && <>
        <p style="margin-top:8px">{m === 'paused' ? '一時停止中です。' : a.pendingStaff && a.waitUntil ? `${staffById(a.pendingStaff).name}さんへは ${stampTime(a.waitUntil)} に連絡します（夜間のため）。` : pend ? `${staffById(pend.staffId).name}さんの返事を待っています${a.waitUntil ? `（〜${stampTime(a.waitUntil)}）` : ''}。` : '次の候補を選んでいます。'}</p>
        {m === 'running' && pend && !docked && <OfferChat s={s} v={v} staffId={pend.staffId} />}
        <div class="row wrap" style="margin-top:8px">{m === 'paused' ? <button class="btn sm pri" onClick={() => resumeAutopilot(v.id)}><Icon n="play_arrow" sm /> 再開</button> : <button class="btn sm" onClick={() => pauseAutopilot(v.id)}><Icon n="pause" sm /> 一時停止</button>}
          <button class="btn sm" onClick={onManual}>手動に切替</button></div>
        <details class="more"><summary>進み具合</summary><Steps4 v={v} s={s} />{a.queue.length > 0 && <p class="small" style="margin-top:6px">{Math.min(a.idx, a.queue.length)}人目／全{a.queue.length}人。返事がなければ自動で次の方へ進みます。</p>}</details>
      </>}

      {m === 'waiting_post' && <>
        <p style="margin-top:8px">打診では埋まりませんでした。求人の掲載を承認してください。</p>
        <button class="btn pri block mainbtn" onClick={() => setPost(true)}>求人を確認して承認</button>
        <div class="row wrap" style="margin-top:8px"><button class="linkbtn" onClick={onManual}>手動に切替</button></div>
      </>}

      {m === 'posted' && <>
        {v.state === 'posted' && <><p style="margin-top:8px"><span class="dots">求人を掲載しました。応募を待っています</span>（数秒で届きます）</p><div class="row wrap" style="margin-top:8px"><span class="small">内容は「詳細を見る」の求人で確認できます。</span><button class="linkbtn" onClick={() => rejectJobPost(v.id)}>掲載を取り消す</button></div></>}
        {v.state === 'applied' && <div style="margin-top:8px"><p style="margin-bottom:8px">応募が届きました。採用する方を選んでください。</p><Applicants v={v} reasons={reasons} onHire={(id) => confirmApplicant(v.id, id)} /></div>}
        <details class="more"><summary>進み具合</summary><Steps4 v={v} s={s} /></details>
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
