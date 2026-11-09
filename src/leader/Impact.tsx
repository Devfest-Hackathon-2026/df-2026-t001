import { useMemo, useState } from 'preact/hooks';
import { SHIFTS, SKILLS, TASKS, TASK_GROUPS, floorOf, staffById, unitName } from '../core/facility';
import { addDays, fmtHM, fmtMD } from '../core/dates';
import { applyAdjust, buildBlocks, buildDay, coverage, issueTime, skillSituation } from '../core/roster';
import type { AdjustPlan } from '../core/roster';
import type { Candidate, Holder } from '../core/roster';
import type { Assignment, CoverageIssue, DayRow, TaskBlock, Vacancy } from '../core/types';
import { Icon } from '../shared/ui';
import './vacancy.css';

type Rows = { rows: DayRow[]; ghost?: DayRow };
const night = (v: Vacancy) => v.shift === '夜勤';
export const inScope = (v: Vacancy) => (r: DayRow) => (night(v) ? (r.assignment.shift === '夜勤' || r.tail === true) && floorOf(r.assignment.unitId) === floorOf(v.unitId) : (r.assignment.unitId === v.unitId || r.blocks.some((b) => b.unitId === v.unitId)) && !r.tail);
const scopeIssue = (v: Vacancy) => (i: CoverageIssue) => i.scope === unitName(v.unitId) || (night(v) && i.scope === `${floorOf(v.unitId)}階`);

function build(all: Assignment[], v: Vacancy): Rows {
  const rows = buildDay(all, v.date).filter(inScope(v));
  const abs = all.find((a) => a.id === v.fromAssignmentId);
  const ghost = abs && abs.date === v.date && abs.status === 'absent' ? { staff: staffById(abs.staffId), assignment: abs, blocks: buildBlocks({ ...abs, status: 'assigned' }, staffById(abs.staffId), 0) } : undefined;
  return { rows: ghost ? rows.filter((r) => r.assignment.id !== abs!.id) : rows, ghost };
}

function Track({ blocks, t0, t1, ghost, cls }: { blocks: TaskBlock[]; t0: number; t1: number; ghost?: boolean; cls?: string }) {
  return (
    <div class={`mtrack${ghost ? ' ghost' : ''}${cls ? ' ' + cls : ''}`}>
      {blocks.filter((b) => b.end > t0 && b.start < t1).map((b, i) => {
        const l = (Math.max(b.start, t0) - t0) / (t1 - t0) * 100; const w = (Math.min(b.end, t1) - Math.max(b.start, t0)) / (t1 - t0) * 100;
        const t = TASKS[b.kind]; const rest = b.kind === 'break' || b.kind === 'nap';
        return <span key={i} class={`mb${rest ? ' rest' : ''}`} style={`left:${l}%;width:${w}%;background:${ghost ? '#fff' : t.bg};color:${ghost ? 'var(--bad)' : t.fg}`} title={`${fmtHM(b.start)}〜${fmtHM(b.end)} ${t.label}`}>{w > 7 ? t.label : ''}</span>;
      })}
    </div>
  );
}
export function Gaps({ issues, t0, t1 }: { issues: CoverageIssue[]; t0: number; t1: number }) {
  return <div class="mtrack gaps">{issues.filter((i) => i.t1 > t0 && i.t0 < t1).map((i, k) => <span key={k} class="mb gap" style={`left:${(Math.max(i.t0, t0) - t0) / (t1 - t0) * 100}%;width:${(Math.min(i.t1, t1) - Math.max(i.t0, t0)) / (t1 - t0) * 100}%`} title={`${issueTime(i)} ${i.text}`} />)}</div>;
}

