import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SHIFTS, SHIFT_ORDER, SKILLS, STAFF, UNITS, unitName } from '../core/facility';
import type { SkillId } from '../core/types';
import { DOW_JA, dow, fmtMD } from '../core/dates';
import { holidayOf, eventsOn } from '../core/events';
import { PAID_TARGET, paidCount } from '../core/paidleave';
import { planEdit, planRestore, sendPlanRequest } from '../core/store';
import type { PlanCode, PlanEdit, PlanReqKind, PlanSnap, State } from '../core/store';
import type { Assignment, ShiftCode } from '../core/types';
import { Icon, Modal } from '../shared/ui';
import { SHORT } from './util';
import { impactOf } from './PlanChat';
import { EVENT_STYLE } from './Events';

type Plan = NonNullable<State['plan']>;
const CODES: { code: PlanCode; label: string; key: string }[] = [
  { code: '早番', label: '早', key: '1' }, { code: '日勤', label: '日', key: '2' }, { code: '遅番', label: '遅', key: '3' }, { code: '夜勤', label: '夜', key: '4' }, { code: 'paid', label: '有', key: '5' }, { code: 'off', label: '休', key: '0' },
];
const KEYMAP: Record<string, PlanCode> = { '1': '早番', '2': '日勤', '3': '遅番', '4': '夜勤', '5': 'paid', '0': 'off', '早': '早番', '日': '日勤', '遅': '遅番', '夜': '夜勤', '有': 'paid', '休': 'off', Delete: 'off', Backspace: 'off' };
const letter = (c: PlanCode) => (c === 'off' ? '休' : c === 'paid' ? '有' : SHIFTS[c].short);
const SK_ORDER: SkillId[] = ['medical', 'dementia', 'bath', 'swallow', 'terminal', 'driver'];


