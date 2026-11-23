import { useMemo, useState } from 'preact/hooks';
import { DEFAULT_SHIFT_TYPES, SHIFT_ORDER, SHIFTS, shiftStyleOf, staffById, unitName, UNITS } from '../core/facility';
import { buildDay } from '../core/roster';
import { fmtHM } from '../core/dates';
import { addDays, fmtMD } from '../core/dates';
import { holidayOf } from '../core/events';
import { EVENT_STYLE, effectText } from './Events';
import { skillReasons } from '../core/roster';
import type { State } from '../core/store';
import { remindHealth } from '../core/store';
import { Icon, useToast } from '../shared/ui';
import type { Go } from './util';
import { AskCard, PostSheet, ReqActions } from './Auto';
import { AdjustApprovalCard } from './Delegate';
import { stampMin, stampTime } from '../core/dates';
import { VAC_STATE } from './util';
import { Outlook } from './ai/Outlook';
import { Weather } from './Weather';

function Todo({ icon, tone, title, sub, onClick }: { icon: string; tone: 'bad' | 'warn' | 'pri'; title: string; sub?: string; onClick: () => void }) {
  return <button class="todo" onClick={onClick}><span class={`todo-i ${tone}`}><Icon n={icon} /></span><span class="todo-t"><b>{title}</b>{sub && <span class="small">{sub}</span>}</span><Icon n="chevron_right" /></button>;
}


/** 承認・見送りした申請：カードを残して、その後どうなったかを出す */
function ReqResult({ s, r, go }: { s: State; r: State['requests'][number]; go: Go }) {
  if (r.status === 'rejected') return <p class="req-st done"><Icon n="block" sm /> 見送りました。本人に通知しました。</p>;
  const v = s.vacancies.find((x) => x.date === r.date && s.assignments.find((a) => a.id === x.fromAssignmentId)?.staffId === r.staffId);
  const p = v?.offers.find((o) => o.status === 'pending');
  const text = !v ? '承認しました。シフトに反映しました。'
    : v.state === 'filled' ? `承認しました → ${v.filledBy ? `${staffById(v.filledBy).name}さんが入ります` : '埋まりました'}`
      : v.auto?.mode === 'running' ? `承認しました → シフト作成君が対応中${p ? `（${staffById(p.staffId).name}さんに連絡中）` : ''}`
        : v.auto?.mode === 'waiting_adjust' ? '承認しました → 時間をずらす案の承認待ち'
          : v.auto?.mode === 'waiting_post' ? '承認しました → 求人の承認待ち'
            : '承認しました → 欠員として残っています';
  return <div class="req-st done row spread wrap"><span><Icon n="check_circle" sm /> {text}</span>{v && <button class="btn sm" onClick={() => go('vac', { vacId: v.id })}>欠員を開く</button>}</div>;
}