function Board({ title, data, issues, t0, t1, extra }: { title: string; data: Rows; issues: CoverageIssue[]; t0: number; t1: number; extra?: { row: DayRow } }) {
  const ticks: number[] = []; for (let t = Math.ceil(t0 / 120) * 120; t < t1; t += 120) ticks.push(t);
  return (
    <div class="board">
      <div class="row spread wrap" style="margin-bottom:6px"><b style="font-weight:500">{title}</b>
        <span class={`chip ${issues.length ? 'bad' : 'ok'}`}>{issues.length ? `手薄な時間 ${issues.length}か所` : '手薄な時間なし'}</span></div>
      <div class="mgrid">
        <div class="mlab" /><div class="mtrack axis">{ticks.map((t) => <span key={t} class="tick" style={`left:${(t - t0) / (t1 - t0) * 100}%`}>{fmtHM(t)}</span>)}</div>
        <div class="mlab gl">不足する時間</div><Gaps issues={issues} t0={t0} t1={t1} />
        {data.ghost && <><div class="mlab ghost"><span class="chip bad">欠勤</span> <s>{data.ghost.staff.name}</s><div class="small">{data.ghost.assignment.shift}・{unitName(data.ghost.assignment.unitId)}</div></div><Track blocks={data.ghost.blocks} t0={t0} t1={t1} ghost /></>}
        {extra && <><div class="mlab mcand"><span class="chip pri">候補</span> {extra.row.staff.name}<div class="small">{extra.row.assignment.shift}・{unitName(extra.row.assignment.unitId)}</div></div><Track blocks={extra.row.blocks} t0={t0} t1={t1} cls="candtrack" /></>}
        {data.rows.filter((r) => !extra || r.assignment.id !== extra.row.assignment.id).map((r) => <><div class="mlab" key={r.assignment.id + 'l'}>{r.staff.name}{r.tail ? <span class="small"> 夜勤明け</span> : ''}<div class="small">{r.assignment.shift}・{unitName(r.assignment.unitId)}</div></div><Track key={r.assignment.id} blocks={r.blocks} t0={t0} t1={t1} /></>)}
      </div>
    </div>
  );
}


// ================= 該当の行だけを見せる「フォーカス表示」 =================
export const issuesFor = (v: Vacancy, list: Assignment[]): CoverageIssue[] => [0, ...(night(v) ? [1] : [])].flatMap((k) => coverage(buildDay(list, addDays(v.date, k))).map((i) => ({ ...i, t0: i.t0 + k * 1440, t1: i.t1 + k * 1440 }))).filter(scopeIssue(v));
export const gapText = (i: CoverageIssue) => (i.kind === 'headcount' ? `${issueTime(i)} ${i.scope}の対応人数が不足（必要${i.need}名・現在${i.have}名）` : `${issueTime(i)} ${i.text}`);
const gapLine = (list: CoverageIssue[]) => (list.length ? list.slice(0, 2).map((i) => `${issueTime(i)} ${i.scope}が${Math.max(1, i.need - i.have)}名不足`).join('、') + (list.length > 2 ? ` ほか${list.length - 2}か所` : '') : '不足する時間はありません');
const tagFromAdjust = (a?: Assignment): string | undefined => { const j = a?.adjust; if (!j) return undefined; if (j.breakAt != null) return '休憩を移動'; if (j.support) return '応援に入る'; if (j.startAt != null) return '出勤を前倒し'; if (j.endAt != null) return '退勤を延長'; if (j.swaps?.length) return '業務を入れ替え'; return '変更'; };
const blockKey = (b: TaskBlock) => `${b.start}|${b.end}|${b.kind}|${b.unitId}|${b.label}`;

export function windowFor(v: Vacancy, lists: CoverageIssue[][], span?: [number, number]): [number, number] {
  const def = SHIFTS[v.shift]; const lo = def.start - 60; const hi = def.end + 60;
  let a = Infinity; let b = -Infinity;
  for (const i of lists.flat()) { a = Math.min(a, i.t0); b = Math.max(b, i.t1); }
  if (span) { a = Math.min(a, span[0]); b = Math.max(b, span[1]); }
  if (!isFinite(a)) { a = def.start; b = def.end; }
  let t0 = Math.max(lo, Math.floor((a - 120) / 60) * 60); let t1 = Math.min(hi, Math.ceil((b + 120) / 60) * 60);
  if (t1 - t0 < 300) { const mid = (t0 + t1) / 2; t0 = Math.max(lo, Math.floor((mid - 150) / 60) * 60); t1 = Math.min(hi, t0 + 300); }
  return [t0, t1];
}

