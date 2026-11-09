import { useRef, useState } from 'preact/hooks';
import { SHIFTS, TASKS, staffById, unitName } from '../core/facility';
import { fmtHM } from '../core/dates';
import { buildDay } from '../core/roster';
import type { Candidate } from '../core/roster';
import { assignStaff, confirmManualAdjust, setAssignmentSpan } from '../core/store';
import type { State } from '../core/store';
import type { TaskBlock, Vacancy } from '../core/types';
import { Icon, Modal } from '../shared/ui';
import { Gaps, gapText, inScope, issuesFor } from './Impact';

const STEP = 15; const MAX_EXT = 120;

/** 手動：その日の時間割で、バーの端をドラッグして出勤・退勤を延ばす／人を追加する（Excelのように） */
export function ManualBoard({ s, v, cands }: { s: State; v: Vacancy; cands: Candidate[] }) {
  const def = SHIFTS[v.shift];
  const t0 = def.start - 150; const t1 = def.end + 150;
  const rows = buildDay(s.assignments, v.date).filter(inScope(v)).filter((r) => !r.tail && r.assignment.status !== 'absent' && r.assignment.id !== v.fromAssignmentId);
  const issues = issuesFor(v, s.assignments);
  const abs = s.assignments.find((a) => a.id === v.fromAssignmentId);
  const [add, setAdd] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; side: 'start' | 'end'; base: number } | null>(null);
  const ticks: number[] = []; for (let t = Math.ceil(t0 / 60) * 60; t < t1; t += 120) ticks.push(t);
  const pct = (m: number) => ((m - t0) / (t1 - t0)) * 100;

  const onMove = (e: PointerEvent) => {
    const d = drag.current; const tr = gridRef.current?.querySelector('.mtrack.axis') as HTMLElement | null; if (!d || !tr) return;
    const r = tr.getBoundingClientRect(); const raw = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    const m = Math.round(raw / STEP) * STEP;
    const asg = s.assignments.find((a) => a.id === d.id); if (!asg) return; const rd = SHIFTS[asg.shift]; const cur = asg.adjust;
    if (d.side === 'start') { const v2 = Math.min(rd.start, Math.max(rd.start - MAX_EXT, m)); if (v2 !== (cur?.startAt ?? rd.start)) setAssignmentSpan(d.id, v2, undefined); }
    else { const v2 = Math.max(rd.end, Math.min(rd.end + MAX_EXT, m)); if (v2 !== (cur?.endAt ?? rd.end)) setAssignmentSpan(d.id, undefined, v2); }
  };
  const stop = () => { drag.current = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', stop); };
  const down = (id: string, side: 'start' | 'end') => (e: PointerEvent) => { e.preventDefault(); drag.current = { id, side, base: 0 }; window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', stop); };

  const changes = rows.flatMap((r) => {
    const rd = SHIFTS[r.assignment.shift]; const j = r.assignment.adjust; const out: { assignmentId: string; staffId: string; text: string }[] = [];
    if (j?.startAt != null && j.startAt < rd.start) out.push({ assignmentId: r.assignment.id, staffId: r.staff.id, text: `${r.staff.name}さんの出勤を ${fmtHM(rd.start)} → ${fmtHM(j.startAt)} に前倒し` });
    if (j?.endAt != null && j.endAt > rd.end) out.push({ assignmentId: r.assignment.id, staffId: r.staff.id, text: `${r.staff.name}さんの退勤を ${fmtHM(rd.end)} → ${fmtHM(j.endAt)} に延長` });
    return out;
  });
  const ok = cands.filter((c) => !c.blocked && !c.unfit).slice(0, 8);
  const ext = (r: (typeof rows)[number]) => { const rd = SHIFTS[r.assignment.shift]; const j = r.assignment.adjust; return [Math.min(rd.start, j?.startAt ?? rd.start), Math.max(rd.end, j?.endAt ?? rd.end)] as const; };
  const inWin = (m: number) => m >= t0 && m <= t1;

  return (
    <section class="card mboard">
      <div class="row spread wrap" style="gap:8px"><b style="font-weight:500">この日の時間割</b><span class={`chip ${issues.length ? 'bad' : 'ok'}`}>{issues.length ? `手薄な時間 ${issues.length}か所` : '手薄な時間なし'}</span></div>
      <p class="small" style="margin:4px 0 8px">バーの両端をつかんで動かすと、出勤・退勤を延ばせます（15分単位）。赤い帯が不足する時間です。</p>
      <div class="fgrid" ref={gridRef}>
        <div class="fl" /><div class="mtrack axis">{ticks.map((t) => <span key={t} class="tick" style={`left:${pct(t)}%`}>{fmtHM(t)}</span>)}</div>
        <div class="fl gl">不足する時間</div><Gaps issues={issues} t0={t0} t1={t1} />
        {abs && <><div class="fl ghost"><div class="fn"><span class="chip bad">欠勤</span> <s>{staffById(abs.staffId).name}</s></div></div><div class="mtrack ghost"><span class="mb" style={`left:${pct(def.start)}%;width:${pct(def.end) - pct(def.start)}%;background:#fff;color:var(--bad)`}>{v.shift}</span></div></>}
        {rows.map((r) => {
          const [a, b] = ext(r);
          return <>
            <div key={r.assignment.id + 'l'} class="fl"><div class="fn">{r.staff.name}</div><div class="small fs">{r.assignment.shift}・{unitName(r.assignment.unitId)}</div></div>
            <div key={r.assignment.id} class="mtrack mrow">
              {r.blocks.filter((x: TaskBlock) => x.end > t0 && x.start < t1).map((x: TaskBlock, i: number) => { const tk = TASKS[x.kind]; return <span key={i} class="mb" style={`left:${pct(Math.max(x.start, t0))}%;width:${pct(Math.min(x.end, t1)) - pct(Math.max(x.start, t0))}%;background:${tk.bg};color:${tk.fg}`} title={`${fmtHM(x.start)}〜${fmtHM(x.end)} ${x.label}`} />; })}
              {inWin(a) && <span class="hnd" role="slider" aria-label={`${r.staff.name}さんの出勤時刻`} aria-valuetext={fmtHM(a)} tabIndex={0} style={`left:${pct(a)}%`} onPointerDown={down(r.assignment.id, 'start')}><i /></span>}
              {inWin(b) && <span class="hnd" role="slider" aria-label={`${r.staff.name}さんの退勤時刻`} aria-valuetext={fmtHM(b)} tabIndex={0} style={`left:${pct(b)}%`} onPointerDown={down(r.assignment.id, 'end')}><i /></span>}
            </div></>;
        })}
      </div>
      {issues.length > 0 && <ul class="gaptext">{issues.slice(0, 3).map((i, k) => <li key={k}>{gapText(i)}</li>)}</ul>}
      <div class="row wrap" style="margin-top:12px;gap:8px">
        <button class="btn" onClick={() => setAdd(true)}><Icon n="person_add" sm /> 人を追加</button>
        <button class="btn pri" disabled={!changes.length || issues.length > 0} onClick={() => confirmManualAdjust(v.id, changes)}>この内容で確定{changes.length ? `（${changes.length}件）` : ''}</button>
        {changes.length > 0 && issues.length > 0 && <span class="small">まだ手薄な時間があります。</span>}
      </div>
      {add && <Modal title="人を追加" onClose={() => setAdd(false)}>
        <p class="small" style="margin-bottom:8px">この日に入れる職員です（条件に合う順）。追加すると欠員が埋まります。本人の承諾は取れていません。</p>
        <div class="stack" style="gap:8px">{ok.map((c, i) => <div key={c.staff.id} class="cand"><div style="flex:1;min-width:0"><div class="row"><span class="rank">{i + 1}</span><b style="font-weight:500">{c.staff.name}</b><span class="small">{c.staff.role}</span></div></div>
          <button class="btn sm pri" onClick={() => { assignStaff(v.id, c.staff.id, 'leader'); setAdd(false); }}>追加して確定</button></div>)}
          {!ok.length && <div class="empty">追加できる職員がいません。</div>}</div>
      </Modal>}
    </section>
  );
}