/** 今日のシフト（時間帯）：7:00〜翌9:30 の横軸に、ユニットごとの職員の勤務を帯で並べる */
function TodayTimeline({ s, go, openStaff }: { s: State; go: Go; openStaff: (id: string) => void }) {
  const A = 420, B = 1890; const pct = (m: number) => `${((Math.min(Math.max(m, A), B) - A) / (B - A)) * 100}%`;
  const rows = useMemo(() => buildDay(s.assignments, s.today), [s.assignments, s.today]);
  const now = stampMin(s.now);
  const hours: number[] = []; for (let t = 480; t <= 1860; t += 120) hours.push(t);
  return (
    <section class="card tl-card">
      <div class="row spread wrap" style="gap:8px"><h3 class="h3">今日のシフト</h3><button class="btn sm" onClick={() => go('day', { date: s.today })}>1日の画面で見る</button></div>
      <div class="tlx">
        <div class="tlx-head"><span class="tlx-nm" />{<span class="tlx-axis">{hours.map((t) => <span key={t} style={`left:${pct(t)}`}>{t >= 1440 ? '翌' : ''}{fmtHM(t % 1440)}</span>)}</span>}</div>
        {UNITS.map((u) => { const rs = rows.filter((r) => r.assignment.unitId === u.id).sort((a, b) => (a.tail ? -1 : 0) - (b.tail ? -1 : 0) || SHIFT_ORDER.indexOf(a.assignment.shift) - SHIFT_ORDER.indexOf(b.assignment.shift)); return (
          <div key={u.id} class="tlx-unit">
            <div class="tlx-uh">{u.floor}階 {u.name}</div>
            {rs.map((r) => { const a = r.assignment; const st = shiftStyleOf(a.shift, DEFAULT_SHIFT_TYPES); const t0 = r.tail ? SHIFTS[a.shift].start - 1440 : SHIFTS[a.shift].start; const t1 = r.tail ? SHIFTS[a.shift].end - 1440 : SHIFTS[a.shift].end; if (t1 <= A) return null; const absent = a.status === 'absent';
              return <div key={a.id + (r.tail ? 't' : '')} class="tlx-row">
                <button class="tlx-nm link" onClick={() => openStaff(r.staff.id)}>{r.staff.name}</button>
                <span class="tlx-track">
                  <span class={`tlx-bar${absent ? ' absent' : ''}`} style={`left:${pct(t0)};width:calc(${pct(t1)} - ${pct(t0)});background:${absent ? 'transparent' : st.bg};color:${st.fg}`} title={`${a.shift} ${fmtHM(t0 % 1440)}〜${fmtHM(t1 % 1440)}${absent ? '（休み）' : ''}`}>{r.tail ? '夜勤明け' : absent ? `${a.shift}（休み）` : a.shift}</span>
                  {!absent && r.blocks.filter((b) => b.kind === 'break' || b.kind === 'nap').map((b, i) => { const o = r.tail ? -1440 : 0; return <span key={i} class="tlx-brk" style={`left:${pct(b.start + o)};width:calc(${pct(b.end + o)} - ${pct(b.start + o)})`} title={`${b.kind === 'nap' ? '仮眠' : '休憩'} ${fmtHM((b.start + o) % 1440)}〜`} />; })}
                </span>
              </div>; })}
          </div>); })}
        {now >= A && now <= B && <span class="tlx-now" style={`left:calc(var(--nmw) + (100% - var(--nmw)) * ${(now - A) / (B - A)})`}><span>いま</span></span>}
      </div>
    </section>
  );
}