type FRow = { id: string; name: string; sub: string; blocks: TaskBlock[]; ghost?: boolean; tag?: string; tagCls?: string; changedKeys?: Set<string> };
function focusRows(all: Assignment[], v: Vacancy, ids: string[], tags: Record<string, string>, beforeRows?: Map<string, TaskBlock[]>): FRow[] {
  const abs = all.find((a) => a.id === v.fromAssignmentId);
  const rows: FRow[] = [];
  if (abs && abs.date === v.date && abs.status === 'absent') rows.push({ id: abs.id, name: staffById(abs.staffId).name, sub: `${abs.shift}・${unitName(abs.unitId)}`, blocks: buildBlocks({ ...abs, status: 'assigned' }, staffById(abs.staffId), 0), ghost: true });
  const day = buildDay(all, v.date);
  for (const id of ids) {
    const r = day.find((x) => x.assignment.id === id && !x.tail); if (!r) continue;
    const prev = beforeRows?.get(id); const keys = prev ? new Set(prev.map(blockKey)) : undefined;
    const st = r.assignment.status; const base = st === 'late' ? '遅刻' : st === 'early' ? '早退' : undefined;
    const tag = tags[id] ?? tagFromAdjust(r.assignment) ?? base;
    rows.push({ id, name: r.staff.name, sub: `${r.assignment.shift}・${unitName(r.assignment.unitId)}`, blocks: r.blocks, tag, tagCls: tags[id] === '入った' ? 'pri' : 'warn', changedKeys: keys });
  }
  return rows;
}

function FocusBoard({ title, rows, issues, t0, t1, note }: { title: string; rows: FRow[]; issues: CoverageIssue[]; t0: number; t1: number; note?: string }) {
  const step = t1 - t0 <= 420 ? 60 : t1 - t0 <= 720 ? 120 : 180; const ticks: number[] = []; for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) ticks.push(t);
  return (
    <div class="fboard">
      <div class="row spread wrap" style="gap:6px;margin-bottom:6px"><b style="font-weight:500">{title}</b>
        <span class={`chip ${issues.length ? 'bad' : 'ok'}`}>{issues.length ? `手薄な時間 ${issues.length}か所` : '手薄な時間なし'}</span></div>
      <div class="fgrid">
        <div class="fl" /><div class="mtrack axis">{ticks.map((t) => <span key={t} class="tick" style={`left:${(t - t0) / (t1 - t0) * 100}%`}>{fmtHM(t)}</span>)}</div>
        <div class="fl gl">不足する時間</div><Gaps issues={issues} t0={t0} t1={t1} />
        {rows.map((r) => <><div key={r.id + 'l'} class={`fl${r.ghost ? ' ghost' : ''}`}>
          <div class="fn">{r.ghost && <span class="chip bad">欠勤</span>} {r.ghost ? <s>{r.name}</s> : r.name}</div><div class="small fs">{r.sub}</div>{r.tag && <span class={`chip ${r.tagCls ?? 'warn'} ftag`}>{r.tag}</span>}</div>
          <div key={r.id} class={`mtrack${r.ghost ? ' ghost' : ''}`}>
            {r.blocks.filter((b) => b.end > t0 && b.start < t1).map((b, i) => {
              const l = (Math.max(b.start, t0) - t0) / (t1 - t0) * 100; const w = (Math.min(b.end, t1) - Math.max(b.start, t0)) / (t1 - t0) * 100;
              const tk = TASKS[b.kind]; const rest = b.kind === 'break' || b.kind === 'nap'; const chg = !r.ghost && r.changedKeys && !r.changedKeys.has(blockKey(b));
              return <span key={i} class={`mb${rest ? ' rest' : ''}${chg ? ' chg' : ''}`} style={`left:${l}%;width:${w}%;background:${r.ghost ? '#fff' : tk.bg};color:${r.ghost ? 'var(--bad)' : tk.fg}`} title={`${fmtHM(b.start)}〜${fmtHM(b.end)} ${b.label}`}>{w > 9 ? b.label : ''}</span>;
            })}
          </div></>)}
      </div>
      {issues.length > 0 ? <ul class="gaptext">{issues.slice(0, 4).map((i, k) => <li key={k}>{gapText(i)}</li>)}</ul> : <p class="small" style="margin-top:6px">{note ?? '不足する時間はありません。'}</p>}
    </div>
  );
}

