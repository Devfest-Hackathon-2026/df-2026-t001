import { useEffect, useMemo, useState } from 'preact/hooks';
import { SKILLS, staffById, unitName } from '../core/facility';
import { fmtMD } from '../core/dates';
import { proposeAdjustments, rankCandidates, skillReasons } from '../core/roster';
import { assignStaff, confirmApplicant, declineAutopilot, effSettings, offerTo, postJob, respondOffer, simulateApplication, delegateAutopilot, demoApplication } from '../core/store';
import type { State } from '../core/store';
import { Icon, Modal } from '../shared/ui';
import type { Go } from './util';
import { Back, VAC_STATE, VAC_STEPS, useWide } from './util';
import { ChatPanel, DetailPanel, MainCard, ResultCard, SettingsPanel } from './Delegate';
import { DayImpact, MiniChecks, SkillSituation } from './Impact';
import { ManualBoard } from './Manual';
import { AdjustSection, PLAN_LABEL } from './Adjust';
import { Applicants, PRIORITY_NOTE, ReasonChips } from './Job';

export function Vacancies({ s, vacId, go, openStaff }: { s: State; vacId?: string; go: Go; openStaff: (id: string) => void }) {
  const wide = useWide(900);
  const [listOpen, setListOpen] = useState(!vacId);
  const list = useMemo(() => s.vacancies.slice().sort((a, b) => (a.state === 'filled' ? 1 : 0) - (b.state === 'filled' ? 1 : 0) || a.date.localeCompare(b.date)), [s.vacancies]);
  const v = s.vacancies.find((x) => x.id === vacId) ?? (wide ? list[0] : undefined);
  const listEl = (
    <div class="vac-list scroll">
      {list.map((x) => <button key={x.id} class={`vitem${v?.id === x.id ? ' sel' : ''}`} onClick={() => { go('vac', { vacId: x.id }); setListOpen(false); }}>
        <div class="row spread"><b style="font-weight:500">{fmtMD(x.date)} {x.shift}</b><span class={`chip ${VAC_STATE[x.state].cls}`}>{VAC_STATE[x.state].label}</span></div>
        <div class="small">{unitName(x.unitId)}{x.needSkills.length ? `／必須：${x.needSkills.filter((k) => k !== 'night').map((k) => SKILLS[k].label).join('・')}` : ''}{x.auto && x.state !== 'filled' ? `／${{ ask: '確認待ち', running: 'シフト作成君が対応中', paused: '一時停止', waiting_adjust: '時間調整の承認待ち', waiting_post: '求人の承認待ち', posted: '求人掲載中', manual: '手動で対応中', done: '' }[x.auto.mode]}` : ''}</div></button>)}
      {!list.length && <div class="empty">欠員はありません。</div>}
    </div>
  );
  if (!wide) return v ? <div class="page scroll"><Back onClick={() => go('vac', { vacId: undefined })} /><VacDetail key={v.id} s={s} v={v} go={go} openStaff={openStaff} /></div> : <div class="page scroll">{listEl}</div>;
  return (
    <div class="split">
      {listOpen && <div class="vac-left"><div class="vac-wrap"><button class="linkbtn vac-tg" onClick={() => setListOpen(false)}><Icon n="chevron_left" sm /> 一覧を畳む</button>{listEl}</div></div>}
      <div class="main-col scroll">
        {!listOpen && <button class="btn sm vac-open" onClick={() => setListOpen(true)} aria-label="欠員の一覧を開く"><Icon n="format_list_bulleted" sm /> 欠員一覧<span class="badge" style="position:static;margin-left:4px">{list.length}</span></button>}
        {v ? <VacDetail key={v.id} s={s} v={v} go={go} openStaff={openStaff} /> : <div class="empty">欠員はありません。</div>}</div>
    </div>
  );
}

