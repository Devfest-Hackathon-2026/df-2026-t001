import { useState } from 'preact/hooks';
import { fmtMD } from '../core/dates';
import { staffById } from '../core/facility';
import type { AdjustPlan, Candidate } from '../core/roster';
import { applyAdjustment } from '../core/store';
import type { Assignment, Vacancy } from '../core/types';
import { PlanBeforeAfter } from './Impact';
import { Icon, Modal } from '../shared/ui';

export const PLAN_LABEL = ['案A', '案B', '案C', '案D'];

/** まず、時間をずらして対応できるか。承認するまで何も反映しない */
export function AdjustSection({ all, v, plans, ranked, pp, setPp, openStaff }: { all: Assignment[]; v: Vacancy; plans: AdjustPlan[]; ranked: Candidate[]; pp: string | null; setPp: (id: string | null) => void; openStaff: (id: string) => void }) {
  const [conf, setConf] = useState<AdjustPlan | null>(null);
  const fit = ranked.filter((c) => !c.blocked && !c.unfit); const avail = fit.filter((c) => c.available).length;
  const look = (id: string) => { setPp(id); document.getElementById('dayimpact')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const shown = plans.slice(0, 4);
  return (
    <section class="card">
      <h3 class="h3"><Icon n="swap_horiz" sm /> まず、時間をずらして対応できるか</h3>
      <p class="small" style="margin:2px 0 10px">勤務中の職員の休憩や時間を調整して、手薄な時間をつなげるかを確認しました。承認するまで、シフトは変わりません。</p>
      <div class="plans">
        {shown.map((p, i) => (
          <div key={p.id} class={`plan${pp === p.id ? ' sel' : ''}`}>
            <div class="row spread wrap" style="gap:8px">
              <div class="row" style="gap:8px"><span class="lab">{PLAN_LABEL[i].slice(1)}</span><b style="font-weight:500">{PLAN_LABEL[i]}　{p.title}</b></div>
              <span class={`chip ${p.resolves ? 'ok' : p.kind === 'swap' ? '' : 'warn'}`}>{p.resolves ? '手薄な時間が解消します' : p.kind === 'swap' ? '人数は変わりません' : `${p.remaining.length}か所まだ手薄`}</span>
            </div>
            <p class="muted" style="margin-top:6px">{p.summary}</p>
            <ul>{p.changes.map((c) => <li key={c.assignmentId}>{c.text}</li>)}</ul>
            <details class="ba" open><summary class="small" style="cursor:pointer;margin-top:8px">いま／この案の後のスケジュール（該当の行だけ）</summary><div style="margin-top:8px"><PlanBeforeAfter all={all} v={v} plan={p} name={PLAN_LABEL[i]} /></div></details>
            {p.caution && <p class="small" style="margin-top:6px"><Icon n="info" sm /> {p.caution}</p>}
            <div class="row wrap" style="gap:6px;margin-top:8px"><span class="small">影響する職員：</span>{p.affected.map((id) => <button key={id} class="chip" onClick={() => openStaff(id)}>{staffById(id).name}</button>)}</div>
            <div class="row wrap" style="margin-top:10px;gap:8px"><button class="btn sm" onClick={() => look(p.id)}>ユニット全体で見る</button><button class="btn sm pri" onClick={() => setConf(p)}>この案を承認して反映</button></div>
          </div>
        ))}
        {!shown.length && <p class="muted">時間のずらしだけで対応できる案はありません。代わりの出勤者を探します。</p>}
        <div class="plan">
          <div class="row spread wrap" style="gap:8px"><div class="row" style="gap:8px"><span class="lab">{PLAN_LABEL[shown.length]?.slice(1) ?? '・'}</span><b style="font-weight:500">{PLAN_LABEL[shown.length] ? PLAN_LABEL[shown.length] + '　' : ''}代わりの出勤者に打診して埋める</b></div>
            <span class="chip pri">条件に合う候補 {fit.length}名</span></div>
          <p class="muted" style="margin-top:6px">人数もスキルも元の体制に戻せます。シフト作成君が優先順に1人ずつ連絡します。</p>
          <div class="row wrap" style="gap:6px;margin-top:8px"><span class="chip">「入れる日」登録済み {avail}名</span><span class="chip">誰も入れない場合は求人へ</span></div>
          <div class="row wrap" style="margin-top:10px"><button class="btn sm" onClick={() => document.getElementById('cand-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>この方法を見る</button></div>
        </div>
      </div>
      {conf && <Modal title="この調整案を反映しますか？" onClose={() => setConf(null)} footer={<><button class="btn" onClick={() => setConf(null)}>やめる</button><button class="btn pri" onClick={() => { applyAdjustment(v.id, conf.id); setConf(null); setPp(null); }}>承認して反映</button></>}>
        <p><b style="font-weight:500">{conf.title}</b>（{fmtMD(v.date)}）を反映します。</p>
        <ul style="margin:8px 0 0 18px">{conf.changes.map((c) => <li key={c.assignmentId}>{c.text}</li>)}</ul>
        <p class="small" style="margin-top:12px">次の職員に通知します：{conf.affected.map((id) => staffById(id).name).join('、')}。{conf.resolves ? '反映すると、この欠員は対応済みになります。' : 'この案だけでは手薄な時間が残ります。'}</p>
      </Modal>}
    </section>
  );
}

/** 調整で対応済みの欠員 */
export function AdjustDone({ v, changes }: { v: Vacancy; changes: string[] }) {
  return (
    <section class="card okcard"><h3 class="h3"><Icon n="check_circle" fill /> 時間の調整で対応しました</h3>
      <p class="muted" style="margin-top:4px">{v.id} は、勤務中の職員の時間を調整して対応しました。日次・月次に反映済みで、影響した職員には通知しています。</p>
      {changes.length > 0 && <ul style="margin:8px 0 0 18px;font-size:14px">{changes.map((t, i) => <li key={i}>{t}</li>)}</ul>}</section>
  );
}