/** いま（欠勤者の行と、不足する時間だけ） */
export function FocusNow({ all, v, title = 'いまのようす（該当の行だけ）' }: { all: Assignment[]; v: Vacancy; title?: string }) {
  const iss = useMemo(() => issuesFor(v, all), [all, v.id]);
  const gapRow = v.kind === 'gap' && v.fromAssignmentId ? [v.fromAssignmentId] : [];
  const rows = useMemo(() => focusRows(all, v, gapRow, {}), [all, v.id]);
  const [t0, t1] = windowFor(v, [iss]);
  return <FocusBoard title={title} rows={rows} issues={iss} t0={t0} t1={t1} />;
}

/** 「いま」と「変更後」を、同じ時間軸で上下に並べる。変更した行だけを出し、変わった所を強調する */
export function BeforeAfter({ v, before, after, rowIds, tags = {}, beforeTitle = 'いま', afterTitle, afterCaption }: { v: Vacancy; before: Assignment[]; after: Assignment[]; rowIds: string[]; tags?: Record<string, string>; beforeTitle?: string; afterTitle: string; afterCaption?: string }) {
  const k = rowIds.join(',');
  const data = useMemo(() => {
    const ib = issuesFor(v, before); const ia = issuesFor(v, after);
    const day0 = buildDay(before, v.date); const prev = new Map<string, TaskBlock[]>(); for (const id of rowIds) { const r = day0.find((x) => x.assignment.id === id && !x.tail); if (r) prev.set(id, r.blocks); }
    const dayA = buildDay(after, v.date); let a = Infinity; let b = -Infinity;
    for (const id of rowIds) { const r = dayA.find((x) => x.assignment.id === id && !x.tail); const pk = new Set((prev.get(id) ?? []).map(blockKey)); r?.blocks.forEach((bl) => { if (!pk.has(blockKey(bl)) && bl.kind !== 'break') { a = Math.min(a, bl.start); b = Math.max(b, bl.end); } }); }
    const span: [number, number] | undefined = isFinite(a) && ib.length === 0 ? [a, b] : undefined;
    const [t0, t1] = windowFor(v, [ib, ia], span);
    const gapRow = v.kind === 'gap' && v.fromAssignmentId ? [v.fromAssignmentId] : [];
    return { ib, ia, t0, t1, rb: focusRows(before, v, [...gapRow, ...rowIds.filter((id) => before.some((x) => x.id === id))], {}), ra: focusRows(after, v, [...gapRow, ...rowIds], tags, prev) };
  }, [before, after, v.id, k]);
  const resolved = data.ia.length === 0;
  return (
    <div class="focus">
      <FocusBoard title={beforeTitle} rows={data.rb} issues={data.ib} t0={data.t0} t1={data.t1} />
      <div class="fc-arrow"><Icon n="south" sm /> {afterCaption ?? ''}</div>
      <FocusBoard title={afterTitle} rows={data.ra} issues={data.ia} t0={data.t0} t1={data.t1} note={resolved ? '不足は解消しています。' : undefined} />
    </div>
  );
}