export function Dashboard({ s, go, openStaff }: { s: State; go: Go; openStaff: (id: string) => void }) {
  const today = s.today;
  const [post, setPost] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const [decided, setDecided] = useState<string[]>([]); // この画面で承認・見送りした申請（カードを消さずに結果を出す）
  const todays = s.assignments.filter((a) => a.date === today);
  const onDuty = todays.filter((a) => a.status !== 'absent');
  const allOpen = s.vacancies.filter((v) => v.state !== 'filled').sort((a, b) => a.date.localeCompare(b.date));
  const asks = allOpen.filter((v) => v.auto?.mode === 'ask');
  const adjusts = allOpen.filter((v) => v.auto?.mode === 'waiting_adjust');
  const posts = allOpen.filter((v) => v.auto?.mode === 'waiting_post');
  const running = allOpen.filter((v) => v.auto?.mode === 'running' || v.auto?.mode === 'paused');
  const open = allOpen.filter((v) => !asks.includes(v) && !adjusts.includes(v) && !posts.includes(v) && !running.includes(v));
  const pending = s.requests.filter((r) => r.status === 'pending');
  const shownReqs = s.requests.filter((r) => r.status === 'pending' || decided.includes(r.id));
  const todayEvents = s.events.filter((e) => e.date === today);
  const missing = useMemo(() => onDuty.filter((a) => !s.health.some((h) => h.staffId === a.staffId && h.date === today)), [s.health, s.assignments]);
  const flagged = s.health.filter((h) => h.date === today && (h.temp >= 37.5 || h.symptoms.length || h.household !== '症状なし' || h.consult));
  const unsub = Object.values(s.collection.submitted).filter((v) => !v).length;
  const night = todays.filter((a) => a.shift === '夜勤');
  // 勤務人数を押すと、その勤務の人を出す
  const [selSh, setSelSh] = useState<string | null>(null);
  const isFlag = (h: State['health'][number]) => h.temp >= 37.5 || h.symptoms.length > 0 || h.household !== '症状なし' || h.consult;
  const healthOf = (id: string) => { const h = s.health.find((x) => x.staffId === id && x.date === today); return !h ? { cls: 'warn', label: '体調 未入力' } : isFlag(h) ? { cls: 'bad', label: '体調 要確認' } : { cls: 'ok', label: '体調 OK' }; };
  const healthRows = onDuty.map((a) => { const h = s.health.find((x) => x.staffId === a.staffId && x.date === today); return { a, h, lv: !h ? 'warn' : isFlag(h) ? 'bad' : 'ok' }; }).sort((x, y) => ['bad', 'warn', 'ok'].indexOf(x.lv) - ['bad', 'warn', 'ok'].indexOf(y.lv));
  const upcoming = s.events.filter((e) => e.date >= today && e.date <= addDays(today, 7)).sort((a, b) => a.date.localeCompare(b.date));
  const auto = s.requests.filter((r) => r.status === 'auto').slice(0, 4);
  // 要対応の件数＝欠員（埋まっていない）＋承認待ちの申請。左のバッジ・要対応のタブと同じ数え方
  const count = allOpen.length + pending.length;
  return (
    <div class="page scroll">
      <div class="dash-head">
        <h1 class="ptitle">今日 <span class="muted">{fmtMD(today)}</span>{holidayOf(today) && <span class="chip bad" style="margin-left:8px">{holidayOf(today)}</span>}</h1>
        <span class="dash-ev">{todayEvents.length ? todayEvents.map((e) => <span key={e.id} class="evc" style={`background:${EVENT_STYLE[e.kind].bg};color:${EVENT_STYLE[e.kind].fg}`}>{e.title}{effectText(e) ? `（${effectText(e)}）` : ''}</span>) : <span class="small">今日の行事はありません</span>}</span>
        <span class="dash-wx"><Weather /></span>
      </div>
      <div class="dash-2col">
      <section class="card">
        <h3 class="h3">要対応 <span class={`chip ${count ? 'bad' : 'ok'}`}>{count}件</span></h3>
        {asks.map((v) => <AskCard key={v.id} s={s} v={v} />)}
        {adjusts.map((v) => <div key={v.id} style="margin-top:8px"><AdjustApprovalCard s={s} v={v} /></div>)}
        {posts.map((v) => <div key={v.id} class="card askcard" style="margin-top:8px"><div class="row" style="gap:8px"><Icon n="campaign" /><b style="font-weight:500">求人掲載の承認</b></div><p class="muted" style="margin-top:4px">{fmtMD(v.date)} {v.shift}／{unitName(v.unitId)}：打診では埋まりませんでした。求人文を確認してください。</p><div class="row wrap" style="margin-top:12px"><button class="btn pri" onClick={() => setPost(v.id)}>求人文を確認して承認</button><button class="btn sm" onClick={() => go('vac', { vacId: v.id })}>欠員を開く</button></div></div>)}
        {shownReqs.map((r) => <div key={r.id} class={`card${r.status === 'pending' ? '' : ' req-done'}`} style="margin-top:8px"><div class="row" style="gap:8px"><Icon n="inbox" /><b style="font-weight:500">{staffById(r.staffId).name}さん：{fmtMD(r.date)} {r.kind}</b></div>{r.impact && <p class="small" style="margin-top:4px;color:var(--tx)">{r.impact}</p>}{r.status === 'pending' ? <ReqActions r={r} s={s} onDone={(id) => setDecided((d) => [...d, id])} /> : <ReqResult s={s} r={r} go={go} />}</div>)}
        <div class="todos">
          {running.map((v) => { const p = v.offers.find((o) => o.status === 'pending'); return <Todo key={v.id} icon="smart_toy" tone="pri" title={`シフト作成君が対応中：${fmtMD(v.date)} ${v.shift}`} sub={p ? `${staffById(p.staffId).name}さんに打診中${v.auto?.waitUntil ? `（返信期限 ${stampTime(v.auto.waitUntil)}）` : ''}` : v.auto?.mode === 'paused' ? '一時停止中' : '次の候補を選んでいます'} onClick={() => go('vac', { vacId: v.id })} />; })}
          {open.slice(0, 3).map((v) => <Todo key={v.id} icon="person_search" tone="bad" title={`欠員：${fmtMD(v.date)} ${v.shift}`} sub={`${unitName(v.unitId)}／${VAC_STATE[v.state].label}`} onClick={() => go('vac', { vacId: v.id })} />)}
          {open.length > 3 && <Todo icon="person_search" tone="bad" title={`ほか${open.length - 3}件の欠員`} onClick={() => go('vac')} />}
          {count === 0 && <p class="muted">対応が必要なことはありません。</p>}
        </div>
        {unsub > 0 && <button class="link small" style="margin-top:8px" onClick={() => go('collect')}>来月の希望休：{unsub}名が未提出（締切 {fmtMD(s.collection.deadline)}）</button>}
      </section>
      <section class="card today-card">
        <h3 class="h3">今日の出勤</h3>
        <div class="tc-h">勤務人数（押すと出勤する人）</div>
        <div class="tc-shifts" role="tablist">{SHIFT_ORDER.map((sh) => { const have = todays.filter((a) => a.shift === sh && a.status !== 'absent').length; return <button key={sh} role="tab" aria-selected={selSh === sh} class={`tc-sh${have < 4 ? ' short' : ''}${selSh === sh ? ' on' : ''}`} onClick={() => setSelSh(selSh === sh ? null : sh)}><span class="small">{sh}</span><b>{have}</b><span class="tc-time">{SHIFTS[sh].label}</span></button>; })}</div>
        {selSh && <div class="tc-people">{todays.filter((a) => a.shift === selSh).sort((a, b) => a.unitId.localeCompare(b.unitId)).map((a) => { const st = staffById(a.staffId); const hs = healthOf(a.staffId); return (
          <div key={a.id} class={`tc-p${a.status === 'absent' ? ' absent' : ''}`}>
            <span class="tc-u">{unitName(a.unitId)}</span>
            <button class="link tc-n" onClick={() => openStaff(a.staffId)}>{st.name}</button>
            {st.skills.includes('medical') && <span class="b1 sk-medical" title="医療的ケア">医</span>}
            <span class="small tc-pt">{a.status === 'absent' ? '休み' : SHIFTS[a.shift].label}</span>
            <span class={`hs ${hs.cls}`}>{hs.label}</span>
          </div>); })}</div>}
        <div class="tc-h" style="margin-top:12px">これからの行事（7日以内）</div>
        {upcoming.length ? <div class="tc-evs">{upcoming.slice(0, 4).map((e) => <button key={e.id} class="tc-ev" onClick={() => go('day', { date: e.date })}><span class="evc" style={`background:${EVENT_STYLE[e.kind].bg};color:${EVENT_STYLE[e.kind].fg}`}>{fmtMD(e.date).replace(/（.）/, '')}</span><span>{e.title}</span></button>)}</div> : <p class="small">7日以内の行事はありません</p>}
        <div class="tc-health">
          <div class="row spread wrap" style="gap:8px"><div class="tc-h" style="margin:0">体調（今日の勤務 {onDuty.length}名）</div>{missing.length > 0 && <button class="btn sm" onClick={() => { const n = remindHealth(missing.map((a) => a.staffId)); setToast(`未入力の${n}名に催促しました`); }}>未入力 {missing.length}名をまとめて催促</button>}</div>
          <div class="hl-list">{healthRows.map(({ a, h, lv }) => (
            <button key={a.id} class={`hl-row ${lv}`} onClick={() => openStaff(a.staffId)}>
              <span class="hl-n">{staffById(a.staffId).name}</span>
              <span class="small hl-u">{unitName(a.unitId)}・{a.shift}</span>
              <span class="hl-d">{h ? [`${h.temp.toFixed(1)}℃`, ...h.symptoms, h.household !== '症状なし' ? `家族：${h.household}` : '', h.consult ? '相談したい' : ''].filter(Boolean).join('・') : ''}</span>
              <span class={`hs ${lv}`}>{lv === 'bad' ? '要確認' : lv === 'warn' ? '未入力' : '入力済み'}</span>
            </button>))}</div>
        </div>
      </section>
      </div>
      {post && s.vacancies.find((v) => v.id === post)?.jobPost && <PostSheet v={s.vacancies.find((v) => v.id === post)!} reasons={skillReasons(s.assignments, s.vacancies.find((v) => v.id === post)!)} onClose={() => setPost(null)} />}


      <TodayTimeline s={s} go={go} openStaff={openStaff} />
      <Outlook onMore={() => go('ai', { aiTab: 'insights' })} />
      {auto.length > 0 && <details class="card" style="margin-top:12px"><summary>シフト作成君が自動反映した変更（{auto.length}件）</summary>
        <div class="stack" style="gap:8px;margin-top:8px">{auto.map((r) => <div key={r.id} class="small" style="color:var(--tx)">{staffById(r.staffId).name}：{fmtMD(r.date)} {r.kind}{r.detail ? `（${r.detail}）` : ''}</div>)}</div></details>}
      <p class="small" style="margin-top:16px"><Icon n="info" sm /> すべて架空のデータです。</p>
      {toast}
    </div>
  );
}
