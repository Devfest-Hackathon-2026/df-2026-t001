import { useMemo, useState } from 'preact/hooks';
import { SHIFT_ORDER, SHIFTS, staffById, unitName, UNITS } from '../core/facility';
import { addDays, fmtMD } from '../core/dates';
import { holidayOf } from '../core/events';
import { EVENT_STYLE, effectText } from './Events';
import { skillReasons } from '../core/roster';
import type { State } from '../core/store';
import { Icon } from '../shared/ui';
import type { Go } from './util';
import { AskCard, PostSheet, ReqActions } from './Auto';
import { AdjustApprovalCard } from './Delegate';
import { stampTime } from '../core/dates';
import { VAC_STATE } from './util';

function Todo({ icon, tone, title, sub, onClick }: { icon: string; tone: 'bad' | 'warn' | 'pri'; title: string; sub?: string; onClick: () => void }) {
  return <button class="todo" onClick={onClick}><span class={`todo-i ${tone}`}><Icon n={icon} /></span><span class="todo-t"><b>{title}</b>{sub && <span class="small">{sub}</span>}</span><Icon n="chevron_right" /></button>;
}

export function Dashboard({ s, go, openStaff }: { s: State; go: Go; openStaff: (id: string) => void }) {
  const today = s.today;
  const [post, setPost] = useState<string | null>(null);
  const todays = s.assignments.filter((a) => a.date === today);
  const onDuty = todays.filter((a) => a.status !== 'absent');
  const allOpen = s.vacancies.filter((v) => v.state !== 'filled').sort((a, b) => a.date.localeCompare(b.date));
  const asks = allOpen.filter((v) => v.auto?.mode === 'ask');
  const adjusts = allOpen.filter((v) => v.auto?.mode === 'waiting_adjust');
  const posts = allOpen.filter((v) => v.auto?.mode === 'waiting_post');
  const running = allOpen.filter((v) => v.auto?.mode === 'running' || v.auto?.mode === 'paused');
  const open = allOpen.filter((v) => !asks.includes(v) && !adjusts.includes(v) && !posts.includes(v) && !running.includes(v));
  const pending = s.requests.filter((r) => r.status === 'pending');
  const missing = useMemo(() => onDuty.filter((a) => !s.health.some((h) => h.staffId === a.staffId && h.date === today)), [s.health, s.assignments]);
  const flagged = s.health.filter((h) => h.date === today && (h.temp >= 37.5 || h.symptoms.length || h.household !== '症状なし' || h.consult));
  const unsub = Object.values(s.collection.submitted).filter((v) => !v).length;
  const night = todays.filter((a) => a.shift === '夜勤');
  const upcoming = s.events.filter((e) => e.date >= today && e.date <= addDays(today, 7)).sort((a, b) => a.date.localeCompare(b.date));
  const auto = s.requests.filter((r) => r.status === 'auto').slice(0, 4);
  const count = asks.length + adjusts.length + posts.length + running.length + open.length + pending.length + (missing.length ? 1 : 0) + (flagged.length ? 1 : 0) + (unsub ? 1 : 0);
  return (
    <div class="page scroll">
      <h1 class="ptitle">今日 <span class="muted">{fmtMD(today)}</span>{holidayOf(today) && <span class="chip bad" style="margin-left:8px">{holidayOf(today)}</span>}</h1>
      <div class="sumrow" aria-label="今日のまとめ">
        <span class="sumchip"><b>{onDuty.length}</b><span class="small">名 勤務</span></span>
        <span class={`sumchip${allOpen.length ? ' bad' : ''}`}><b>{allOpen.length}</b><span class="small">件 欠員</span></span>
        <span class={`sumchip${pending.length ? ' warn' : ''}`}><b>{pending.length}</b><span class="small">件 承認待ち</span></span>
        <span class={`sumchip${missing.length ? ' warn' : ''}`}><b>{missing.length}</b><span class="small">名 体調未入力</span></span>
      </div>
      <section class="card">
        <h3 class="h3">要対応 <span class={`chip ${count ? 'bad' : 'ok'}`}>{count}件</span></h3>
        {asks.map((v) => <AskCard key={v.id} s={s} v={v} />)}
        {adjusts.map((v) => <div key={v.id} style="margin-top:8px"><AdjustApprovalCard s={s} v={v} /></div>)}
        {posts.map((v) => <div key={v.id} class="card askcard" style="margin-top:8px"><div class="row" style="gap:8px"><Icon n="campaign" /><b style="font-weight:500">求人掲載の承認</b></div><p class="muted" style="margin-top:4px">{fmtMD(v.date)} {v.shift}／{unitName(v.unitId)}：打診では埋まりませんでした。求人文を確認してください。</p><div class="row wrap" style="margin-top:12px"><button class="btn pri" onClick={() => setPost(v.id)}>求人文を確認して承認</button><button class="btn sm" onClick={() => go('vac', { vacId: v.id })}>欠員を開く</button></div></div>)}
        {pending.map((r) => <div key={r.id} class="card" style="margin-top:8px"><div class="row" style="gap:8px"><Icon n="inbox" /><b style="font-weight:500">{staffById(r.staffId).name}さん：{fmtMD(r.date)} {r.kind}</b></div>{r.impact && <p class="small" style="margin-top:4px;color:var(--tx)">{r.impact}</p>}<ReqActions r={r} s={s} /></div>)}
        <div class="todos">
          {running.map((v) => { const p = v.offers.find((o) => o.status === 'pending'); return <Todo key={v.id} icon="smart_toy" tone="pri" title={`シフト作成君が対応中：${fmtMD(v.date)} ${v.shift}`} sub={p ? `${staffById(p.staffId).name}さんに打診中${v.auto?.waitUntil ? `（返信期限 ${stampTime(v.auto.waitUntil)}）` : ''}` : v.auto?.mode === 'paused' ? '一時停止中' : '次の候補を選んでいます'} onClick={() => go('vac', { vacId: v.id })} />; })}
          {open.slice(0, 3).map((v) => <Todo key={v.id} icon="person_search" tone="bad" title={`欠員：${fmtMD(v.date)} ${v.shift}`} sub={`${unitName(v.unitId)}／${VAC_STATE[v.state].label}`} onClick={() => go('vac', { vacId: v.id })} />)}
          {open.length > 3 && <Todo icon="person_search" tone="bad" title={`ほか${open.length - 3}件の欠員`} onClick={() => go('vac')} />}
          {flagged.length > 0 && <Todo icon="monitor_heart" tone="bad" title={`体調に確認事項：${flagged.length}名`} sub="本人と就業可否を確認" onClick={() => go('health')} />}
          {missing.length > 0 && <Todo icon="monitor_heart" tone="warn" title={`体調チェック未入力：${missing.length}名`} sub="未入力は健康とみなしません" onClick={() => go('health')} />}
          {unsub > 0 && <Todo icon="event_available" tone="pri" title={`希望休の未提出：${unsub}名`} sub={`締切 ${fmtMD(s.collection.deadline)}`} onClick={() => go('collect')} />}
          {count === 0 && <p class="muted">対応が必要なことはありません。</p>}
        </div>
      </section>
      {post && s.vacancies.find((v) => v.id === post)?.jobPost && <PostSheet v={s.vacancies.find((v) => v.id === post)!} reasons={skillReasons(s.assignments, s.vacancies.find((v) => v.id === post)!)} onClose={() => setPost(null)} />}
      <div class="grid2">
        <section class="card">
          <h3 class="h3">今日の勤務人数</h3>
          <div class="tiles">{SHIFT_ORDER.map((sh) => { const have = todays.filter((a) => a.shift === sh && a.status !== 'absent').length; return <button key={sh} class={`tile${have < 4 ? ' bad' : ''}`} onClick={() => go('day', { date: today })}><span class="small">{sh}</span><b>{have}<span class="small"> /4</span></b><span class="small">{SHIFTS[sh].label.slice(0, 5)}〜</span></button>; })}</div>
        </section>
        <section class="card">
          <h3 class="h3">今夜の夜勤</h3>
          <div class="stack" style="gap:2px;margin-top:8px">{UNITS.map((u) => { const a = night.find((x) => x.unitId === u.id); return <div key={u.id} class="row spread nrow"><span class="muted">{u.floor}階 {u.name}</span><span class="row" style="gap:6px">{a ? <><button class="link" onClick={() => openStaff(a.staffId)}>{staffById(a.staffId).name}</button>{staffById(a.staffId).skills.includes('medical') && <span class="mini bad">医療</span>}</> : <span class="chip bad">欠員</span>}</span></div>; })}</div>
        </section>
      </div>
      {upcoming.length > 0 && <section class="card" style="margin-top:12px"><h3 class="h3">これからの行事（7日以内）</h3>
        <div class="stack" style="gap:6px;margin-top:8px">{upcoming.map((e) => <button key={e.id} class="evrow" onClick={() => go('day', { date: e.date })}><span class="evc" style={`background:${EVENT_STYLE[e.kind].bg};color:${EVENT_STYLE[e.kind].fg}`}>{fmtMD(e.date)}</span><span class="evt"><b>{e.title}</b>{effectText(e) && <span class="small" style="color:var(--pri-tx)">{effectText(e)}</span>}</span><Icon n="chevron_right" sm /></button>)}</div></section>}
      {auto.length > 0 && <details class="card" style="margin-top:12px"><summary>シフト作成君が自動反映した変更（{auto.length}件）</summary>
        <div class="stack" style="gap:8px;margin-top:8px">{auto.map((r) => <div key={r.id} class="small" style="color:var(--tx)">{staffById(r.staffId).name}：{fmtMD(r.date)} {r.kind}{r.detail ? `（${r.detail}）` : ''}</div>)}</div></details>}
      <p class="small" style="margin-top:16px"><Icon n="info" sm /> すべて架空のデータです。</p>
    </div>
  );
}