export function PlanGrid({ s, plan, month, days, ro, sums, onDay, onCell, onToast }: { s: State; plan: Plan; month: string; days: string[]; ro: boolean; sums: Map<string, { level: string; vacant: number; issues: unknown[] }>; onDay: (d: string) => void; onCell: (staffId: string, date: string) => void; onToast: (t: string) => void }) {
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

  const idx = useMemo(() => { const m = new Map<string, Assignment>(); for (const a of plan.draft) if (a.status !== 'absent') m.set(`${a.staffId}|${a.date}`, a); return m; }, [plan.draft]);
  const sub = s.collection.month === month ? s.collection.submitted : {};
  const dayOffOf = (id: string) => ((sub as Record<string, { dates: string[] } | null>)[id]?.dates ?? []);
  const groups = UNITS.filter((u) => unitF === 'all' || u.id === unitF).map((u) => ({ u, rows: STAFF.filter((x) => x.shifts.length && x.homeUnit === u.id && (skillF === 'all' || x.skills.includes(skillF))) })).filter((g) => g.rows.length);
  const staffRows = groups.flatMap((g) => g.rows);
  const rowOf = new Map(staffRows.map((x, i) => [x.id, i]));
  const codeAt = (id: string, d: string): PlanCode => (s.paidLeave?.[id]?.includes(d) ? 'paid' : idx.get(`${id}|${d}`)?.shift ?? 'off');
  const norm = (r: NonNullable<typeof sel>) => ({ r0: Math.min(r.r0, r.r1), r1: Math.max(r.r0, r.r1), c0: Math.min(r.c0, r.c1), c1: Math.max(r.c0, r.c1) });
  const nr = sel ? norm(sel) : null;
  const inSel = (r: number, c: number) => !!nr && r >= nr.r0 && r <= nr.r1 && c >= nr.c0 && c <= nr.c1;
  const snap = (): PlanSnap => ({ draft: plan.draft, paid: s.paidLeave ?? {} });

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
    setCheck(imp.length ? imp.slice(0, 6) : ['この変更で増える問題は見つかりません']);
  };
  const edit = (code: PlanCode) => {
    if (!nr) return;
    const edits: PlanEdit[] = [];
    for (let r = nr.r0; r <= nr.r1; r++) for (let c = nr.c0; c <= nr.c1; c++) { const st = staffRows[r]; const d = days[c]; if (!st || !d) continue;
      const cur = idx.get(`${st.id}|${d}`); edits.push({ staffId: st.id, date: d, code, unitId: unitSel !== 'home' ? unitSel : cur?.unitId ?? st.homeUnit }); }
    commit(edits, `${edits.length}マスを「${letter(code)}」に`);
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
    const code = KEYMAP[e.key]; if (code && !mod) { e.preventDefault(); edit(code); }
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

  return (
    <section class="card" id="plan-grid">
      <div class="row spread wrap" style="gap:8px"><h3 class="h3">勤務表（職員×日）</h3><span class="small">{ro ? '公開済み：変更は月間・日次から' : 'マスをクリック／ドラッグで選び、1〜5・0 か 早日遅夜有休 を押すと変わります'}</span></div>
      <div class="legend" style="margin-top:8px">{SHIFT_ORDER.map((k) => <span key={k} class="lgt"><span class={`t sh-${SHIFTS[k].short}`} style="width:22px;height:20px;display:inline-flex;align-items:center;justify-content:center;border-radius:5px">{SHIFTS[k].short}</span>{k}</span>)}
        <span class="lgt"><span class="t paid" style="padding:0 5px">有</span>有給休暇</span><span class="lgt"><span style="color:var(--ok);outline:1px dashed var(--ok);border-radius:5px;padding:0 5px">休</span>希望休</span>
        <span class="lgt"><span style="width:14px;height:6px;background:var(--bad);display:inline-block;border-radius:2px" />不足あり</span></div>

      <div class="row wrap" style="gap:6px;margin:8px 0" role="group" aria-label="ユニットで絞り込む">
        {[{ id: 'all', name: '全体' }, ...UNITS.map((u) => ({ id: u.id, name: `${u.floor}階 ${u.name}` }))].map((u) => <button key={u.id} class={`fchip${unitF === u.id ? ' on' : ''}`} aria-pressed={unitF === u.id} onClick={() => setUnitF(u.id)}>{u.name}</button>)}
        <span class="small" style="margin-left:8px">スキル：</span>
        {(['all', ...SK_ORDER] as const).map((k) => <button key={k} class={`fchip${skillF === k ? ' on' : ''}`} aria-pressed={skillF === k} onClick={() => setSkillF(k)}>{k === 'all' ? 'すべて' : SKILLS[k].label}</button>)}
      </div>

      {!ro && <div class="xl-bar" role="toolbar" aria-label="選択中のマスを変える">
        <span class="small">{nr ? `${(nr.r1 - nr.r0 + 1) * (nr.c1 - nr.c0 + 1)}マス選択中${target ? `（${target.st.name} ${fmtMD(target.d)}〜）` : ''}` : 'マスを選ぶと、ここから変えられます'}</span>
        {CODES.map((c) => <button key={c.code} class={`btn sm ${c.code === 'paid' ? 'tonal' : ''}`} disabled={!nr} title={`${c.key} キー`} onClick={() => edit(c.code)}>{c.label}</button>)}
        <select class="input" style="max-width:150px;min-height:32px;padding:2px 8px" value={unitSel} onChange={(e) => setUnitSel((e.target as HTMLSelectElement).value)} aria-label="勤務するユニット"><option value="home">ユニット：所属どおり</option>{UNITS.map((u) => <option key={u.id} value={u.id}>ユニット：{u.name}</option>)}</select>
        <span class="xl-sep" />
        <button class="btn sm" disabled={!undo.length} onClick={doUndo} title="Ctrl+Z"><Icon n="undo" sm /> 戻す</button>
        <button class="btn sm" disabled={!redo.length} onClick={doRedo} title="Ctrl+Y"><Icon n="redo" sm /> やり直す</button>
        <button class="btn sm" disabled={!nr} onClick={copy}>コピー</button><button class="btn sm" disabled={!nr || !clip.current} onClick={paste}>貼り付け</button>
        <button class="btn sm pri" disabled={!one} onClick={() => setReq(true)}><Icon n="send" sm /> 依頼を送る</button>
      </div>}
      {check.length > 0 && <div class="xl-check" role="status"><b style="font-weight:500">いまの変更の確認</b><ul>{check.map((x) => <li key={x} class={/増|不足|労務|連勤|間隔/.test(x) && !x.includes('見つかりません') ? 'ng' : 'ok'}>{x}</li>)}</ul></div>}

      <div class="pgrid-wrap xl" ref={wrap} tabIndex={0} onKeyDown={onKey} aria-label="勤務表。矢印キーで移動し、数字キーで勤務を変更できます">
        <table class={`pgrid${ro ? ' ro' : ''}`} style={`table-layout:fixed;width:${178 + 34 * days.length}px`}>
          <colgroup><col style="width:178px" />{days.map((d) => <col key={d} style="width:34px" />)}</colgroup>
          <thead>
            <tr class="pg-evrow"><th class="nm"><span class="small">行事</span></th>{days.map((d) => { const ev = evByDay(d); const e0 = ev[0]; const st = e0 ? EVENT_STYLE[e0.kind] : null;
              return <th key={d} class={e0 ? 'evcol' : ''} title={ev.map((e) => `${e.kind}：${e.title}`).join('／')}>{e0 && st ? <span class="evl" style={`background:${st.bg};color:${st.fg}`}>{e0.title.slice(0, 2)}</span> : null}</th>; })}</tr>
            <tr><th class="nm">職員</th>{days.map((d) => { const w = dow(d); const sm = sums.get(d); const hol = holidayOf(d); const ev = evByDay(d).length > 0;
              return <th key={d} class={`dh${w === 0 ? ' sun' : w === 6 ? ' sat' : ''}${hol ? ' hol hol-col' : ''}${ev ? ' evcol' : ''}${shortKind(sm) !== 'ok' ? ` col-${shortKind(sm)}` : ''}`} onClick={() => onDay(d)} title="クリックで、この日の1日表示"><span class="d">{+d.slice(8)}</span><span class="w">{DOW_JA[w]}</span></th>; })}</tr>
            <tr class="shrow"><th class="nm"><span class="small">不足（赤＝担当なし・スキル　橙＝人数）</span></th>{days.map((d) => { const k = shortKind(sums.get(d)); const sm = sums.get(d); const n = (sm?.vacant ?? 0) + (sm?.issues.length ?? 0); const sk = (sm?.issues as { kind: string }[] | undefined)?.filter((i) => i.kind === 'skill').length ?? 0;
              return <th key={d} class={`${evByDay(d).length ? 'evcol' : ''}${k !== 'ok' ? ` col-${k}` : ''}`}><button class={`shb ${k}`} onClick={() => onDay(d)} title={n ? `不足 ${n}件（担当なし ${sm?.vacant ?? 0}・スキル ${sk}・人数 ${n - (sm?.vacant ?? 0) - sk}）：クリックでこの日の1日表示` : '不足なし'} aria-label={`${fmtMD(d)} 不足 ${n}件`}>{n || ''}</button></th>; })}</tr>
          </thead>
          <tbody>{groups.map(({ u, rows }) => <>
            <tr key={u.id + 'h'} class="ugrp"><th colSpan={days.length + 1}><span>{u.floor}階 {u.name}</span></th></tr>
            {rows.map((st) => { rowNo++; const r = rowNo; const off = dayOffOf(st.id); const pc = paidCount(s, st.id); const lack = PAID_TARGET - pc;
              return <tr key={st.id}><td class="nm"><div class="nmc"><button class="link" style="font-size:13px" onClick={() => onCell(st.id, days[0])}>{st.name}</button>
                <span class="sk">{st.skills.filter((k) => k !== 'night').slice(0, 3).map((k) => <span key={k} class={`mini ${k === 'medical' ? 'bad' : ''}`} title={SKILLS[k].label}>{SHORT[k]}</span>)}</span>
                <span class={`pl${lack > 0 ? ' lack' : ''}`} title={`有給休暇 今年度 ${pc}日／義務 ${PAID_TARGET}日（デモ用の仮値）`}>有休 {pc}/{PAID_TARGET}</span></div></td>
                {days.map((d, c) => { const a = idx.get(`${st.id}|${d}`); const code = codeAt(st.id, d); const wantOff = off.includes(d); const ake = !a && code === 'off' && plan.draft.some((x) => x.staffId === st.id && x.shift === '夜勤' && x.date === dayAfter(d, -1));
                  const cur = inSel(r, c); const hand = nr && r === nr.r1 && c === nr.c1;
                  return <td key={d} data-rc={`${r}-${c}`} class={`c${holidayOf(d) ? ' hol-col' : ''}${evByDay(d).length ? ' evcol' : ''}${kindBy.get(d) !== 'ok' ? ` col-${kindBy.get(d)}` : ''}${cur ? ' selc' : ''}`} onMouseDown={(e) => start(r, c, e)} onMouseEnter={() => enter(r, c)} onDblClick={() => onCell(st.id, d)}>
                    {code === 'paid' ? <span class="t paid" title="有給休暇">有</span> : a ? <span class={`t sh-${SHIFTS[a.shift].short}${wantOff ? ' conf' : ''}`} title={`${a.shift}／${unitName(a.unitId)}${a.unitId !== st.homeUnit ? '（他ユニットへ応援）' : ''}${wantOff ? '（希望休の日）' : ''}`}>{SHIFTS[a.shift].short}{a.unitId !== st.homeUnit && <sup class="xu">{unitName(a.unitId).slice(0, 1)}</sup>}</span> : ake ? <span class="ake">明</span> : wantOff ? <span class="t hope">休</span> : <span class="off">・</span>}
                    {hand && !ro && <span class="fillh" onMouseDown={(e) => { e.stopPropagation(); drag.current = 'fill'; setFillTo({ r, c }); }} title="ドラッグで塗りつぶし" />}
                  </td>; })}</tr>; })}
          </>)}</tbody>
        </table>
      </div>
      <p class="small" style="margin-top:6px">右上の小さな文字は他ユニットへの応援です。ダブルクリック／Enter で、ユニットや確認つきの詳細を開きます。</p>
      {undo.length > 0 && <details class="more"><summary>直前の変更（{undo.length}件）</summary><ol class="xl-hist">{undo.slice().reverse().slice(0, 8).map((u, i) => <li key={i}><span>{u.label}</span>{i === 0 && <button class="linkbtn" onClick={doUndo}>元に戻す</button>}</li>)}</ol></details>}
      {req && one && <ReqModal s={s} staffId={one.st.id} date={one.d} onClose={() => setReq(false)} onSent={onToast} />}
    </section>
  );
}
/** その日の不足の種類：担当なし・スキル不足は赤（short）、時間帯の人数不足だけなら橙（warn） */
const shortKind = (sm?: { vacant: number; issues: unknown[] }): 'ok' | 'warn' | 'short' => { if (!sm) return 'ok'; const iss = sm.issues as { kind: string }[]; return sm.vacant > 0 || iss.some((i) => i.kind === 'skill') ? 'short' : iss.length ? 'warn' : 'ok'; };
const dayAfter = (d: string, n: number) => { const x = new Date(d + 'T00:00:00'); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };

