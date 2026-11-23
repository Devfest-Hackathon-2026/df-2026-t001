import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_SHIFT_TYPES, shiftStyleOf, SKILLS, STAFF, UNITS, unitName, type ShiftTypeDef } from '../core/facility';
import type { SkillId } from '../core/types';
import { DOW_JA, addDays, daysInRange, dow, fmtMD } from '../core/dates';
import { holidayOf, eventsOn } from '../core/events';
import { PAID_TARGET, paidCount } from '../core/paidleave';
import { planEdit, planRestore, sendPlanRequest, setPlanFixed, setPlanWish } from '../core/store';
import type { FixedValue, PlanCode, PlanEdit, PlanReqKind, PlanSnap, State, WishValue } from '../core/store';
import type { Assignment, ShiftCode } from '../core/types';
import { Icon, Modal } from '../shared/ui';
import { SHORT } from './util';
import { impactOf } from './PlanChat';
import { EVENT_STYLE } from './Events';

type Plan = NonNullable<State['plan']>;
const SK_ORDER: SkillId[] = ['medical', 'dementia', 'bath', 'swallow', 'terminal', 'driver'];

export function PlanGrid({ s, plan, month, days, ro, sums, onDay, onCell, onToast, shiftTypes = DEFAULT_SHIFT_TYPES }: { s: State; plan: Plan; month: string; days: string[]; ro: boolean; sums: Map<string, { level: string; vacant: number; issues: unknown[] }>; onDay: (d: string) => void; onCell: (staffId: string, date: string) => void; onToast: (t: string) => void; shiftTypes?: readonly ShiftTypeDef[] }) {
  const [unitF, setUnitF] = useState('all');
  const [skillF, setSkillF] = useState<SkillId | 'all'>('all');
  const [sel, setSel] = useState<{ r0: number; c0: number; r1: number; c1: number } | null>(null);
  const [fillTo, setFillTo] = useState<{ r: number; c: number } | null>(null);
  const [unitSel, setUnitSel] = useState<'home' | string>('home');
  const [undo, setUndo] = useState<{ label: string; snap: PlanSnap }[]>([]);
  const [redo, setRedo] = useState<{ label: string; snap: PlanSnap }[]>([]);
  const [check, setCheck] = useState<string[]>([]);
  const [req, setReq] = useState(false);
  const drag = useRef<'none' | 'sel' | 'fill'>('none');
  const clip = useRef<{ code: PlanCode; unitId?: string }[][] | null>(null);
  const anchor = useRef<{ r: number; c: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const codes = useMemo(() => {
    const shiftBtns: { code: PlanCode; label: string; key: string }[] = shiftTypes.map((st, idx) => ({
      code: st.id as PlanCode,
      label: st.short,
      key: idx < 8 ? String(idx + 1) : '',
    }));
    const paidKey = shiftTypes.length < 9 ? String(shiftTypes.length + 1) : '';
    return [
      ...shiftBtns,
      { code: 'paid' as PlanCode, label: '有', key: paidKey },
      { code: 'off' as PlanCode, label: '休', key: '0' },
    ];
  }, [shiftTypes]);

  const keyMap = useMemo(() => {
    const m: Record<string, PlanCode> = { 有: 'paid', 休: 'off', '0': 'off', Delete: 'off', Backspace: 'off' };
    shiftTypes.forEach((st, idx) => {
      if (idx < 8) m[String(idx + 1)] = st.id as PlanCode;
      m[st.short] = st.id as PlanCode;
      m[st.id] = st.id as PlanCode;
    });
    if (shiftTypes.length < 9) m[String(shiftTypes.length + 1)] = 'paid';
    return m;
  }, [shiftTypes]);

  const wishChoices = useMemo<{ value: WishValue; label: string }[]>(() => [
    ...shiftTypes.map((st) => ({ value: st.id as WishValue, label: `希望：${st.name}` })),
    { value: '勤務', label: '希望：どれでも勤務' },
  ], [shiftTypes]);

  const akeIds = useMemo(
    () => new Set(shiftTypes.filter((st) => st.nextDay === '明け').map((st) => st.id)),
    [shiftTypes],
  );
  const letter = (c: PlanCode) => (c === 'off' ? '休' : c === 'paid' ? '有' : shiftStyleOf(c, shiftTypes).short);
  const shortKeysHint = useMemo(() => {
    const maxNum = shiftTypes.length < 9 ? shiftTypes.length + 1 : Math.min(8, shiftTypes.length);
    const numRange = maxNum > 1 ? `1〜${maxNum}・0` : '1・0';
    return `${numRange} か ${shiftTypes.map((st) => st.short).join('')}有休`;
  }, [shiftTypes]);

  const [showPrev, setShowPrev] = useState(false);
  const prevDays = useMemo(() => (days.length ? daysInRange(addDays(days[0], -7), addDays(days[0], -1)) : []), [days]);
  const prevIdx = useMemo(() => {
    const m = new Map<string, Assignment>();
    const prevSet = new Set(prevDays);
    for (const a of s.assignments) if (prevSet.has(a.date) && a.status !== 'absent') m.set(`${a.staffId}|${a.date}`, a);
    return m;
  }, [s.assignments, prevDays]);
  const monthFixed = s.planFixed?.[month] ?? {};
  const monthWish = s.planWish?.[month] ?? {};

  const idx = useMemo(() => { const m = new Map<string, Assignment>(); for (const a of plan.draft) if (a.status !== 'absent') m.set(`${a.staffId}|${a.date}`, a); return m; }, [plan.draft]);
  const sub = s.collection.month === month ? s.collection.submitted : {};
  const dayOffOf = (id: string) => ((sub as Record<string, { dates: string[] } | null>)[id]?.dates ?? []);
  const groups = UNITS.filter((u) => unitF === 'all' || u.id === unitF).map((u) => ({ u, rows: STAFF.filter((x) => x.shifts.length && x.homeUnit === u.id && (skillF === 'all' || x.skills.includes(skillF))) })).filter((g) => g.rows.length);
  const staffRows = groups.flatMap((g) => g.rows);
  const codeAt = (id: string, d: string): PlanCode => (s.paidLeave?.[id]?.includes(d) ? 'paid' : idx.get(`${id}|${d}`)?.shift ?? 'off');
  const norm = (r: NonNullable<typeof sel>) => ({ r0: Math.min(r.r0, r.r1), r1: Math.max(r.r0, r.r1), c0: Math.min(r.c0, r.c1), c1: Math.max(r.c0, r.c1) });
  const nr = sel ? norm(sel) : null;
  const inSel = (r: number, c: number) => !!nr && r >= nr.r0 && r <= nr.r1 && c >= nr.c0 && c <= nr.c1;
  const snap = (): PlanSnap => ({
    draft: plan.draft,
    paid: s.paidLeave ?? {},
    fixed: Object.fromEntries(Object.entries(monthFixed).map(([k, v]) => [k, { ...v }])),
  });

  const commit = (edits: PlanEdit[], label: string) => {
    if (ro || !edits.length) return;
    const real = edits.filter((e) => codeAt(e.staffId, e.date) !== e.code || (e.code !== 'off' && e.code !== 'paid' && e.unitId && idx.get(`${e.staffId}|${e.date}`)?.unitId !== e.unitId));
    if (!real.length) return;
    const before = snap();
    const changes = real.flatMap((e) => { const cur = idx.get(`${e.staffId}|${e.date}`); const out: { date: string; shift: ShiftCode; unitId: string; staffId: string | null }[] = [];
      if (cur) out.push({ date: e.date, shift: cur.shift, unitId: cur.unitId, staffId: null });
      if (e.code !== 'off' && e.code !== 'paid') out.push({ date: e.date, shift: e.code, unitId: e.unitId ?? STAFF.find((x) => x.id === e.staffId)!.homeUnit, staffId: e.staffId });
      return out; });
    const imp = impactOf(s, plan.draft, changes, month).filter((x) => !x.startsWith('人数・スキル・労務の面で'));
    setUndo((u) => [...u, { label, snap: before }].slice(-30)); setRedo([]);
    planEdit(real);
    setCheck(imp.length ? imp.slice(0, 6) : ['この変更で増える問題は見つかりません（変更したマスを固定しました）']);
  };
  const edit = (code: PlanCode) => {
    if (!nr) return;
    const edits: PlanEdit[] = [];
    for (let r = nr.r0; r <= nr.r1; r++) for (let c = nr.c0; c <= nr.c1; c++) { const st = staffRows[r]; const d = days[c]; if (!st || !d) continue;
      const cur = idx.get(`${st.id}|${d}`); edits.push({ staffId: st.id, date: d, code, unitId: unitSel !== 'home' ? unitSel : cur?.unitId ?? st.homeUnit }); }
    commit(edits, `${edits.length}マスを「${letter(code)}」に`);
  };
  const selectedCells = useMemo(() => {
    if (!nr) return [];
    const out: { staffId: string; date: string }[] = [];
    for (let r = nr.r0; r <= nr.r1; r++) for (let c = nr.c0; c <= nr.c1; c++) {
      const st = staffRows[r]; const d = days[c];
      if (st && d) out.push({ staffId: st.id, date: d });
    }
    return out;
  }, [nr?.r0, nr?.r1, nr?.c0, nr?.c1, staffRows, days]);
  const allLocked = selectedCells.length > 0 && selectedCells.every((x) => Boolean(monthFixed[x.staffId]?.[x.date]));
  const commonWish: WishValue | '' = useMemo(() => {
    if (!selectedCells.length) return '';
    const first = monthWish[selectedCells[0].staffId]?.[selectedCells[0].date] ?? '';
    return selectedCells.every((x) => (monthWish[x.staffId]?.[x.date] ?? '') === first) ? first : '';
  }, [selectedCells, monthWish]);
  const anyWish = selectedCells.some((x) => Boolean(monthWish[x.staffId]?.[x.date]));

  const toggleLock = () => {
    if (ro || !selectedCells.length) return;
    if (allLocked) {
      setPlanFixed(month, selectedCells.map((x) => ({ ...x, value: null })));
      onToast(`${selectedCells.length}マスの固定を解除しました`);
    } else {
      setPlanFixed(month, selectedCells.map((x) => {
        const c = codeAt(x.staffId, x.date);
        const value: FixedValue = c === 'off' || c === 'paid' ? '休' : c;
        return { ...x, value };
      }));
      onToast(`${selectedCells.length}マスを固定しました（作り直しても残ります）`);
    }
  };
  const applyWish = (val: WishValue | '') => {
    if (ro || !selectedCells.length) return;
    setPlanWish(month, selectedCells.map((x) => ({ ...x, value: val || null })));
    onToast(val ? `${selectedCells.length}マスに「${val}」の希望を付けました` : `${selectedCells.length}マスの希望を解除しました`);
  };

  const doUndo = () => { const u = undo[undo.length - 1]; if (!u) return; setRedo((r) => [...r, { label: u.label, snap: snap() }]); setUndo(undo.slice(0, -1)); planRestore(u.snap); setCheck([]); onToast(`元に戻しました：${u.label}`); };
  const doRedo = () => { const r = redo[redo.length - 1]; if (!r) return; setUndo((u) => [...u, { label: r.label, snap: snap() }]); setRedo(redo.slice(0, -1)); planRestore(r.snap); onToast(`やり直しました：${r.label}`); };
  const copy = () => { if (!nr) return; clip.current = Array.from({ length: nr.r1 - nr.r0 + 1 }, (_, i) => Array.from({ length: nr.c1 - nr.c0 + 1 }, (_, j) => { const st = staffRows[nr.r0 + i]; const d = days[nr.c0 + j]; return { code: codeAt(st.id, d), unitId: idx.get(`${st.id}|${d}`)?.unitId }; })); onToast('コピーしました'); };
  const paste = () => { const cl = clip.current; if (!cl || !nr) return; const edits: PlanEdit[] = [];
    for (let i = 0; i < cl.length; i++) for (let j = 0; j < cl[0].length; j++) { const st = staffRows[nr.r0 + i]; const d = days[nr.c0 + j]; if (st && d) edits.push({ staffId: st.id, date: d, code: cl[i][j].code, unitId: cl[i][j].unitId }); }
    commit(edits, `${edits.length}マスに貼り付け`); };
  const finishFill = () => {
    if (!nr || !fillTo) return;
    const h = nr.r1 - nr.r0 + 1, w = nr.c1 - nr.c0 + 1; const edits: PlanEdit[] = [];
    const right = fillTo.c > nr.c1 && fillTo.r >= nr.r0 && fillTo.r <= nr.r1; const rEnd = right ? nr.r1 : Math.max(nr.r1, fillTo.r); const cEnd = right ? fillTo.c : nr.c1;
    for (let r = nr.r0; r <= rEnd; r++) for (let c = nr.c0; c <= cEnd; c++) { if (r <= nr.r1 && c <= nr.c1) continue; const src = { st: staffRows[nr.r0 + ((r - nr.r0) % h)], d: days[nr.c0 + ((c - nr.c0) % w)] }; const st = staffRows[r]; const d = days[c]; if (!st || !d) continue;
      edits.push({ staffId: st.id, date: d, code: codeAt(src.st.id, src.d), unitId: idx.get(`${src.st.id}|${src.d}`)?.unitId }); }
    commit(edits, `ドラッグで${edits.length}マスを塗りつぶし`); setSel({ r0: nr.r0, c0: nr.c0, r1: rEnd, c1: cEnd });
  };
  useEffect(() => { const off = (e: MouseEvent) => { for (const d of document.querySelectorAll<HTMLDetailsElement>('.xl-more[open]')) if (!d.contains(e.target as Node)) d.open = false; }; document.addEventListener('mousedown', off); return () => document.removeEventListener('mousedown', off); }, []);
  useEffect(() => { const up = () => { if (drag.current === 'fill') finishFill(); drag.current = 'none'; setFillTo(null); }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up); });

  const move = (dr: number, dc: number, ext: boolean) => {
    const cur = sel ?? { r0: 0, c0: 0, r1: 0, c1: 0 };
    const clamp = (v: number, m: number) => Math.max(0, Math.min(m, v));
    const r = clamp(cur.r1 + dr, staffRows.length - 1), c = clamp(cur.c1 + dc, days.length - 1);
    setSel(ext ? { ...cur, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
    wrap.current?.querySelector(`[data-rc="${r}-${c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? doRedo() : doUndo(); }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return doRedo(); }
    if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); return copy(); }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); return paste(); }
    const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key]) { e.preventDefault(); return move(arrows[e.key][0], arrows[e.key][1], e.shiftKey); }
    if (e.key === 'Escape') return setSel(null);
    if (e.key === 'Enter' && nr) { e.preventDefault(); return onCell(staffRows[nr.r0].id, days[nr.c0]); }
    const code = keyMap[e.key]; if (code && !mod) { e.preventDefault(); edit(code); }
  };

  const start = (r: number, c: number, e: MouseEvent) => {
    if (e.button !== 0) return;
    wrap.current?.focus();
    if (e.shiftKey && sel) { setSel({ ...sel, r1: r, c1: c }); return; }
    anchor.current = { r, c }; drag.current = 'sel'; setSel({ r0: r, c0: c, r1: r, c1: c });
  };
  const enter = (r: number, c: number) => { if (drag.current === 'sel' && anchor.current) setSel({ r0: anchor.current.r, c0: anchor.current.c, r1: r, c1: c }); else if (drag.current === 'fill') setFillTo({ r, c }); };

  const one = nr && nr.r0 === nr.r1 && nr.c0 === nr.c1 ? { st: staffRows[nr.r0], d: days[nr.c0] } : null;
  const target = nr ? { st: staffRows[nr.r0], d: days[nr.c0] } : null;
  const evByDay = (d: string) => eventsOn(s.events, d);
  const kindBy = new Map(days.map((d) => [d, shortKind(sums.get(d))]));
  let rowNo = -1;
  const shownPrev = showPrev ? prevDays : [];

  return (
    <section class="card" id="plan-grid">
      <div class="pg-head">
        <h3 class="h3">勤務表（職員×日）</h3>
        <div class="seg pg-units" role="group" aria-label="ユニットで絞り込む">
          {[{ id: 'all', name: '全体' }, ...UNITS.map((u) => ({ id: u.id, name: u.name }))].map((u) => <button key={u.id} aria-pressed={unitF === u.id} onClick={() => setUnitF(u.id)}>{u.name}</button>)}
        </div>
        <select class="input pg-skill" value={skillF} onChange={(e) => setSkillF((e.target as HTMLSelectElement).value as SkillId | 'all')} aria-label="スキルで絞り込む">
          {(['all', ...SK_ORDER] as const).map((k) => <option key={k} value={k}>{k === 'all' ? 'スキル：すべて' : `スキル：${SKILLS[k].label}`}</option>)}
        </select>
      </div>

      {!ro && <div class="xl-bar" role="toolbar" aria-label="選択中のマスを変える">
        {codes.map((c) => <button key={c.code} class={`btn sm ${c.code === 'paid' ? 'tonal' : ''}`} disabled={!nr} title={c.key ? `${c.key} キー` : c.label} onClick={() => edit(c.code)}>{c.label}</button>)}
        <span class="xl-sep" />
        <button class="iconbtn sm" disabled={!undo.length} onClick={doUndo} title="戻す（Ctrl+Z）" aria-label="戻す"><Icon n="undo" sm /></button>
        <button class="iconbtn sm" disabled={!redo.length} onClick={doRedo} title="やり直す（Ctrl+Y）" aria-label="やり直す"><Icon n="redo" sm /></button>
        <span class="xl-sep" />
        <details class="xl-more">
          <summary class="btn sm">その他 <Icon n="expand_more" sm /></summary>
          <div class="xl-pop">
            <select class="input" style="max-width:150px;min-height:32px;padding:2px 8px" value={unitSel} onChange={(e) => setUnitSel((e.target as HTMLSelectElement).value)} aria-label="勤務するユニット"><option value="home">ユニット：所属どおり</option>{UNITS.map((u) => <option key={u.id} value={u.id}>ユニット：{u.name}</option>)}</select>
            <button class={`btn sm ${allLocked ? 'pri' : ''}`} disabled={!selectedCells.length} onClick={toggleLock} title="固定したマスは作り直しても残ります"><Icon n={allLocked ? 'lock_open' : 'lock'} sm /> {allLocked ? '固定を解除' : '固定'}</button>
            <select
              class="input"
              style="max-width:168px;min-height:32px;padding:2px 8px"
              disabled={!selectedCells.length}
              value={commonWish}
              aria-label="勤務の希望を設定"
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value as WishValue | '';
                applyWish(v);
              }}
            >
              <option value="">{anyWish ? '希望を解除' : '希望を付ける…'}</option>
              {wishChoices.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
            </select>
            <button class="btn sm" disabled={!nr} onClick={copy}>コピー</button>
            <button class="btn sm" disabled={!nr || !clip.current} onClick={paste}>貼り付け</button>
            <button class="btn sm" disabled={!one} onClick={() => setReq(true)}><Icon n="send" sm /> 依頼を送る</button>
          </div>
        </details>
        <span class="small xl-selinfo">{nr ? `${selectedCells.length}マス選択中${target ? `（${target.st.name} ${fmtMD(target.d)}〜）` : ''}` : 'マスを選んで変更'}</span>
      </div>}
      {check.length > 0 && <div class="xl-check" role="status"><b style="font-weight:500">いまの変更の確認</b><ul>{check.map((x) => <li key={x} class={/増|不足|労務|連勤|間隔/.test(x) && !x.includes('見つかりません') ? 'ng' : 'ok'}>{x}</li>)}</ul></div>}

      <div class="pgrid-wrap xl" ref={wrap} tabIndex={0} onKeyDown={onKey} aria-label="勤務表。矢印キーで移動し、数字キーで勤務を変更できます">
        <table class={`pgrid${ro ? ' ro' : ''}`} style={`table-layout:fixed;width:${178 + 30 * shownPrev.length + 34 * days.length}px`}>
          <colgroup><col style="width:178px" />{shownPrev.map((d) => <col key={d} style="width:30px" />)}{days.map((d) => <col key={d} style="width:34px" />)}</colgroup>
          <thead>
            <tr class="pg-evrow">
              <th class="nm"><span class="row" style="gap:6px;justify-content:space-between"><span class="small">行事</span><button class="linkbtn small" onClick={() => setShowPrev(!showPrev)} aria-expanded={showPrev}>{showPrev ? '◂ 前月を隠す' : '前月を見る ▸'}</button></span></th>
              {shownPrev.length > 0 && <th colSpan={shownPrev.length} class="prev-h prev-end">前月7日（{+shownPrev[0].slice(5, 7)}月・編集不可）</th>}
              {days.map((d) => { const ev = evByDay(d); const e0 = ev[0]; const st = e0 ? EVENT_STYLE[e0.kind] : null;
                return <th key={d} class={e0 ? 'evcol' : ''} title={ev.map((e) => `${e.kind}：${e.title}`).join('／')}>{e0 && st ? <span class="evl" style={`background:${st.bg};color:${st.fg}`}>{e0.title.slice(0, 2)}</span> : null}</th>; })}
            </tr>
            <tr>
              <th class="nm">職員</th>
              {shownPrev.map((pd, i) => {
                const w = dow(pd);
                const endCls = i === shownPrev.length - 1 ? ' prev-end' : '';
                return <th key={pd} class={`dh prev-col${endCls}`} title={`${fmtMD(pd)}（前月実績・変更不可）`}><span class="d">{+pd.slice(8)}</span><span class="w">{DOW_JA[w]}</span></th>;
              })}
              {days.map((d) => { const w = dow(d); const sm = sums.get(d); const hol = holidayOf(d); const ev = evByDay(d).length > 0;
                return <th key={d} class={`dh${w === 0 ? ' sun' : w === 6 ? ' sat' : ''}${hol ? ' hol hol-col' : ''}${ev ? ' evcol' : ''}${shortKind(sm) !== 'ok' ? ` col-${shortKind(sm)}` : ''}`} onClick={() => onDay(d)} title="クリックで、この日の1日表示"><span class="d">{+d.slice(8)}</span><span class="w">{DOW_JA[w]}</span></th>; })}
            </tr>
            <tr class="shrow">
              <th class="nm"><span class="small">不足</span></th>
              {shownPrev.map((pd, i) => <th key={pd} class={`prev-col${i === shownPrev.length - 1 ? ' prev-end' : ''}`} />)}
              {days.map((d) => { const k = shortKind(sums.get(d)); const sm = sums.get(d); const n = (sm?.vacant ?? 0) + (sm?.issues.length ?? 0); const sk = (sm?.issues as { kind: string }[] | undefined)?.filter((i) => i.kind === 'skill').length ?? 0;
                return <th key={d} class={`${evByDay(d).length ? 'evcol' : ''}${k !== 'ok' ? ` col-${k}` : ''}`}><button class={`shb ${k}`} onClick={() => onDay(d)} title={n ? `不足 ${n}件（担当なし ${sm?.vacant ?? 0}・スキル ${sk}・人数 ${n - (sm?.vacant ?? 0) - sk}）：クリックでこの日の1日表示` : '不足なし'} aria-label={`${fmtMD(d)} 不足 ${n}件`}>{n || ''}</button></th>; })}
            </tr>
          </thead>
          <tbody>{groups.map(({ u, rows }) => <>
            <tr key={u.id + 'h'} class="ugrp"><th colSpan={shownPrev.length + days.length + 1}><span>{u.floor}階 {u.name}</span></th></tr>
            {rows.map((st) => { rowNo++; const r = rowNo; const off = dayOffOf(st.id); const pc = paidCount(s, st.id); const lack = PAID_TARGET - pc;
              return <tr key={st.id}><td class="nm"><div class="nmc"><button class="link" style="font-size:13px" onClick={() => onCell(st.id, days[0])}>{st.name}</button>
                {skillF !== 'all' && <span class="sk">{st.skills.filter((k) => k !== 'night').slice(0, 3).map((k) => <span key={k} class={`mini ${k === 'medical' ? 'bad' : ''}`} title={SKILLS[k].label}>{SHORT[k]}</span>)}</span>}
                <span class={`pl${lack > 0 ? ' lack' : ''}`} title={`有給休暇 今年度 ${pc}日／義務 ${PAID_TARGET}日（デモ用の仮値）`}>有休 {pc}/{PAID_TARGET}</span></div></td>
                {shownPrev.map((pd, i) => {
                  const pa = prevIdx.get(`${st.id}|${pd}`);
                  const pake = !pa && s.assignments.some((x) => x.staffId === st.id && akeIds.has(x.shift) && x.date === dayAfter(pd, -1) && x.status !== 'absent');
                  const endCls = i === shownPrev.length - 1 ? ' prev-end' : '';
                  const prevSty = pa ? shiftStyleOf(pa.shift, shiftTypes) : null;
                  return <td key={pd} class={`c prev-col${endCls}`} title={pa ? `${fmtMD(pd)} ${prevSty?.name ?? pa.shift}（前月実績・変更不可）` : pake ? `${fmtMD(pd)} 夜勤明け（前月実績・変更不可）` : `${fmtMD(pd)} 休み（前月実績・変更不可）`}>
                    {pa && prevSty ? <span class="prev-sh">{prevSty.short}</span> : pake ? <span class="ake">明</span> : <span class="off">・</span>}
                  </td>;
                })}
                {days.map((d, c) => { const a = idx.get(`${st.id}|${d}`); const code = codeAt(st.id, d); const wantOff = off.includes(d);
                  const prevDate = dayAfter(d, -1);
                  const prevA = c === 0 ? prevIdx.get(`${st.id}|${prevDate}`) : undefined;
                  const ake = !a && code === 'off' && (c === 0 ? (prevA ? akeIds.has(prevA.shift) : false) : plan.draft.some((x) => x.staffId === st.id && akeIds.has(x.shift) && x.date === prevDate));
                  const cur = inSel(r, c); const hand = nr && r === nr.r1 && c === nr.c1;
                  const fixedVal = monthFixed[st.id]?.[d];
                  const wishVal = monthWish[st.id]?.[d];
                  const cellSty = a ? shiftStyleOf(a.shift, shiftTypes) : null;
                  const titleParts = [
                    a ? `${cellSty?.name ?? a.shift}／${unitName(a.unitId)}${a.unitId !== st.homeUnit ? '（他ユニットへ応援）' : ''}` : code === 'paid' ? '有給休暇' : ake ? '夜勤明け' : '休み',
                    wantOff ? '希望休の日' : '',
                    fixedVal ? `固定：${fixedVal}（作り直しても残ります）` : '',
                    wishVal ? `希望：${wishVal}` : '',
                  ].filter(Boolean).join('／');
                  return <td key={d} data-rc={`${r}-${c}`} class={`c${holidayOf(d) ? ' hol-col' : ''}${evByDay(d).length ? ' evcol' : ''}${kindBy.get(d) !== 'ok' ? ` col-${kindBy.get(d)}` : ''}${fixedVal ? ' locked' : ''}${cur ? ' selc' : ''}`} title={titleParts} onMouseDown={(e) => start(r, c, e)} onMouseEnter={() => enter(r, c)} onDblClick={() => onCell(st.id, d)}>
                    {code === 'paid' ? <span class="t paid">有</span> : a && cellSty ? <span class={`t${wantOff ? ' conf' : ''}`} style={{ background: cellSty.bg, color: cellSty.fg }}>{cellSty.short}{a.unitId !== st.homeUnit && <span class="xu-dot" aria-label={`${unitName(a.unitId)}へ応援`} />}</span> : ake ? <span class="ake">明</span> : wantOff ? <span class="t hope">休</span> : <span class="off">・</span>}
                    {fixedVal && <span class="cell-lock" aria-label="固定"><Icon n="lock" sm /></span>}
                    {wishVal && <span class="cell-wish" aria-label={`希望：${wishVal}`} />}
                    {hand && !ro && <span class="fillh" onMouseDown={(e) => { e.stopPropagation(); drag.current = 'fill'; setFillTo({ r, c }); }} title="ドラッグで塗りつぶし" />}
                  </td>; })}</tr>; })}
          </>)}</tbody>
        </table>
      </div>
      <div class="legend" style="margin-top:10px">{shiftTypes.map((st) => <span key={st.id} class="lgt"><span class="t" style={{ width: '22px', height: '20px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: '5px', background: st.bg, color: st.fg }}>{st.short}</span>{st.name}</span>)}
        <span class="lgt"><span class="t paid" style="padding:0 5px">有</span>有給休暇</span><span class="lgt"><span style="color:var(--ok);outline:1px dashed var(--ok);border-radius:5px;padding:0 5px">休</span>希望休</span>
        <span class="lgt"><span class="mk-lock-demo"><Icon n="lock" sm /></span>固定（作り直しても残る）</span>
        <span class="lgt"><span class="mk-wish-demo" />勤務の希望</span>
        <span class="lgt"><span class="mk-prev-demo">早</span>前月7日（参照のみ）</span>
        <span class="lgt"><span style="width:14px;height:6px;background:var(--bad);display:inline-block;border-radius:2px" />不足あり</span></div>
      <p class="small" style="margin-top:6px">{ro ? '公開済み。変更は月間・1日の画面から。' : `マスを選んで ${shortKeysHint} で変更（変えたマスは固定）。ダブルクリックで詳しく設定。`}灰色の7列は前月。</p>
      {undo.length > 0 && <details class="more"><summary>直前の変更（{undo.length}件）</summary><ol class="xl-hist">{undo.slice().reverse().slice(0, 8).map((u, i) => <li key={i}><span>{u.label}</span>{i === 0 && <button class="linkbtn" onClick={doUndo}>元に戻す</button>}</li>)}</ol></details>}
      {req && one && <ReqModal s={s} staffId={one.st.id} date={one.d} shiftTypes={shiftTypes} onClose={() => setReq(false)} onSent={onToast} />}
    </section>
  );
}
/** その日の不足の種類：担当なし・スキル不足は赤（short）、時間帯の人数不足だけなら橙（warn） */
const shortKind = (sm?: { vacant: number; issues: unknown[] }): 'ok' | 'warn' | 'short' => { if (!sm) return 'ok'; const iss = sm.issues as { kind: string }[]; return sm.vacant > 0 || iss.some((i) => i.kind === 'skill') ? 'short' : iss.length ? 'warn' : 'ok'; };
const dayAfter = (d: string, n: number) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

export function ReqModal({ s, staffId, date, shift: sh0, unitId: u0, kind: k0, shiftTypes = DEFAULT_SHIFT_TYPES, onClose, onSent }: { s: State; staffId: string; date: string; shift?: ShiftCode; unitId?: string; kind?: PlanReqKind; shiftTypes?: readonly ShiftTypeDef[]; onClose: () => void; onSent: (t: string) => void }) {
  const st = STAFF.find((x) => x.id === staffId)!;
  const [kind, setKind] = useState<PlanReqKind>(k0 ?? 'work');
  const [shift, setShift] = useState<ShiftCode>(sh0 ?? (shiftTypes[0]?.id as ShiftCode) ?? '日勤');
  const [unit, setUnit] = useState(u0 ?? st.homeUnit);
  const pc = paidCount(s, staffId);
  const text = kind === 'work' ? `${fmtMD(date)}の${shiftStyleOf(shift, shiftTypes).name}（${unitName(unit)}）に入ってもらえませんか？` : kind === 'paid' ? `${fmtMD(date)}に有給休暇を取ってもらえませんか？（今年度 ${pc}日／義務 ${PAID_TARGET}日）` : `${fmtMD(date)}の希望休を見直してもらえませんか？`;
  return <Modal title={`${st.name}さん　${fmtMD(date)}`} onClose={onClose} footer={<><button class="btn" onClick={onClose}>やめる</button><button class="btn pri" onClick={() => { sendPlanRequest(kind, staffId, date, kind === 'work' ? { shift, unitId: unit } : {}); onSent(`${st.name}さんに依頼を送りました。返事を待っています`); onClose(); }}>依頼を送る</button></>}>
    <div class="sec-title">依頼の種類</div>
    <div class="choice">{([['work', '出勤を依頼'], ['paid', '有休を打診'], ['dayoff', '希望休の修正を依頼']] as const).map(([k, l]) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}</div>
    {kind === 'work' && <><div class="sec-title">勤務帯</div><div class="choice">{shiftTypes.map((stOpt) => <button key={stOpt.id} aria-pressed={shift === stOpt.id} onClick={() => setShift(stOpt.id as ShiftCode)}>{stOpt.name}</button>)}</div>
      <div class="sec-title">ユニット</div><div class="choice">{UNITS.map((u) => <button key={u.id} aria-pressed={unit === u.id} onClick={() => setUnit(u.id)}>{u.name}</button>)}</div></>}
    <div class="sec-title">送る内容</div><p style="margin:0">{text}</p>
    <p class="small" style="margin-top:8px">本人に通知とチャットが届きます。返事は右のチャットの「依頼の状況」に出ます。承諾されると勤務表に反映されます。</p>
  </Modal>;
}