function VacDetail({ s, v, go, openStaff }: { s: State; v: State['vacancies'][number]; go: Go; openStaff: (id: string) => void }) {
  const [pv, setPv] = useState<string | null>(null);
  const [pp, setPp] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [setOpen, setSetOpen] = useState(false);
  const [manualLocal, setManualLocal] = useState(false);
  const hopes = Object.fromEntries(Object.entries(s.prefs).map(([k, p]) => [k, p.shiftHope]));
  const filled = v.state === 'filled';
  const cands = useMemo(() => (filled ? [] : rankCandidates(s.assignments, v, hopes, s.availability)), [s.assignments, v.id, v.state, s.prefs, s.availability]);
  const plans = useMemo(() => (filled ? [] : proposeAdjustments(s.assignments, v)), [s.assignments, v.id, v.state]);
  const manual = !filled && (v.auto?.mode === 'manual' || manualLocal);
  const goManual = () => { if (v.auto && v.auto.mode !== 'manual') declineAutopilot(v.id); setManualLocal(true); };
  const dock = useWide(1100) && !filled && !manual && !!v.offers.length;
  const backToAi = () => { setManualLocal(false); void delegateAutopilot(v.id, { max: effSettings(s, v).maxCandidates }, true); };
  return (
    <div class={dock ? 'vdock' : undefined}>
    <div class="stack" style="padding-bottom:24px;margin-top:8px;min-width:0">
      <div class="row spread wrap"><div><h2 class="h2">{fmtMD(v.date)} {v.shift}／{unitName(v.unitId)}</h2><p class="muted">{v.id}／{v.reason}</p></div>
        <div class="row wrap" style="gap:8px"><span class={`chip ${VAC_STATE[v.state].cls}`}>{VAC_STATE[v.state].label}</span><button class="btn sm" onClick={() => go('day', { date: v.date })}><Icon n="schedule" sm /> その日の1日</button></div></div>

      {filled ? <ResultCard s={s} v={v} go={go} openStaff={openStaff} />
        : manual ? <section class="card"><div class="row" style="gap:8px"><Icon n="person" /><b style="font-weight:500">手動で対応中です。シフト作成君は止まっています。</b></div>
          <div class="row wrap" style="margin-top:12px"><button class="btn pri" onClick={backToAi}>シフト作成君に任せる</button></div></section>
          : <MainCard docked={dock} s={s} v={v} openStaff={openStaff} onSettings={() => setSetOpen(true)} onManual={goManual} onPreviewPlan={() => { const p = plans.find((x) => x.id === v.auto?.planId); if (p) setPp(p.id); setDetailOpen(true); setTimeout(() => document.getElementById('dayimpact')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }} />}

      {manual && <ManualPanel s={s} v={v} cands={cands} plans={plans} pv={pv} setPv={setPv} pp={pp} setPp={setPp} openStaff={openStaff} />}
      <DetailPanel s={s} v={v} ranked={cands} plans={plans} pv={pv} setPv={setPv} pp={pp} setPp={setPp} openStaff={openStaff} open={detailOpen} setOpen={setDetailOpen} showImpact={!manual} />
      {!filled && <SettingsPanel s={s} v={v} open={setOpen} setOpen={setSetOpen} />}
    </div>
    {dock && <ChatPanel s={s} v={v} />}
    </div>
  );
}

/** 手動で対応：調整案・候補の打診・直接割り当て・求人の手動掲載・スキルの状況・1日の比較をここにまとめる */
function ManualPanel({ s, v, cands, plans, pv, setPv, pp, setPp, openStaff }: { s: State; v: State['vacancies'][number]; cands: ReturnType<typeof rankCandidates>; plans: ReturnType<typeof proposeAdjustments>; pv: string | null; setPv: (id: string | null) => void; pp: string | null; setPp: (id: string | null) => void; openStaff: (id: string) => void }) {
  const [reward, setReward] = useState('時給 1,800円＋夜勤手当（入力例）');
  const [ask, setAsk] = useState<string | null>(null);
  const reasons = useMemo(() => skillReasons(s.assignments, v), [s.assignments, v.id]);
  const plan = plans.find((p) => p.id === pp) ?? null;
  const ok = cands.filter((c) => !c.blocked && !c.unfit); const unfit = cands.filter((c) => !c.blocked && c.unfit); const ng = cands.filter((c) => c.blocked);
  useEffect(() => { if (v.state === 'posted') demoApplication(v.id); }, [v.state, v.id]);
  return (
    <div class="stack" style="gap:12px">
      <ManualBoard s={s} v={v} cands={cands} />
      <details class="card detailcard"><summary class="h3" style="cursor:pointer">ほかの方法・くわしい情報 <span class="small">（調整案・打診・求人・スキル）</span></summary>
      <div class="stack" style="gap:12px;margin-top:12px">
      <DayImpact s={s} v={v} ranked={cands} pv={pv} setPv={setPv} plan={plan} planName={plan ? PLAN_LABEL[plans.indexOf(plan)] : undefined} closePlan={() => setPp(null)} />
      <AdjustSection all={s.assignments} v={v} plans={plans} ranked={cands} pp={pp} setPp={setPp} openStaff={openStaff} />
      <SkillSituation s={s} v={v} ranked={cands} openStaff={openStaff} />
      {v.needSkills.length > 0 && <div class="row wrap"><span class="small">必要スキル：</span>{v.needSkills.map((k) => <span key={k} class="chip bad">{SKILLS[k].label}</span>)}</div>}

      {v.offers.length > 0 && <section class="card"><h3 class="h3">打診の状況</h3><div class="stack" style="gap:8px;margin-top:8px">
        {v.offers.map((o) => <div key={o.staffId} class="row spread wrap"><span><button class="link" onClick={() => openStaff(o.staffId)}>{staffById(o.staffId).name}</button> <span class="small">{o.at}</span></span>
          <span class="row wrap">{o.status === 'pending' ? <><span class="chip warn">未回答</span><button class="btn sm pri" onClick={() => respondOffer(v.id, o.staffId, true)}>返信：入れる</button><button class="btn sm" onClick={() => respondOffer(v.id, o.staffId, false)}>見送る</button></> : <span class={`chip ${o.status === 'accepted' ? 'ok' : ''}`}>{o.status === 'accepted' ? '承諾' : o.status === 'expired' ? '返信なし' : '今回は見送り'}</span>}</span></div>)}
        <p class="small">返信ボタンはデモ用のシミュレートです。辞退は承諾として扱いません。</p></div></section>}

      <details class="card" id="cand-list" open><summary class="h3" style="cursor:pointer">候補（手動で打診する）</summary>
        <p class="small" style="margin:4px 0 4px">{PRIORITY_NOTE}</p><p class="small" style="margin:0 0 12px">提案は本人の承諾ではありません。</p>
        <div class="stack" style="gap:8px">{ok.slice(0, 6).map((c, i) => { const sent = v.offers.find((o) => o.staffId === c.staff.id);
          return <div key={c.staff.id} class="cand"><div style="flex:1;min-width:0"><div class="row"><span class="rank">{i + 1}</span><button class="link" onClick={() => openStaff(c.staff.id)}>{c.staff.name}</button><span class="small">{c.staff.role}</span></div>
            <ReasonChips c={c} /><MiniChecks c={c} /></div>
            <div class="row wrap">{sent ? <span class="chip warn">{sent.status === 'pending' ? '打診済み' : sent.status === 'declined' ? '見送り' : sent.status === 'expired' ? '返信なし' : '承諾'}</span> : <button class="btn sm pri" onClick={() => offerTo(v.id, c.staff.id)}>打診する</button>}
              <button class="btn sm" onClick={() => setPv(c.staff.id)}>入った後を見る</button><button class="btn sm" onClick={() => setAsk(c.staff.id)}>直接割り当て</button></div></div>; })}
          {!ok.length && <div class="empty">条件に合う候補がいません。求人掲載へ進んでください。</div>}</div>
        {unfit.length > 0 && <details style="margin-top:12px" open><summary class="muted">条件に合わないため、自動では打診しない職員（{unfit.length}名）</summary><div class="stack" style="gap:8px;margin-top:8px">{unfit.map((c) => <div key={c.staff.id} class="cand"><div style="flex:1;min-width:0"><button class="link" onClick={() => openStaff(c.staff.id)}>{c.staff.name}</button><div class="stack" style="gap:2px;margin-top:4px">{(c.unfit ?? []).map((t) => <span key={t} class="small" style="color:var(--bad)">{t}</span>)}</div><MiniChecks c={c} /></div>
          <div class="row wrap"><button class="btn sm" onClick={() => setPv(c.staff.id)}>入った後を見る</button><button class="btn sm" onClick={() => offerTo(v.id, c.staff.id)}>それでも打診する</button></div></div>)}</div></details>}
        {ng.length > 0 && <details style="margin-top:12px"><summary class="muted">打診できない職員（{ng.length}名）</summary><div class="stack" style="gap:4px;margin-top:8px">{ng.map((c) => <div key={c.staff.id} class="row spread small" style="color:var(--tx)"><span>{c.staff.name}</span><span class="chip">{c.blocked}</span></div>)}</div></details>}
      </details>

      <section class="card"><h3 class="h3">求人掲載（手動）</h3><p class="small">求人の掲載は画面上の再現です。外部の求人サービスには接続せず、実際の投稿・決済はしません。</p>
        {(v.state === 'open' || v.state === 'offering') && <div class="stack" style="margin-top:8px">
          <div class="field"><label>条件（対価）</label><input class="input" value={reward} onInput={(e) => setReward((e.target as HTMLInputElement).value)} /></div>
          <button class="btn tonal" onClick={() => postJob(v.id, reward)}>この内容で掲載する</button></div>}
        {v.state === 'posted' && <div class="stack" style="margin-top:8px"><span class="chip warn">掲載中：{v.jobPost?.reward}</span><span class="small">応募を待っています…（数秒で届きます）</span></div>}
        {v.state === 'applied' && <div style="margin-top:8px"><Applicants v={v} reasons={reasons} onHire={(id) => confirmApplicant(v.id, id)} /></div>}
      </section>
      </div></details>
      {ask && <Modal title="直接割り当てますか？" onClose={() => setAsk(null)} footer={<><button class="btn" onClick={() => setAsk(null)}>やめる</button><button class="btn pri" onClick={() => { assignStaff(v.id, ask, 'leader'); setAsk(null); }}>割り当てて確定</button></>}>
        <p>{staffById(ask).name}さんを {fmtMD(v.date)} {v.shift}（{unitName(v.unitId)}）に割り当てます。本人の承諾は取れていません。通知は本人に届きます。</p></Modal>}
    </div>
  );
}
