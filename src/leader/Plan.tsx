import { useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import './plan.css';
import { DEFAULT_SHIFT_TYPES, THREE_SHIFT_TYPES, FACILITY, SHIFT_ORDER, STAFF, UNITS, staffById, unitName, type ShiftTypeDef } from '../core/facility';
import { loadSavedSetupState } from '../setup/storage';
import { isAllSetupUsed, SETUP_USAGE, usageChipLabel } from '../setup/usage';
import { addDays, daysInRange, DOW_JA, dow, fmtMD, parseYmd } from '../core/dates';
import { canWork, summarizeDay } from '../core/roster';
import { LABOR_RULES, monthStats } from '../core/labor';
import { holidayOf, eventsOn } from '../core/events';
import { monthEnd, prevHistoryOf } from '../core/planner';
import { canUndoRule, clearPlanFixed, createPlan, getChatRules, getRuleChange, planAssign, planSolving, publishPlan, remindUnsubmitted, removeChatRule, sendPlanRequest, setChatRuleOn, setPlanFixed, setPlanWish, undoChatRule } from '../core/store';
import type { FixedValue, State, WishValue } from '../core/store';
import type { Assignment, ShiftCode } from '../core/types';
import { Icon, Modal, useToast } from '../shared/ui';
import { useWide } from './util';
import { PlanChat, impactOf, runChanges } from './PlanChat';
import { PlanGrid, ReqModal } from './PlanGrid';
import { Day } from './Day';
import { effectText } from './Events';
import type { Go } from './util';
import { needSkillsFor } from '../core/roster';
import { SKILLS } from '../core/facility';
import { fmtMin } from '../core/dates';

const shiftMonth = (m: string, n: number) => { const [y, mm] = m.split('-').map(Number); const d = new Date(y, mm - 1 + n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const MAP_3SHIFT: Record<string, ShiftCode> = { 早番: '日' as ShiftCode, 日勤: '日' as ShiftCode, 遅番: '準' as ShiftCode, 夜勤: '深' as ShiftCode };
function build3ShiftPreviewPlan(month: string, days: string[], basePlan: State['plan']): NonNullable<State['plan']> {
  if (basePlan) {
    return {
      ...basePlan,
      draft: basePlan.draft.map((a) => ({ ...a, shift: MAP_3SHIFT[a.shift] ?? a.shift })),
    };
  }
  const active = STAFF.filter((x) => x.shifts.length && !x.isLeader);
  const draft: Assignment[] = [];
  let n = 0;
  days.forEach((d, dIdx) => {
    const dayShiftStaff = active[(dIdx * 3) % active.length];
    const junStaff = active[(dIdx * 3 + 1) % active.length];
    const shinStaff = active[(dIdx * 3 + 2) % active.length];
    UNITS.forEach((u, uIdx) => {
      const sDay = active[(dIdx * 3 + uIdx) % active.length] ?? dayShiftStaff;
      draft.push({ id: `P3-${++n}`, date: d, staffId: sDay.id, shift: '日' as ShiftCode, unitId: u.id, status: 'assigned', source: 'base' });
    });
    draft.push({ id: `P3-${++n}`, date: d, staffId: junStaff.id, shift: '準' as ShiftCode, unitId: junStaff.homeUnit, status: 'assigned', source: 'base' });
    draft.push({ id: `P3-${++n}`, date: d, staffId: shinStaff.id, shift: '深' as ShiftCode, unitId: shinStaff.homeUnit, status: 'assigned', source: 'base' });
  });
  return {
    month,
    createdAt: `${month}-01 09:00`,
    status: 'draft',
    draft,
    spares: {},
    notes: ['3交代（日勤・準夜・深夜）の表示プレビュー（深夜・準夜の翌日も明けなしで連続判定します）'],
    stats: { dayOffTotal: 0, dayOffHonored: 0, shortDays: 0, warnDays: 0, vacantSlots: 0, extraSlots: 0, nightMax: 8 },
  };
}

/** 日付ごとの勤務をまとめる */
const indexDraft = (draft: Assignment[]) => { const m = new Map<string, Assignment>(); for (const a of draft) if (a.status !== 'absent') m.set(`${a.staffId}|${a.date}`, a); return m; };

/** 候補（その日に入っていない人）。入れる日を出した人を先に */
function suggest(s: State, draft: Assignment[], date: string, shift: ShiftCode, month: string, n = 3) {
  const dayOff = s.collection.month === month ? s.collection.submitted : {};
  return STAFF.filter((x) => x.shifts.length && !x.isLeader && canWork(x, shift))
    .filter((x) => !draft.some((a) => a.staffId === x.id && a.date === date && a.status !== 'absent'))
    .filter((x) => !draft.some((a) => a.staffId === x.id && a.shift === '夜勤' && a.date === addDays(date, -1)))
    .filter((x) => !(dayOff as Record<string, { dates: string[] } | null>)[x.id]?.dates.includes(date))
    .map((x) => ({ staff: x, avail: !!s.availability[x.id]?.some((v) => v.date === date && (!v.shifts.length || v.shifts.includes(shift))), cnt: draft.filter((a) => a.staffId === x.id && a.status !== 'absent').length }))
    .sort((a, b) => Number(b.avail) - Number(a.avail) || a.cnt - b.cnt).slice(0, n);
}

export function Plan({ s, onOpen, go, openStaff, openResident }: { s: State; onOpen?: (target: string) => void; go: Go; openStaff: (id: string) => void; openResident: (id: string) => void }) {
  const [month, setMonth] = useState(s.plan?.month ?? s.collection.month);
  const [cell, setCell] = useState<{ staffId: string; date: string } | null>(null);
  const [dayM, setDayM] = useState<string | null>(null);
  const [pub, setPub] = useState(false);
  const [allSp, setAllSp] = useState(false);
  const [dayFull, setDayFull] = useState<string | null>(null);
  const [rq, setRq] = useState<{ staffId: string; date: string; shift: ShiftCode; unitId: string } | null>(null);
  const wide = useWide(1100);
  const roomy = useWide(1400);
  const [chatOpen, setChatOpen] = useState<boolean | null>(null);
  const dock = wide && (chatOpen ?? roomy);
  const [toast, setToast] = useToast();
  const plan = s.plan && s.plan.month === month ? s.plan : undefined;
  const is3ShiftPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('shifts') === '3';
  const shiftTypes: readonly ShiftTypeDef[] = is3ShiftPreview ? THREE_SHIFT_TYPES : DEFAULT_SHIFT_TYPES;
  const days = useMemo(() => daysInRange(`${month}-01`, monthEnd(month)), [month]);
  const displayPlan = useMemo(
    () => (is3ShiftPreview ? build3ShiftPreviewPlan(month, days, plan) : plan),
    [is3ShiftPreview, month, days, plan],
  );
  const displayState = useMemo(
    () => (is3ShiftPreview ? { ...s, assignments: s.assignments.map((a) => ({ ...a, shift: MAP_3SHIFT[a.shift] ?? a.shift })) } : s),
    [is3ShiftPreview, s],
  );
  const ro = displayPlan?.status === 'published' || is3ShiftPreview;
  const sub = s.collection.month === month ? s.collection.submitted : {};
  const staffIds = Object.keys(sub).filter((k) => sub[k]);
  const total = Object.keys(sub).length; const unsub = total - staffIds.length;
  const availN = Object.values(s.availability).reduce((t, l) => t + l.filter((x) => x.date.startsWith(month)).length, 0);
  const evs = s.events.filter((e) => e.date.startsWith(month));
  const dayOffOf = (id: string) => (sub as Record<string, { dates: string[] } | null>)[id]?.dates ?? [];

  const prevHist = useMemo(() => prevHistoryOf(displayState.assignments, month, 7), [displayState.assignments, month]);
  const draftWithPrev = useMemo(() => (displayPlan ? [...prevHist, ...displayPlan.draft] : []), [prevHist, displayPlan?.draft]);
  const sums = useMemo(() => (displayPlan && !is3ShiftPreview ? new Map(days.map((d) => [d, summarizeDay(draftWithPrev, d, s.events)])) : new Map()), [displayPlan, is3ShiftPreview, draftWithPrev, days, s.events]);
  const stats = useMemo(() => (displayPlan && !is3ShiftPreview ? monthStats(draftWithPrev, `${month}-01`) : []), [displayPlan, is3ShiftPreview, draftWithPrev, month]);
  const fixedN = useMemo(() => Object.values(s.planFixed?.[month] ?? {}).reduce((t, dm) => t + Object.keys(dm).length, 0), [s.planFixed, month]);
  const wishN = useMemo(() => Object.values(s.planWish?.[month] ?? {}).reduce((t, dm) => t + Object.keys(dm).length, 0), [s.planWish, month]);
  const warnList = stats.flatMap((x) => x.warnings.map((w) => ({ staffId: x.staffId, ...w })));
  const idx = useMemo(() => indexDraft(displayPlan?.draft ?? []), [displayPlan?.draft]);
  const spareBy = useMemo(() => { const m = new Map<string, string[]>(); for (const [d, l] of Object.entries(displayPlan?.spares ?? {})) for (const x of l) (m.get(x.staffId) ?? m.set(x.staffId, []).get(x.staffId)!).push(d); return m; }, [displayPlan?.spares]);

  const groups = UNITS.map((u) => ({ u, rows: STAFF.filter((x) => x.shifts.length && x.homeUnit === u.id) }));
  const savedSetupState = useMemo(() => loadSavedSetupState(), []);
  const savedSetup = !isAllSetupUsed() && savedSetupState
    ? {
        facilityName: savedSetupState.facility.name.trim() || '施設名未入力',
        staffCount: savedSetupState.staff.length,
      }
    : null;
  const defaultNightMax = SETUP_USAGE.rules && savedSetupState ? savedSetupState.rules.nightMax : 8;
  const solvingNow = planSolving()?.month === month;
  const [nightCap, setNightCap] = useState(false);
  const [ruleM, setRuleM] = useState(false);
  const [tabSel, setTab] = useState<'after' | 'before' | null>(null);
  const [rcOpen, setRcOpen] = useState(false);
  const openCheck = (t: 'after' | 'before') => { setTab(t); if (t === 'after') setRcOpen(true); setTimeout(() => document.getElementById('plan-check')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); };
  const make = (nightMax?: number) => { createPlan(month, nightMax ? { nightMax } : {}); setToast('シフト案を作成しました'); };

  // 作る前の確認：行ごとの判定（必須＝欠けると作れない／要確認＝作れるが結果が悪くなる／準備OK）
  const activeN = STAFF.filter((x) => x.shifts.length).length;
  const availStaffN = Object.values(s.availability).filter((l) => l.some((x) => x.date.startsWith(month))).length;
  const daysLeft = Math.round((parseYmd(s.collection.deadline).getTime() - parseYmd(s.today).getTime()) / 864e5);
  const dataLv: Lv = activeN === 0 ? 'need' : savedSetup ? 'warn' : 'ok';
  const offLv: Lv = !total || unsub > 0 ? 'warn' : 'ok';
  const lvs: Lv[] = [dataLv, offLv, 'ok', 'ok', 'ok', ...(fixedN + wishN > 0 ? ['ok' as Lv] : [])];
  const lvCount = { need: lvs.filter((x) => x === 'need').length, warn: lvs.filter((x) => x === 'warn').length, ok: lvs.filter((x) => x === 'ok').length };

  // できあがりの確認：一番上の判定（公開できるか）と、行ごとの判定。夜勤の回数・補欠は判定しない参考の行
  const shortRows = useMemo(() => (displayPlan && !is3ShiftPreview ? shortRowsOf(displayPlan, days, sums) : []), [displayPlan, is3ShiftPreview, days, sums]);
  const missedOff = useMemo(() => Object.entries(sub as Record<string, { dates: string[] } | null>).flatMap(([id, v]) => (v?.dates ?? []).filter((d) => d.startsWith(month) && idx.has(`${id}|${d}`)).map((d) => ({ id, d }))), [sub, month, idx]);
  const offTotal = Object.values(sub as Record<string, { dates: string[] } | null>).reduce((t, v) => t + (v?.dates.filter((d) => d.startsWith(month)).length ?? 0), 0);
  const placeLv: Lv = shortRows.some((r) => r.kind === 'slot') ? 'need' : shortRows.length ? 'warn' : 'ok';
  const missedLv: Lv = missedOff.length ? 'warn' : 'ok';
  const laborLv: Lv = warnList.length ? 'warn' : 'ok';
  const judged: Lv[] = [placeLv, missedLv, laborLv, ...(displayPlan?.appLaborRules === false ? ['warn' as Lv] : [])];
  const verdictLv: Lv = judged.includes('need') ? 'need' : judged.includes('warn') ? 'warn' : 'ok';
  const issueN = judged.filter((x) => x !== 'ok').length;
  const nightSt = stats.filter((x) => staffById(x.staffId).shifts.includes('夜勤' as ShiftCode));
  const spareN = Object.values(displayPlan?.spares ?? {}).reduce((t, l) => t + l.length, 0);
  const solverM = displayPlan?.notes.find((n) => n.startsWith('シフト作成君で1か月分'))?.match(/：([\d.]+)秒（(.+)）/);
  const madeBy = solverM ? `${solverM[1]}秒で作成・${solverM[2] === '最適解' ? '条件をすべて守った最良の案' : '時間内で最良の案'}` : undefined;
  const tab = !displayPlan || is3ShiftPreview ? 'before' : tabSel ?? (lvCount.need > 0 ? 'before' : 'after');
  const rc0 = getRuleChange(); const rc = rc0 && rc0.month === month ? rc0 : null;
  const rcBy = new Map<string, NonNullable<NonNullable<typeof rc>['cells']>>(); for (const x of rc?.cells ?? []) (rcBy.get(x.staffId) ?? rcBy.set(x.staffId, []).get(x.staffId)!).push(x);
  const chatRuleN = getChatRules().filter((r) => r.on).length;
  const otherNotes = (displayPlan?.notes ?? []).filter((n) => !DUP_NOTES.some((p) => n.startsWith(p)));

  return (
    <div class="page scroll plan">
      <div class={dock ? 'plandock' : undefined}>
      <div class="plancol">
      <div class="pbar">
        <div class="mnav"><button class="iconbtn" aria-label="前の月" onClick={() => setMonth(shiftMonth(month, -1))}><Icon n="chevron_left" /></button><h2>{month.slice(0, 4)}年{+month.slice(5)}月</h2><button class="iconbtn" aria-label="次の月" onClick={() => setMonth(shiftMonth(month, 1))}><Icon n="chevron_right" /></button></div>
        <div class="pbar-st">
          {displayPlan
            ? <>
                {is3ShiftPreview ? <span class="chip">3交代プレビュー</span>
                  : displayPlan.status === 'published' ? <span class="chip ok"><Icon n="check_circle" sm /> 公開済み</span>
                    : verdictLv === 'ok' ? <span class="chip ok"><Icon n="check_circle" sm /> 公開できます</span>
                      : <button class={`chip ${verdictLv === 'need' ? 'bad' : 'warn'} chipbtn`} onClick={() => openCheck('after')}><Icon n="warning" sm /> 見てほしい所 {issueN}件</button>}
                {rc && <span class="pbar-rc">
                  {rc.state === 'solving' ? <>「{rc.label}」で作り直し中…</> : rc.state === 'done' ? <>「{rc.label}」を足して作り直し・<button class="link" onClick={() => openCheck('after')}>変更{rc.count}件</button></> : <>「{rc.label}」を足しました</>}
                  {canUndoRule() && rc.state !== 'solving' && <button class="link" onClick={() => setToast(undoChatRule())}>元に戻す</button>}
                </span>}
              </>
            : <span class="small">まだ作っていません</span>}
        </div>
        <div class="pbar-act">
          <button class={`btn sm${displayPlan ? '' : ' pri'}`} disabled={solvingNow || lvCount.need > 0} onClick={() => make(nightCap ? 6 : undefined)} title={lvCount.need > 0 ? '「作る前」の必須をそろえると作れます' : undefined}><Icon n={displayPlan ? 'refresh' : 'auto_awesome'} sm /> {solvingNow ? '作成中…' : displayPlan ? '作り直す' : 'シフトを作る'}</button>
          {wide && !dock && <button class="btn sm" onClick={() => setChatOpen(true)}><Icon n="chat" sm /> シフト作成君に頼む</button>}
          {wide && dock && <button class="btn sm" onClick={() => setChatOpen(false)} aria-label="チャットを閉じる"><Icon n="right_panel_close" sm /> チャットを閉じる</button>}
          {displayPlan && !ro && <button class="btn sm pri" onClick={() => setPub(true)}><Icon n="publish" sm /> 公開する</button>}
          {displayPlan?.status === 'published' && <button class="btn sm" onClick={() => onOpen?.('shift')}>月間を見る</button>}
        </div>
      </div>

      {displayPlan && <div style="margin-top:12px">
        <PlanGrid s={displayState} plan={displayPlan} month={month} days={days} ro={!!ro} sums={sums as never} onDay={setDayFull} onCell={(staffId, date) => setCell({ staffId, date })} onToast={setToast} shiftTypes={shiftTypes} />
      </div>}

      <section class="card pcheck" id="plan-check">
        <div class="pcheck-h">
          <h3 class="h3">確認</h3>
          <div class="seg" role="tablist" aria-label="確認の種類">
            {displayPlan && !is3ShiftPreview && <button role="tab" aria-selected={tab === 'after'} onClick={() => setTab('after')}>できあがり{issueN > 0 && <span class={`cnt ${verdictLv}`}>{issueN}</span>}</button>}
            <button role="tab" aria-selected={tab === 'before'} onClick={() => setTab('before')}>作る前{lvCount.need + lvCount.warn > 0 && <span class={`cnt ${lvCount.need ? 'need' : 'warn'}`}>{lvCount.need + lvCount.warn}</span>}</button>
          </div>
        </div>

        {tab === 'after' && displayPlan && !is3ShiftPreview && <div class="checklist">
          <CheckRow lv={placeLv} title="人の配置"
            text={shortRows.length ? `${new Set(shortRows.map((r) => r.date)).size}日に不足（${SHORT_KINDS.map(([k, l]) => [l, shortRows.filter((r) => r.kind === k).length] as const).filter(([, n]) => n).map(([l, n]) => `${l}${n}`).join('・')}）` : '不足なし'}
            detail={shortRows.length > 0 && <details class="ck-more"><summary>日を見る</summary><ShortItems rows={shortRows} onDay={setDayFull} /></details>} />
          <CheckRow lv={missedLv} title="希望休"
            text={!offTotal ? '提出なし' : `${offTotal - missedOff.length}/${offTotal} 反映`}>
            {missedOff.length > 0 && !ro && <button class="btn sm" onClick={() => setCell({ staffId: missedOff[0].id, date: missedOff[0].d })}>{staffById(missedOff[0].id).name}さん {fmtMD(missedOff[0].d)}</button>}
          </CheckRow>
          <CheckRow lv={laborLv} title="労務"
            text={warnList.length ? `${new Set(warnList.map((w) => w.staffId)).size}名が目安超え` : '目安内'}
            detail={<details class="ck-more"><summary>{warnList.length ? '詳しく' : '集計'}</summary>
              {warnList.slice(0, 8).map((w, i) => <div key={i} class="row-li"><span><b style="font-weight:500">{staffById(w.staffId).name}</b>：{w.text}</span><span class="chip warn">{w.kind}</span></div>)}
              {warnList.length > 8 && <p class="small" style="margin-top:8px">ほか {warnList.length - 8} 件</p>}
              <div class="row-li"><span class="small">平均（常勤）</span><span class="small">勤務 {avg(stats.map((x) => x.workDays))}日／夜勤 {avg(stats.map((x) => x.nights))}回／公休 {avg(stats.map((x) => x.offDays))}日</span></div>
              <p class="small" style="margin-top:8px">目安です。最終判断は施設の就業規則で行ってください。</p>
            </details>} />
          {displayPlan.appLaborRules === false && <CheckRow lv="warn" title="外したルール" text="人手不足で2つ外して作成"
            detail={<details class="ck-more"><summary>どれを外したか</summary><p class="small">「夜勤明けも連勤に数える（5日まで）」「常勤は月8日以上休む」</p></details>} />}
          {nightSt.length > 0 && <CheckRow lv="info" title="夜勤" text={`1人 ${Math.min(...nightSt.map((x) => x.nights))}〜${Math.max(...nightSt.map((x) => x.nights))}回（平均${avg(nightSt.map((x) => x.nights))}）${displayPlan.stats.nightMax ? `・上限${displayPlan.stats.nightMax}回` : ''}`} />}
          <CheckRow lv="info" title="補欠" text={spareN ? `${spareBy.size}名・のべ${spareN}日` : 'なし'}
            detail={spareBy.size > 0 && <details class="ck-more"><summary>見る</summary>
              {[...spareBy.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, allSp ? 99 : 8).map(([id, ds]) => <div key={id} class="row-li"><span><b style="font-weight:500">{staffById(id).name}</b><span class="small"> {staffById(id).role}</span></span><span class="small">{ds.length}日：{ds.slice(0, 5).map((d) => `${+d.slice(8)}日`).join('、')}{ds.length > 5 ? ' ほか' : ''}</span></div>)}
              {spareBy.size > 8 && <button class="btn sm" style="margin-top:8px" onClick={() => setAllSp(!allSp)}>{allSp ? '閉じる' : `すべて（${spareBy.size}名）`}</button>}
            </details>} />
          {rc?.state === 'done' && <CheckRow lv={(rc.broken ?? 0) > 0 ? 'warn' : 'info'} title="直前の変更" text={`${rc.count ? `「${rc.label}」で${rc.count}件` : `「${rc.label}」：変更なし`}${(rc.broken ?? 0) > 0 ? `。この決まりは、ほかの決まりや人の数と両立せず守りきれていません（${rc.broken}件）。対象や差の数を見直すか、「必ず守る」にすると作れない理由が分かります` : ''}`}
            detail={(rc.cells ?? []).length > 0 && <details class="ck-more" open={rcOpen} onToggle={(e) => setRcOpen((e.target as HTMLDetailsElement).open)}><summary>どこが変わったか</summary>
              {[...rcBy.entries()].slice(0, 12).map(([id, l]) => <div key={id} class="row-li"><b style="font-weight:500">{staffById(id).name}</b><span class="small">{l.slice(0, 4).map((x) => `${fmtMD(x.date)} ${x.before}→${x.after}`).join('、')}{l.length > 4 ? ` ほか${l.length - 4}件` : ''}</span></div>)}
            </details>} />}
          {madeBy && <p class="small ck-foot">{madeBy}{otherNotes.length > 0 && `／${otherNotes.join('／')}`}</p>}
        </div>}

        {(tab === 'before' || !displayPlan || is3ShiftPreview) && <div class="checklist">
          <CheckRow lv={dataLv} title="使うデータ"
            text={activeN === 0 ? '職員が未登録' : savedSetup ? `仮データ（${FACILITY.name}）` : FACILITY.name}
            detail={activeN > 0 && savedSetup ? <span class="small">はじめの条件（{savedSetup.facilityName}・{savedSetup.staffCount}人）は未使用</span> : undefined}>
            {dataLv !== 'ok' && <button type="button" class="btn sm" onClick={() => onOpen?.('settings')}>設定を開く</button>}
          </CheckRow>
          <CheckRow lv={offLv} title="希望休"
            text={!total ? '未収集' : `${total - unsub}/${total} 提出・締切${fmtMD(s.collection.deadline).replace(/（.）/, '')}${daysLeft < 0 ? '（過ぎています）' : ''}`}>
            {!total && <button class="btn sm" onClick={() => go('collect')}>集める</button>}
            {unsub > 0 && <button class="btn sm" onClick={() => { const n = remindUnsubmitted(); setToast(`未提出の${n}名に催促を送りました`); }}>{unsub}名に催促</button>}
          </CheckRow>
          <CheckRow lv="ok" title="行事"
            text={evs.length ? `${evs.length}件（${evs.slice(0, 2).map((e) => `${+e.date.slice(8)}日 ${e.title}`).join('、')}${evs.length > 2 ? ' ほか' : ''}）` : 'なし'}
            detail={evs.length > 0 && <details class="ck-more"><summary>人数への影響</summary>{evs.map((e) => <div key={e.id} class="row-li"><span>{+e.date.slice(8)}日 {e.title}</span><span class="small">{effectText(e) || '影響なし'}</span></div>)}</details>} />
          <CheckRow lv="ok" title="入れる日" text={availN ? `${availStaffN}名・${availN}日分` : 'なし'} />
          <CheckRow lv="ok" title="守るルール" text={`労務ルール${chatRuleN ? `＋追加${chatRuleN}本` : ''}`}
            detail={<details class="ck-more"><summary>見る</summary>
              <div class="rule-see-list">
              <div class="row-li"><span class="small">労務の目安（警告）：連勤{LABOR_RULES.maxConsecutive}日まで・勤務間{LABOR_RULES.minIntervalH}時間・夜勤月{LABOR_RULES.maxNightsPerMonth}回・公休月{LABOR_RULES.minOffDays}日</span><button type="button" class="btn sm" onClick={() => setRuleM(true)}>労務を見る</button></div>
              <div class="row-li"><span class="small">作成の上限：夜勤 月{defaultNightMax}回</span><button type="button" class="btn sm" onClick={() => setRuleM(true)}>設定を見る</button></div>
              </div>
              <ChatRuleList onToast={setToast} />
            </details>} />
          {fixedN + wishN > 0 && <CheckRow lv="ok" title="残すマス" text={`固定${fixedN}・希望${wishN}`}>
            {fixedN > 0 && !ro && <button class="btn sm" onClick={() => { clearPlanFixed(month); setToast('この月の固定をすべて解除しました'); }}>固定を解除</button>}
          </CheckRow>}
          <label class="ck-opt">
            <input type="checkbox" checked={nightCap} disabled={solvingNow} onChange={(e) => setNightCap((e.target as HTMLInputElement).checked)} />
            <span>次に作るとき、夜勤を月6回までにする</span><span class="small">（いつもは月{defaultNightMax}回）</span>
          </label>
        </div>}
        {solvingNow && <p class="small" role="status" style="margin-top:8px">1か月分を組み直しています（数秒〜20秒）。先に簡易計算の案を出しています。</p>}
      </section>

      </div>
      {dock && <PlanChat s={s} month={month} onDone={setToast} />}
      </div>
      {!wide && <details class="card" style="margin-top:16px"><summary class="h3" style="cursor:pointer">シフト作成君に話して直す</summary><PlanChat s={s} month={month} onDone={setToast} /></details>}
      {dayFull && plan && <div class="dayfull" role="dialog" aria-label={`${fmtMD(dayFull)}の1日表示`}>
        <div class="dayfull-h"><b style="font-weight:500">作成中のシフト案での1日表示（{fmtMD(dayFull)}）</b><span class="small">1日タブと同じ画面です。不足は下の「人数とスキルのチェック」に出ます</span>
          <span style="flex:1" />{!ro && <button class="btn sm pri" onClick={() => { const d = dayFull; setDayM(d); }}><Icon n="edit" sm /> この日の枠を直す・依頼する</button>}<button class="btn sm" onClick={() => setDayFull(null)}><Icon n="close" sm /> 閉じる</button></div>
        <div class="dayfull-b"><Day s={{ ...s, assignments: draftWithPrev }} date={dayFull} go={(view, o) => { if (view === 'day' && o?.date) setDayFull(o.date); else { setDayFull(null); go(view, o); } }} openStaff={openStaff} openResident={openResident} /></div></div>}
      {rq && <ReqModal s={displayState} staffId={rq.staffId} date={rq.date} shift={rq.shift} unitId={rq.unitId} kind="work" shiftTypes={shiftTypes} onClose={() => setRq(null)} onSent={setToast} />}
      {cell && displayPlan && <CellModal s={displayState} plan={displayPlan} month={month} staffId={cell.staffId} date={cell.date} shiftTypes={shiftTypes} onClose={() => setCell(null)} onDone={(t) => { setCell(null); setToast(t); }} />}
      {dayM && displayPlan && <DayModal s={displayState} plan={displayPlan} month={month} date={dayM} ro={ro} onClose={() => setDayM(null)} onPick={(id) => { setDayM(null); setCell({ staffId: id, date: dayM }); }} onToast={setToast} />}
      {pub && plan && <Modal title="このシフトを公開しますか？" onClose={() => setPub(false)} footer={<><button class="btn" onClick={() => setPub(false)}>戻る</button><button class="btn pri" onClick={() => { publishPlan(); setPub(false); setToast('シフトを公開しました'); }}>公開する</button></>}>
        <p>{+month.slice(5)}月の勤務表・日次・月次が、この内容に置き換わります。</p>
        <ul style="margin:8px 0 0 18px"><li>希望休：{plan.stats.dayOffTotal}件中{plan.stats.dayOffHonored}件を反映</li><li>人が足りない日：{plan.stats.shortDays}日（欠員枠 {plan.stats.vacantSlots}）</li><li>労務の警告：{warnList.length}件</li></ul>
        {plan.stats.shortDays > 0 && <p class="small" style="margin-top:8px;color:var(--bad)">人が足りない日が残っています。公開後は欠員として、シフト作成君に任せて対応できます。</p>}
      </Modal>}
      {ruleM && <Modal title="作るときに守るルール" onClose={() => setRuleM(false)} footer={<><button class="btn" onClick={() => { setRuleM(false); onOpen?.('labor'); }}>労務の画面へ</button><button class="btn" onClick={() => { setRuleM(false); onOpen?.('settings:rules'); }}>設定を変える</button><button class="btn pri" onClick={() => setRuleM(false)}>閉じる</button></>}>
        <table class="rule-tbl">
          <thead><tr><th>ルール</th><th>値</th><th>守り方</th></tr></thead>
          <tbody>
            <tr><td>連勤</td><td>{LABOR_RULES.maxConsecutive}日まで</td><td>超えたら警告</td></tr>
            <tr><td>勤務と勤務のあいだ</td><td>{LABOR_RULES.minIntervalH}時間以上</td><td>超えたら警告</td></tr>
            <tr><td>夜勤の回数</td><td>月{defaultNightMax}回まで</td><td>作るときの上限{nightCap ? '（今回は6回）' : ''}</td></tr>
            <tr><td>夜勤の回数（目安）</td><td>月{LABOR_RULES.maxNightsPerMonth}回まで</td><td>超えたら警告</td></tr>
            <tr><td>公休</td><td>月{LABOR_RULES.minOffDays}日以上</td><td>下回ったら警告</td></tr>
            <tr><td>夜勤明け</td><td>翌日は休み</td><td>必ず守る</td></tr>
            {getChatRules().filter((r) => r.on).map((r) => <tr key={r.id}><td colSpan={2}>{r.label}</td><td>{r.strength === '絶対' ? '必ず守る' : 'できるだけ守る'}<span class="small">（チャットで追加）</span></td></tr>)}
          </tbody>
        </table>
        <p class="small" style="margin-top:8px">値は仮の値です。施設に合わせて「設定を変える」から直せます。</p>
      </Modal>}
      {toast}
    </div>
  );
}
const avg = (a: number[]) => (a.length ? (a.reduce((t, x) => t + x, 0) / a.length).toFixed(1) : '—');

type Lv = 'need' | 'warn' | 'ok' | 'info';
const LV_ICON: Record<Lv, string> = { need: 'error', warn: 'warning', ok: 'check_circle', info: 'info' };
const LV_LABEL: Record<Lv, string> = { need: '必須', warn: '要確認', ok: 'OK', info: '参考' };
/** 作成メモのうち、できあがりの確認の行や帯に出しているもの（重ねて出さない） */
const DUP_NOTES = ['希望休：', '補欠（', '行事のため追加配置', '夜勤の回数：', 'シフト作成君で1か月分', '夜勤は1人あたり月'];

/** 確認の1行：項目名・ひとこと・操作を1行に。理由や一覧は detail（開くと出る）に入れる。info は判定しない参考の行 */
function CheckRow({ lv, title, text, detail, children }: { lv: Lv; title: string; text: string; detail?: ComponentChildren; children?: ComponentChildren }) {
  const kids = (Array.isArray(children) ? children : [children]).filter(Boolean);
  return (
    <div class={`ck ${lv}`}>
      <span class="ck-ic" aria-label={LV_LABEL[lv]}><Icon n={LV_ICON[lv]} sm /></span>
      <span class="ck-t">{title}</span>
      <span class="ck-x">{text}</span>
      <span class="ck-act">{kids}</span>
      {detail && <div class="ck-sub">{detail}</div>}
    </div>
  );
}

/** 「守るルール」の中：AI（チャット）で追加したルールの一覧（チェックで有効/無効を切り替え） */
function ChatRuleList({ onToast }: { onToast: (t: string) => void }) {
  const rules = getChatRules();
  if (!rules.length) return null;
  const on = rules.filter((r) => r.on).length;
  return (
    <div class="chatrules">
      <div class="chatrules-h">
        <span class="chatrules-t">チャットで足したルール</span>
        <span class="small">{on}/{rules.length}本 使用中</span>
      </div>
      {rules.map((r) => {
        const strength = r.strength === '絶対' ? '必ず守る' : r.strength === '強く' ? 'できるだけ守る' : 'できれば守る';
        return (
          <div key={r.id} class={`row-li chatrule-item${r.on ? '' : ' off'}`}>
            <label class="chatrule-lbl">
              <input
                type="checkbox"
                checked={r.on}
                onChange={(e) => {
                  const next = (e.target as HTMLInputElement).checked;
                  setChatRuleOn(r.id, next);
                  onToast(next ? `「${r.label}」を有効にしました` : `「${r.label}」を無効にしました（次の作成から外れます）`);
                }}
              />
              <span class="chatrule-name">{r.label}</span>
              <span class="chip">{strength}</span>
              {!r.on && <span class="small">（無効）</span>}
            </label>
            <button
              type="button"
              class="btn sm"
              aria-label={`${r.label}を削除`}
              onClick={() => { removeChatRule(r.id); onToast(`「${r.label}」を削除しました`); }}
            >
              削除
            </button>
          </div>
        );
      })}
    </div>
  );
}

function CellModal({ s, plan, month, staffId, date, shiftTypes = DEFAULT_SHIFT_TYPES, onClose, onDone }: { s: State; plan: NonNullable<State['plan']>; month: string; staffId: string; date: string; shiftTypes?: readonly ShiftTypeDef[]; onClose: () => void; onDone: (t: string) => void }) {
  const st = staffById(staffId);
  const akeIds = useMemo(() => new Set(shiftTypes.filter((x) => x.nextDay === '明け').map((x) => x.id)), [shiftTypes]);
  const cur = plan.draft.find((a) => a.staffId === staffId && a.date === date && a.status !== 'absent');
  const curFixed = s.planFixed?.[month]?.[staffId]?.[date];
  const curWish = s.planWish?.[month]?.[staffId]?.[date] ?? '';
  const [shift, setShift] = useState<ShiftCode | 'off'>(cur?.shift ?? 'off');
  const [unit, setUnit] = useState(cur?.unitId ?? st.homeUnit);
  const [locked, setLocked] = useState(Boolean(curFixed));
  const [wish, setWish] = useState<WishValue | ''>(curWish);
  const wantOff = (s.collection.month === month ? s.collection.submitted[staffId]?.dates ?? [] : []).includes(date);
  const prevHist = useMemo(() => prevHistoryOf(s.assignments, month, 7), [s.assignments, month]);
  const draftWithPrev = useMemo(() => [...prevHist, ...plan.draft], [prevHist, plan.draft]);
  const after = useMemo(() => {
    let d = plan.draft.filter((a) => !(a.staffId === staffId && a.date === date));
    if (shift !== 'off') d = d.filter((a) => !(a.date === date && a.shift === shift && a.unitId === unit)).concat({ id: 'TMP', date, staffId, shift, unitId: unit, status: 'assigned' });
    return d;
  }, [shift, unit]);
  const shiftUnchanged = (shift === 'off' && !cur) || (cur && shift === cur.shift && unit === cur.unitId);
  const unchanged = shiftUnchanged && locked === Boolean(curFixed) && wish === curWish;
  const displaced = shift !== 'off' ? plan.draft.find((a) => a.date === date && a.shift === shift && a.unitId === unit && a.staffId !== staffId) : undefined;
  const warns: string[] = []; const oks: string[] = [];
  if (shift !== 'off') {
    if (!canWork(st, shift)) warns.push(`${st.name}さんは${shift}に入れません（勤務可能な勤務帯・退勤上限）`);
    if (wantOff) warns.push('本人の希望休の日です');
    if (draftWithPrev.some((a) => a.staffId === staffId && akeIds.has(a.shift) && a.date === addDays(date, -1))) warns.push('前日が夜勤のため、夜勤明けの日です');
    if (akeIds.has(shift) && plan.draft.some((a) => a.staffId === staffId && a.date === addDays(date, 1) && a.status !== 'absent')) warns.push('翌日（夜勤明けの日）に勤務があります');
    if (displaced) warns.push(`いまの担当 ${staffById(displaced.staffId).name}さんは、この枠から外れます`);
  }
  const before = monthStats(draftWithPrev, `${month}-01`).find((x) => x.staffId === staffId)?.warnings.map((w) => w.text) ?? [];
  const afterW = monthStats([...prevHist, ...after], `${month}-01`).find((x) => x.staffId === staffId)?.warnings ?? [];
  for (const w of afterW) if (!before.includes(w.text)) warns.push(`労務：${w.text}`);
  const b = summarizeDay(draftWithPrev, date, s.events); const a = summarizeDay([...prevHist, ...after], date, s.events);
  if (a.vacant < b.vacant) oks.push(`その日の欠員枠が ${b.vacant} → ${a.vacant} に減ります`);
  if (a.vacant > b.vacant) warns.push(`その日の欠員枠が ${b.vacant} → ${a.vacant} に増えます`);
  if (a.issues.length > b.issues.length) warns.push(`人数・スキルの不足が ${b.issues.length} → ${a.issues.length} か所に増えます`);
  if (a.issues.length < b.issues.length) oks.push(`人数・スキルの不足が ${b.issues.length} → ${a.issues.length} か所に減ります`);
  if (!warns.length && !oks.length && !shiftUnchanged) oks.push('人数・スキル・労務の面で、問題は見つかりません');
  const pickShift = (k: ShiftCode | 'off') => {
    setShift(k);
    const sameAsCur = (k === 'off' && !cur) || (cur && k === cur.shift && unit === cur.unitId);
    if (!sameAsCur) setLocked(true);
  };
  const pickUnit = (uId: string) => {
    setUnit(uId);
    if (!cur || cur.unitId !== uId || cur.shift !== shift) setLocked(true);
  };
  const apply = () => {
    if (!shiftUnchanged) {
      if (cur && (shift === 'off' || cur.shift !== shift || cur.unitId !== unit)) planAssign(date, cur.shift, cur.unitId, null, { lock: false });
      if (shift !== 'off') planAssign(date, shift, unit, staffId, { lock: false });
    }
    const nextFix: FixedValue | null = locked ? (shift === 'off' ? '休' : shift) : null;
    if (nextFix !== (curFixed ?? null)) setPlanFixed(month, [{ staffId, date, value: nextFix }]);
    if (wish !== curWish) setPlanWish(month, [{ staffId, date, value: wish || null }]);
    if (!shiftUnchanged) {
      onDone(shift === 'off' ? `${st.name}さんを休みにしました${locked ? '（固定）' : ''}` : `${st.name}さんを${fmtMD(date)} ${shift}に入れました${locked ? '（固定）' : ''}`);
    } else if (nextFix !== (curFixed ?? null)) {
      onDone(locked ? `${st.name}さんの${fmtMD(date)}を固定しました` : `${st.name}さんの${fmtMD(date)}の固定を解除しました`);
    } else {
      onDone(wish ? `${st.name}さんの${fmtMD(date)}に「${wish}」の希望を付けました` : `${st.name}さんの${fmtMD(date)}の希望を解除しました`);
    }
  };
  return (
    <Modal title={`${st.name}さん　${fmtMD(date)}`} onClose={onClose} footer={<><button class="btn" onClick={onClose}>やめる</button><button class="btn pri" disabled={!!unchanged} onClick={apply}>この内容にする</button></>}>
      <p class="muted">いま：{cur ? `${cur.shift}（${unitName(cur.unitId)}）` : '休み'}{wantOff ? '／希望休あり' : ''}{curFixed ? '／固定中' : ''}{curWish ? `／希望：${curWish}` : ''}</p>
      <div class="sec-title">勤務帯</div>
      <div class="choice">{[...shiftTypes.map((x) => ({ id: x.id, label: x.name })), { id: 'off', label: '休み' }].map((k) => <button key={k.id} aria-pressed={shift === k.id} onClick={() => pickShift(k.id as ShiftCode | 'off')}>{k.label}</button>)}</div>
      {shift !== 'off' && <><div class="sec-title">ユニット</div><div class="choice">{UNITS.map((u) => <button key={u.id} aria-pressed={unit === u.id} onClick={() => pickUnit(u.id)}>{u.name}</button>)}</div></>}
      <div class="sec-title">固定と勤務の希望（作り直すときに効きます）</div>
      <label class="row" style="gap:8px;cursor:pointer;font-size:14px">
        <input type="checkbox" checked={locked} onChange={(e) => setLocked((e.target as HTMLInputElement).checked)} />
        <span>このマスを固定する（作り直しても残す）</span>
      </label>
      <div class="choice" style="margin-top:8px">
        {([['', '希望なし'], ...shiftTypes.map((k) => [k.id, k.name] as const), ['勤務', 'どれでも勤務']] as const).map(([v, lbl]) => (
          <button key={v || 'none'} aria-pressed={wish === v} onClick={() => setWish(v as WishValue | '')}>{lbl}</button>
        ))}
      </div>
      <div class="sec-title">変更したときの確認</div>
      <ul class="chk">{warns.map((t) => <li key={t} class="ng"><Icon n="warning" sm /> {t}</li>)}{oks.map((t) => <li key={t} class="ok"><Icon n="check_circle" sm /> {t}</li>)}{unchanged && <li class="muted">変更はありません。</li>}</ul>
    </Modal>
  );
}

function DayModal({ s, plan, month, date, ro, onClose, onPick, onToast }: { s: State; plan: NonNullable<State['plan']>; month: string; date: string; ro: boolean; onClose: () => void; onPick: (id: string) => void; onToast: (t: string) => void }) {
  const hol = holidayOf(date); const evs = eventsOn(s.events, date); const sm = summarizeDay(plan.draft, date, s.events);
  const spares = plan.spares[date] ?? [];
  const [slot, setSlot] = useState<string>(() => { for (const sh of SHIFT_ORDER) for (const u of UNITS) if (!plan.draft.some((a) => a.date === date && a.shift === sh && a.unitId === u.id && a.status !== 'absent')) return `${sh}|${u.id}`; return `${SHIFT_ORDER[0]}|${UNITS[0].id}`; });
  const [sSh, sU] = slot.split('|') as [ShiftCode, string];
  const slotCands = useMemo(() => suggest(s, plan.draft, date, sSh, month, 6).map((c) => ({ ...c, imp: impactOf(s, plan.draft, [{ date, shift: sSh, unitId: sU, staffId: c.staff.id }], month) })), [slot, plan.draft]);
  const cur = plan.draft.filter((a) => a.date === date && a.shift === sSh && a.unitId === sU && a.status !== 'absent');
  return (
    <Modal title={`${fmtMD(date)}${hol ? `（${hol}）` : ''}`} onClose={onClose}>
      {evs.map((e) => <p key={e.id} class="small" style="margin-bottom:4px"><span class="chip pri">{e.kind}</span> {e.title}{e.effect ? `　${e.effect.allStaff ? '対象の勤務帯は全員参加' : e.effect.extra ? `${e.effect.shifts.join('・')}に+${e.effect.extra}名` : ''}` : ''}</p>)}
      <p class="muted" style="margin:8px 0">勤務 {sm.staffCount}名／欠員枠 {sm.vacant}{sm.eventShort ? `／行事の追加人数が不足 ${sm.eventShort}` : ''}</p>
      <div class="slots">
        <div class="hd" />{UNITS.map((u) => <div key={u.id} class="hd">{u.name}</div>)}
        {SHIFT_ORDER.map((sh) => <>
          <div class="lb" key={sh + 'l'}>{sh}</div>
          {UNITS.map((u) => { const as = plan.draft.filter((a) => a.date === date && a.shift === sh && a.unitId === u.id && a.status !== 'absent');
            const sg = as.length ? [] : suggest(s, plan.draft, date, sh, month, 2);
            return <div key={sh + u.id} class={`cell${as.length ? '' : ' empty'}`}>
              {as.map((a) => <button key={a.id} disabled={ro} onClick={() => onPick(a.staffId)}>{staffById(a.staffId).name.split(' ')[0]}</button>)}
              {!as.length && <span class="small" style="color:var(--bad)">空き</span>}
              {!ro && sg.map((c) => <button key={c.staff.id} title={c.avail ? '入れる日を出した人' : ''} onClick={() => { planAssign(date, sh, u.id, c.staff.id); onToast(`${c.staff.name}さんを${sh}（${u.name}）に入れました`); }}>{c.avail ? '★' : '＋'}{c.staff.name.split(' ')[0]}</button>)}
            </div>; })}
        </>)}
      </div>
      {!ro && <p class="small" style="margin-top:8px">空き枠の下の「＋名前」で入れられます。★は「入れる日」を出した人です。</p>}
      {!ro && <><div class="sec-title">手動で直す（候補と、入れた後の変化）</div>
        <div class="choice">{SHIFT_ORDER.flatMap((sh) => UNITS.map((u) => { const n = plan.draft.filter((a) => a.date === date && a.shift === sh && a.unitId === u.id && a.status !== 'absent').length; const k = `${sh}|${u.id}`;
          return <button key={k} aria-pressed={slot === k} onClick={() => setSlot(k)}>{sh}・{u.name}{n ? '' : '（空き）'}</button>; }))}</div>
        <p class="small" style="margin:6px 0">{sSh}（{unitName(sU)}）：いまの担当 {cur.length ? cur.map((a) => staffById(a.staffId).name).join('、') : 'なし（空き）'}{cur.length ? '。入れると、いまの担当は外れます。' : ''}</p>
        <div class="stack" style="gap:8px">{slotCands.map((c) => <div key={c.staff.id} class="cand"><div style="flex:1;min-width:0"><div class="row" style="gap:6px;flex-wrap:wrap"><b style="font-weight:500">{c.staff.name}</b><span class="small">{c.staff.role}</span>{c.avail && <span class="chip pri">入れる日を出した人</span>}{c.staff.homeUnit !== sU && <span class="chip">他ユニットから応援</span>}</div>
          <ul class="small" style="margin:4px 0 0 16px">{c.imp.map((x) => <li key={x}>{x}</li>)}</ul></div>
          <div class="row" style="gap:6px"><button class="btn sm pri" onClick={() => { runChanges([{ date, shift: sSh, unitId: sU, staffId: c.staff.id }]); onToast(`${c.staff.name}さんを${sSh}（${unitName(sU)}）に入れました`); }}>入れる</button><button class="btn sm" onClick={() => { sendPlanRequest('work', c.staff.id, date, { shift: sSh, unitId: sU }); onToast(`${c.staff.name}さんに出勤を依頼しました`); }}>出勤を依頼</button></div></div>)}
          {!slotCands.length && <p class="muted">入れられる人が見つかりません。</p>}</div></>}
      <div class="sec-title">補欠（入れる日を出した人）</div>
      {spares.length ? spares.map((x) => <div key={x.staffId} class="row-li"><span><b style="font-weight:500">{staffById(x.staffId).name}</b></span><span class="small">{x.shifts.join('・')}</span></div>) : <p class="muted">この日の補欠はいません。</p>}
    </Modal>
  );
}
void parseYmd;

/** 不足の一覧（要対応と同じ見せ方）：いつ・どこで・何が（人数／スキル）足りないか */
type ShortRow = { kind: 'slot' | 'skill' | 'head'; date: string; text: string; sub: string };
const SHORT_KINDS: [ShortRow['kind'], string][] = [['slot', '担当なし'], ['skill', 'スキル不足'], ['head', '人数不足']];
/** 不足の一覧（担当のいない枠と、時間帯ごとの人数・スキル不足） */
function shortRowsOf(plan: NonNullable<State['plan']>, days: string[], sums: Map<string, { issues: { t0: number; t1: number; scope: string; need: number; have: number; kind: string; text: string }[] }>): ShortRow[] {
  return days.flatMap((d) => {
    const sm = sums.get(d); if (!sm) return [];
    const slots = SHIFT_ORDER.flatMap((sh) => UNITS.filter((u) => !plan.draft.some((a) => a.date === d && a.shift === sh && a.unitId === u.id && a.status !== 'absent')).map((u): ShortRow => ({ kind: 'slot', date: d, text: `${sh} ${u.name}の担当がいません`, sub: (() => { const sk = needSkillsFor(plan.draft, d, sh, u.id).filter((k) => k !== 'night'); return sk.length ? `必須：${sk.map((k) => SKILLS[k].label).join('・')}` : ''; })() })));
    const iss = sm.issues.map((i): ShortRow => ({ kind: i.kind === 'skill' ? 'skill' : 'head', date: d, text: `${fmtMin(i.t0)}〜${fmtMin(i.t1)} ${i.scope}：${i.text}`, sub: `必要 ${i.need}／現在 ${i.have}` }));
    return [...slots, ...iss];
  });
}
/** 「人の配置」の行の中：不足の一覧。行を押すとその日の1日表示 */
function ShortItems({ rows, onDay }: { rows: ShortRow[]; onDay: (d: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <div>
      <div class="stack" style="gap:6px">{shown.map((r, i) => <button key={i} class="vitem" onClick={() => onDay(r.date)}>
        <div class="row spread"><b style="font-weight:500">{fmtMD(r.date)}</b><span class={`chip ${r.kind === 'head' ? 'warn' : 'bad'}`}>{SHORT_KINDS.find(([k]) => k === r.kind)![1]}</span></div>
        <div class="small">{r.text}{r.sub ? `／${r.sub}` : ''}</div></button>)}</div>
      {rows.length > 8 && <button class="btn sm" style="margin-top:8px" onClick={() => setAll(!all)}>{all ? '閉じる' : `すべて見る（${rows.length}件）`}</button>}
      <p class="small" style="margin-top:6px">行を押すと、その日の1日表示が開きます（候補と依頼もそこから）</p>
    </div>
  );
}