/** 解消したあと：どう解消したのか（該当の行だけを、前と後で並べる） */
export function ResolvedView({ s, v }: { s: { assignments: Assignment[] }; v: Vacancy }) {
  const r = v.resolution;
  if (!r) return <p class="small" style="margin-top:8px">この欠員は対応済みです（対応の記録は残っていません）。</p>;
  if (r.kind === 'adjust' && r.changes?.length) {
    const ids = r.changes.map((c) => c.assignmentId);
    const before = s.assignments.map((a) => (ids.includes(a.id) ? { ...a, adjust: undefined } : a.id === v.fromAssignmentId ? { ...a, covered: false } : a));
    return <BeforeAfter v={v} before={before} after={s.assignments} rowIds={ids} beforeTitle="調整する前" afterTitle="調整した後" afterCaption={`${r.title ?? '時間の調整'}：${r.changes.map((c) => c.text).join('／')}`} />;
  }
  const filler = s.assignments.find((a) => a.date === v.date && a.shift === v.shift && a.unitId === v.unitId && a.status !== 'absent' && a.staffId === (r.staffId ?? v.filledBy));
  if (!filler) return <p class="small" style="margin-top:8px">この欠員は対応済みです。</p>;
  const nm = staffById(filler.staffId).name;
  return <BeforeAfter v={v} before={s.assignments.filter((a) => a.id !== filler.id)} after={s.assignments} rowIds={[filler.id]} tags={{ [filler.id]: '入った' }} beforeTitle="入る前" afterTitle={`${nm}さんが入った後`} afterCaption={`${nm}さんが${v.shift}（${unitName(v.unitId)}）に入り、不足していた時間をつなぎました`} />;
}

/** 調整案：いま／この案の後 */
export function PlanBeforeAfter({ all, v, plan, name }: { all: Assignment[]; v: Vacancy; plan: AdjustPlan; name?: string }) {
  const after = useMemo(() => applyAdjust(all, plan.changes), [all, plan.id]);
  const ia = useMemo(() => issuesFor(v, after), [after, v.id]);
  const label = name ? `${name} の後` : 'この案の後';
  return <BeforeAfter v={v} before={all} after={after} rowIds={plan.changes.map((c) => c.assignmentId)} afterTitle={`${label}（承認するまで反映されません）`} afterCaption={`${plan.changes.map((c) => c.text).join('／')}。${ia.length === 0 ? '手薄な時間が解消します。' : `${gapLine(ia)}が残ります。`}`} />;
}

/** 候補が入った場合：いま／入った後 */
export function CandBeforeAfter({ all, v, cand }: { all: Assignment[]; v: Vacancy; cand: Candidate }) {
  if (!cand.assess) return null;
  const ia = useMemo(() => issuesFor(v, cand.assess!.after), [cand.staff.id, all]);
  return <BeforeAfter v={v} before={all} after={cand.assess.after} rowIds={['PREVIEW']} tags={{ PREVIEW: '入った' }} afterTitle={`${cand.staff.name}さんが入った後`} afterCaption={`${cand.staff.name}さんが入ると：${ia.length === 0 ? '不足していた時間がつながります。' : `${gapLine(ia)}が残ります。`}`} />;
}

