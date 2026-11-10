import type { State } from '../core/store';
import { MY_ID, SHIFTS, TASKS, TASK_GROUPS, unitName } from '../core/facility';
import { buildDay } from '../core/roster';
import { addDays, fmtMD, fmtMin, DOW_JA, parseYmd } from '../core/dates';
import { useState } from 'preact/hooks';
import { Icon } from '../shared/ui';
import { MonthCard, MonthRequest } from './Request';
import { Ctx, ShiftChip, myAssign, simMin } from './common';

export function Home({ s, c }: { s: State; c: Ctx }) {
  const [req, setReq] = useState(false);
  const now = simMin(s);
  const today = s.today;
  const mine = buildDay(s.assignments, today).filter((r) => r.staff.id === MY_ID);
  // 前日からの夜勤（夜勤明け）は、明けの時刻（09:30）までは「今日の勤務」として続きを出す
  const tail = mine.find((r) => r.tail);
  const tailEnd = SHIFTS['夜勤'].end - 1440;
  const onTail = !!tail && now < tailEnd;
  const row = onTail ? tail : mine.find((r) => !r.tail);
  const a = row?.assignment;
  const ake = !!tail && !onTail && !(a && a.status !== 'absent'); // 夜勤明け（勤務は終わった）
  const working = !!a && a.status !== 'absent';
  const next = (() => { for (let i = 1; i <= 42; i++) { const d = addDays(today, i); const x = myAssign(s, d); if (x && x.status !== 'absent') return x; } return undefined; })();
  const unread = s.notices.filter((n) => n.to === MY_ID && !n.read);
  const hc = s.health.find((h) => h.staffId === MY_ID && h.date === today);
  const blocks = row?.blocks ?? [];
  const cur = blocks.findIndex((b) => now >= b.start && now < b.end);
  const nxt = cur >= 0 ? cur + 1 : blocks.findIndex((b) => b.start > now);
  const brk = blocks.find((b) => b.kind === 'break' || b.kind === 'nap');

  return (
    <div class="pg">
      <h1 class="ptitle">ホーム</h1>
      {working && a ? (
        <>
          <section class="card">
            <div class="row spread"><span class="muted">{onTail ? `今日の勤務（${fmtMD(a.date)}からの夜勤明け）` : '今日の勤務'}</span><ShiftChip shift={a.shift} full /></div>
            <div class="big" style="margin-top:4px">{onTail ? `夜勤明け 〜${fmtMin(tailEnd)}` : SHIFTS[a.shift].label}</div>
            <div class="row" style="flex-wrap:wrap;margin-top:8px">
              <span class="chip">担当：{unitName(a.unitId)}</span>
              {brk && <span class="chip">{brk.kind === 'nap' ? '仮眠' : '休憩'} {fmtMin(brk.start)}〜{fmtMin(brk.end)}</span>}
              {a.status === 'late' && <span class="chip warn">遅刻 {a.lateMin}分</span>}
              {a.status === 'early' && <span class="chip warn">早退 {a.earlyAt}</span>}
            </div>
            <div class="row" style="margin-top:12px">
              <button class="btn sm" onClick={() => c.openUnitStaff(a.unitId)}><Icon n="group" sm />ユニットの職員</button>
              <button class="btn sm" onClick={() => c.openUnitResidents(a.unitId)}><Icon n="elderly" sm />入居者</button>
            </div>
          </section>
          <section class="card">
            <div class="row spread"><h2 class="h2">今日の担当業務</h2><span class="small">時間は目安</span></div>
            <ol class="tl">
              {blocks.map((b, i) => {
                const t = TASKS[b.kind]; const g = TASK_GROUPS[t.group]; const isCur = i === cur; const isNext = i === nxt && cur !== i;
                return (
                  <li key={i} class={`tl-i${isCur ? ' cur' : ''}${t.group === 'rest' ? ' rest' : ''}`} style={`--tc:${t.fg};--tb:${t.bg};--bar:${g.bar}`}>
                    <div class="tl-time">{fmtMin(b.start)}<br /><span class="small">{fmtMin(b.end)}</span></div>
                    <div class="tl-body"><b>{b.label}</b><div class="small">{unitName(b.unitId ?? a.unitId)}</div></div>
                    {isCur && <span class="pillnow">いま</span>}{isNext && <span class="pillnext">次</span>}
                  </li>
                );
              })}
            </ol>
          </section>
        </>
      ) : (
        <section class="card">
          <div class="row spread"><span class="muted">今日の勤務</span><span class="chip">{a?.status === 'absent' ? '休み（受付済み）' : ake ? '夜勤明け' : '勤務なし'}</span></div>
          <p class="big" style="margin-top:8px">{a?.status === 'absent' ? 'お休みとして受け付けています' : ake ? '夜勤明けです。ゆっくり休んでください' : '今日はお休みです'}</p>
          {next && <p class="muted" style="margin-top:4px">次の勤務：{fmtMD(next.date)} {next.shift}（{SHIFTS[next.shift].label}）</p>}
          <div class="week">{Array.from({ length: 7 }, (_, i) => { const d = addDays(today, i); const x = myAssign(s, d); return (<div key={d} class="wk"><span class="small">{DOW_JA[parseYmd(d).getDay()]}</span><b>{+d.slice(8)}</b>{x && x.status !== 'absent' ? <ShiftChip shift={x.shift} /> : <span class="small">休</span>}</div>); })}</div>
        </section>
      )}

      <button class="card tap" onClick={() => c.go('health')}>
        <div class="row spread"><div><h2 class="h2">出勤前の体調チェック</h2><p class="muted">{hc ? `入力済み（体温${hc.temp.toFixed(1)}℃）` : '今日はまだ入力していません'}</p></div>
          {hc ? <span class="chip ok">入力済み</span> : <span class="btn pri sm">入力する</span>}</div>
      </button>

      <MonthCard s={s} c={c} quiet onOpen={() => setReq(true)} />
      {req && <MonthRequest s={s} c={c} onClose={() => setReq(false)} />}

      <section class="card">
        <div class="row spread"><h2 class="h2">お知らせ</h2><button class="link" onClick={c.openNotices}>すべて見る</button></div>
        {unread.length ? unread.slice(0, 2).map((n) => <button key={n.id} class="line" onClick={c.openNotices}><span class="dot" /><span><b>{n.title}</b><br /><span class="muted">{n.body}</span></span></button>) : <p class="muted">未読のお知らせはありません。</p>}
      </section>
    </div>
  );
}