export function ReqModal({ s, staffId, date, shift: sh0, unitId: u0, kind: k0, onClose, onSent }: { s: State; staffId: string; date: string; shift?: ShiftCode; unitId?: string; kind?: PlanReqKind; onClose: () => void; onSent: (t: string) => void }) {
  const st = STAFF.find((x) => x.id === staffId)!;
  const [kind, setKind] = useState<PlanReqKind>(k0 ?? 'work');
  const [shift, setShift] = useState<ShiftCode>(sh0 ?? '日勤');
  const [unit, setUnit] = useState(u0 ?? st.homeUnit);
  const pc = paidCount(s, staffId);
  const text = kind === 'work' ? `${fmtMD(date)}の${shift}（${unitName(unit)}）に入ってもらえませんか？` : kind === 'paid' ? `${fmtMD(date)}に有給休暇を取ってもらえませんか？（今年度 ${pc}日／義務 ${PAID_TARGET}日）` : `${fmtMD(date)}の希望休を見直してもらえませんか？`;
  return <Modal title={`${st.name}さん　${fmtMD(date)}`} onClose={onClose} footer={<><button class="btn" onClick={onClose}>やめる</button><button class="btn pri" onClick={() => { sendPlanRequest(kind, staffId, date, kind === 'work' ? { shift, unitId: unit } : {}); onSent(`${st.name}さんに依頼を送りました。返事を待っています`); onClose(); }}>依頼を送る</button></>}>
    <div class="sec-title">依頼の種類</div>
    <div class="choice">{([['work', '出勤を依頼'], ['paid', '有休を打診'], ['dayoff', '希望休の修正を依頼']] as const).map(([k, l]) => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>)}</div>
    {kind === 'work' && <><div class="sec-title">勤務帯</div><div class="choice">{SHIFT_ORDER.map((k) => <button key={k} aria-pressed={shift === k} onClick={() => setShift(k)}>{k}</button>)}</div>
      <div class="sec-title">ユニット</div><div class="choice">{UNITS.map((u) => <button key={u.id} aria-pressed={unit === u.id} onClick={() => setUnit(u.id)}>{u.name}</button>)}</div></>}
    <div class="sec-title">送る内容</div><p style="margin:0">{text}</p>
    <p class="small" style="margin-top:8px">本人に通知とチャットが届きます。返事は右のチャットの「依頼の状況」に出ます。承諾されると勤務表に反映されます。</p>
  </Modal>;
}