/** その日のスケジュール。いつも「該当の行だけ」を見せ、ユニット全体は開いたときだけ */
export function DayImpact({ s, v, ranked, pv, setPv, plan, planName, closePlan }: { s: { assignments: Assignment[] }; v: Vacancy; ranked: Candidate[]; pv: string | null; setPv: (id: string | null) => void; plan?: AdjustPlan | null; planName?: string; closePlan?: () => void }) {
  const [full, setFull] = useState(false);
  const t0 = night(v) ? 16 * 60 : 6 * 60; const t1 = night(v) ? 34 * 60 : 21 * 60 + 30;
  const cand = pv ? ranked.find((c) => c.staff.id === pv) : undefined;
  const filled = v.state === 'filled';
  const fit = ranked.filter((c) => !c.blocked && !c.unfit); const unfit = ranked.filter((c) => !c.blocked && c.unfit);
  return (
    <section class="card" id="dayimpact">
      <div class="row spread wrap"><h3 class="h3"><Icon n="event_note" sm /> {fmtMD(v.date)} のスケジュール（{night(v) ? `${floorOf(v.unitId)}階の夜勤` : unitName(v.unitId)}）</h3></div>
      <p class="small" style="margin:2px 0 8px">休む人の予定は<b style="font-weight:500;color:var(--bad)">赤い取り消し線</b>で表示します。赤い帯は、必要な人数が足りない時間です。該当の行だけを表示しています。</p>
      {filled ? (v.resolution ? <ResolvedView s={s} v={v} /> : <FocusNow all={s.assignments} v={v} title="充足後のようす" />) : <FocusNow all={s.assignments} v={v} />}
      {plan && !filled && <div style="margin-top:16px"><PlanBeforeAfter all={s.assignments} v={v} plan={plan} name={planName} />
        <div class="row spread wrap" style="margin-top:6px"><span class="small">承認するまで、シフトは変わりません。</span><button class="btn sm" onClick={closePlan}>閉じる</button></div></div>}
      {!filled && <>
        <div class="row wrap" style="margin:16px 0 8px;gap:8px"><b style="font-weight:500">候補が入った後</b>
          <select class="input" style="width:auto;min-width:220px" aria-label="候補を選ぶ" value={pv ?? ''} onChange={(e) => setPv((e.target as HTMLSelectElement).value || null)}>
            <option value="">候補を選んでください</option>
            {fit.length > 0 && <optgroup label="条件に合う候補">{fit.map((c) => <option key={c.staff.id} value={c.staff.id}>{c.staff.name}</option>)}</optgroup>}
            {unfit.length > 0 && <optgroup label="条件に合わない候補（自動では打診しません）">{unfit.map((c) => <option key={c.staff.id} value={c.staff.id}>{c.staff.name}</option>)}</optgroup>}
          </select></div>
        {cand?.assess ? <>
          <CandBeforeAfter all={s.assignments} v={v} cand={cand} />
          <div class={`verdict ${cand.assess.ok ? 'ok' : 'ng'}`}><Icon n={cand.assess.ok ? 'check_circle' : 'error'} fill /> {cand.assess.ok ? 'この人が入ると、人数・スキルの穴が埋まります' : 'この人が入っても、次の点が残ります'}</div>
          <ul class="checks">{cand.assess.checks.map((c) => <li key={c.key} class={c.ok ? 'ok' : 'ng'}><Icon n={c.ok ? 'check_circle' : 'cancel'} sm /> {c.text}</li>)}</ul>
          {cand.assess.fixed.length > 0 && <p class="small">解消される時間：{cand.assess.fixed.map(issueTime).join('、')}</p>}
        </> : <p class="muted">候補を選ぶと、その人が入った後のスケジュールと、人数・スキル・休憩の確認結果が見られます。</p>}
      </>}
      <div class="row" style="margin-top:12px"><button class="btn sm" onClick={() => setFull(!full)} aria-expanded={full}>{full ? 'ユニット全体を閉じる' : 'ユニット全体を見る'}</button></div>
      {full && <FullBoards s={s} v={v} cand={cand} plan={plan} planName={planName} t0={t0} t1={t1} />}
    </section>
  );
}

/** ユニット（夜勤は階）の全員を並べた従来の表示。必要なときだけ開く */
function FullBoards({ s, v, cand, plan, planName, t0, t1 }: { s: { assignments: Assignment[] }; v: Vacancy; cand?: Candidate; plan?: AdjustPlan | null; planName?: string; t0: number; t1: number }) {
  const now = useMemo(() => build(s.assignments, v), [s.assignments, v.id]);
  const nowIssues = useMemo(() => issuesFor(v, s.assignments), [s.assignments, v.id]);
  const afterData = useMemo(() => (cand?.assess ? build(cand.assess.after, v) : undefined), [cand?.staff.id, s.assignments]);
  const afterIssues = useMemo(() => (cand?.assess ? issuesFor(v, cand.assess.after) : []), [cand?.staff.id, s.assignments]);
  const candRow = afterData?.rows.find((r) => r.assignment.id === 'PREVIEW');
  const planList = useMemo(() => (plan ? applyAdjust(s.assignments, plan.changes) : null), [plan?.id, s.assignments]);
  const planData = useMemo(() => (planList ? build(planList, v) : undefined), [planList]);
  const planIssues = useMemo(() => (planList ? issuesFor(v, planList) : []), [planList]);
  return (
    <div class="stack" style="gap:16px;margin-top:12px">
      <div class="mscroll"><Board title={v.state === 'filled' ? '充足後のようす（全員）' : 'いまのようす（全員）'} data={now} issues={nowIssues} t0={t0} t1={t1} /></div>
      {plan && planData && <div class="mscroll"><Board title={`${planName ?? '調整案'}を採用した後（全員）`} data={planData} issues={planIssues} t0={t0} t1={t1} /></div>}
      {cand && afterData && <div class="mscroll"><Board title={`${cand.staff.name}さんが入った後（全員）`} data={afterData} issues={afterIssues} t0={t0} t1={t1} extra={candRow ? { row: candRow } : undefined} /></div>}
    </div>
  );
}

const SK: Record<Holder['status'], { label: string; cls: string }> = { absent: { label: '休み', cls: 'bad' }, working: { label: '勤務', cls: 'pri' }, free: { label: '空き', cls: 'ok' }, blocked: { label: '打診不可', cls: '' } };
/** 同じスキルを持つ人は、その日どうなっているか */
export function SkillSituation({ s, v, ranked, openStaff }: { s: { assignments: Assignment[] }; v: Vacancy; ranked: Candidate[]; openStaff: (id: string) => void }) {
  const sit = useMemo(() => skillSituation(s.assignments, v, ranked), [s.assignments, v.id, ranked]);
  return (
    <section class="card">
      <h3 class="h3"><Icon n="badge" sm /> 同じスキルを持つ人の状況（{fmtMD(v.date)}）</h3>
      <p class="small" style="margin:2px 0 8px">休む人が持っているスキルを、ほかに誰が持ち、その日どうなっているかを確認できます。</p>
      <div class="stack" style="gap:8px">
        {sit.map((x) => { const free = x.holders.filter((h) => h.status === 'free').length; const bl = x.holders.filter((h) => h.status === 'blocked').length;
          return <details key={x.skill} class="skdet" open={x.required}><summary><b style="font-weight:500">{SKILLS[x.skill].label}</b>{x.required && <span class="chip bad" style="margin-left:6px">現場で不足</span>}
            <span class="small" style="margin-left:8px">勤務中 {x.onDuty}名／空き（打診可）{free}名{bl ? `／打診不可 ${bl}名` : ''}</span></summary>
            <div class="stack" style="gap:6px;margin-top:8px">{x.holders.map((h) => <div key={h.staff.id} class="row spread wrap small" style="color:var(--tx)"><span><button class="link" onClick={() => openStaff(h.staff.id)}>{h.staff.name}</button></span><span class="row" style="gap:6px"><span class="small">{h.text}</span><span class={`chip ${SK[h.status].cls}`}>{SK[h.status].label}</span></span></div>)}</div></details>; })}
        {!sit.length && <p class="muted">この欠員では、特に確認が必要なスキルはありません。</p>}
      </div>
    </section>
  );
}

export const MiniChecks = ({ c }: { c: Candidate }) => c.assess ? (
  <div class="row wrap" style="gap:4px;margin-top:8px">{c.assess.checks.map((k) => <span key={k.key} class={`chip ${k.ok ? 'ok' : 'bad'}`} title={k.text}>{k.ok ? '✓' : '✕'} {{ headcount: '人数', skill: 'スキル', rest: '休憩の交代', labor: '前後の勤務' }[k.key]}</span>)}</div>
) : null;
void TASK_GROUPS;
