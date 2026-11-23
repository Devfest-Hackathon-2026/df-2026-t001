import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SHIFTS, TASKS, UNITS, floorOf, residentsOf, unitName } from '../core/facility';
import { addDays, fmtHM, fmtLong, fmtMin, stampDay, stampMin } from '../core/dates';
import { RANGE_END, RANGE_START, buildDay, coverage, issueTime } from '../core/roster';
import type { DayRow, TaskBlock } from '../core/types';
import type { State } from '../core/store';
import { Icon, Legend, Modal } from '../shared/ui';
import { eventsOn, holidayOf } from '../core/events';
import { EVENT_STYLE, effectText } from './Events';
import type { Go } from './util';
import { SkillMini, useWidth } from './util';

const PRESETS = { all: { label: '全日', a: 0, b: 2040 }, day: { label: '日中', a: 360, b: 1260 }, night: { label: '夜間', a: 990, b: 2040 } } as const;
const COLW: Record<number, number> = { 15: 24, 30: 36, 60: 56 };
const SCOPES = [{ v: 'all', l: '全体' }, { v: 'F1', l: '1階' }, { v: 'F2', l: '2階' }, ...UNITS.map((u) => ({ v: u.id, l: u.name }))];
const PEAKS: [number, number][] = [[465, 525], [705, 750], [1050, 1110]];
const isWork = (k: string) => k !== 'break' && k !== 'nap';
const SHIFT_KEYS = ['早番', '日勤', '遅番', '夜勤'];

export function Day({ s, date, go, openStaff, openResident }: { s: State; date: string; go: Go; openStaff: (id: string) => void; openResident: (id: string) => void }) {
  const [preset, setPreset] = useState<keyof typeof PRESETS>('all');
  const [scope, setScope] = useState('all');
  const width = useWidth(); const narrow = width < 700; const NAMEW = narrow ? 128 : 260;
  const inScope = (r: DayRow) => scope === 'all' || (scope[0] === 'F' ? floorOf(r.assignment.unitId) === +scope.slice(1) : r.assignment.unitId === scope);
  const [step, setStep] = useState(30);
  // アコーディオンの開閉（この画面を開いている間は覚えておく）
  const [closed, setClosed] = useState<Record<string, boolean>>(() => { try { return JSON.parse(sessionStorage.getItem('leader-day-closed') ?? '{"head":true}'); } catch { return { head: true }; } });
  const setClosedAll = (v: Record<string, boolean>) => { setClosed(v); try { sessionStorage.setItem('leader-day-closed', JSON.stringify(v)); } catch { /* 保存できなくても動く */ } };
  const toggle = (k: string) => setClosedAll({ ...closed, [k]: !closed[k] });
  const [sel, setSel] = useState<{ row: DayRow; b: TaskBlock } | null>(null);
  const { a: A, b: B } = PRESETS[preset];
  const colW = COLW[step]; const cols = Math.ceil((B - A) / step); const W = cols * colW;
  const px = (m: number) => ((m - A) / step) * colW;
  const gridRef = useRef<HTMLDivElement>(null);
  // 開いたとき／日付・範囲・刻みを変えたとき：朝7時（早番の始まり）が左端に来るようにする
  useEffect(() => {
    const el = gridRef.current; if (!el) return;
    const target = 420;
    el.scrollLeft = Math.max(0, ((target - A) / step) * colW);
  }, [date, preset, step]);
  const rows = useMemo(() => buildDay(s.assignments, date), [s.assignments, date]);
  const issues = useMemo(() => coverage(rows), [rows]);
  const vis = rows.filter(inScope).filter((r) => (r.assignment.status === 'absent' ? !r.tail && SHIFTS[r.assignment.shift].start < B && SHIFTS[r.assignment.shift].end > A : r.blocks.some((b) => b.end > A && b.start < B)));
  const groups: { key: string; title: string; rows: DayRow[] }[] = [];
  for (const r of vis) { const key = r.tail ? 'tail' : r.assignment.shift; let g = groups.find((x) => x.key === key); if (!g) { g = { key, title: r.tail ? '前夜の夜勤（夜勤明けまで）' : `${r.assignment.shift}　${SHIFTS[r.assignment.shift].label}`, rows: [] }; groups.push(g); } g.rows.push(r); }
  const sample = (r: DayRow, t0: number, t1: number) => { let best = 99; for (let t = t0; t < t1; t += 15) { const b = r.blocks.find((x) => t >= x.start && t < x.end); best = Math.min(best, b && isWork(b.kind) ? 1 : 0); } return best === 99 ? 0 : best; };
  const active = rows.filter((r) => r.assignment.status !== 'absent');
  const countAt = (scope: (r: DayRow) => boolean, t0: number, t1: number) => { let m = 99; for (let t = t0; t < Math.min(t1, t0 + step); t += 15) { let c = 0; for (const r of active) if (scope(r)) { const b = r.blocks.find((x) => t >= x.start && t < x.end); if (b && isWork(b.kind)) c++; } m = Math.min(m, c); } return m === 99 ? 0 : m; };
  void sample;
  const hours: number[] = []; for (let t = Math.ceil(A / 60) * 60; t < B; t += 60) hours.push(t);
  const vacs = s.vacancies.filter((v) => v.date === date && v.state !== 'filled');
  const dayEvents = eventsOn(s.events, date);
  const trackStyle = `width:${W}px;--hw:${(60 / step) * colW}px;--h0:${px(Math.ceil(A / 60) * 60)}px`;
  const breakers = rows.filter((r) => r.blocks.some((b) => b.kind === 'break' || b.kind === 'nap'));
  // 不足の時間帯（スキル不足・人数不足）。表示中の範囲（フロア・ユニット）に関係するものだけ、レーンに並べる
  const issueFloor = (sc: string) => (/^\d階$/.test(sc) ? +sc[0] : floorOf(UNITS.find((u) => u.name === sc)?.id ?? ''));
  const scRaw = issues.filter((i) => i.t1 > A && i.t0 < B && (scope === 'all' || (scope[0] === 'F' ? issueFloor(i.scope) === +scope.slice(1) : i.scope === unitName(scope) || i.scope === `${floorOf(scope)}階`)));
  // 同じ時間帯・同じ種類の不足（例：4ユニットとも 07:45〜08:45 に1名不足）は1本にまとめる
  type Iss = (typeof issues)[number] & { scopes: string[] };
  const scIssues: Iss[] = []; for (const i of scRaw) { const g = scIssues.find((x) => x.kind === i.kind && x.t0 === i.t0 && x.t1 === i.t1 && x.need === i.need && x.have === i.have); if (g) g.scopes.push(i.scope); else scIssues.push({ ...i, scopes: [i.scope] }); }
  const lanes: number[] = []; const placed = scIssues.map((i) => { let k = lanes.findIndex((end) => end <= i.t0); if (k < 0) { k = lanes.length; lanes.push(0); } lanes[k] = i.t1; return { i, lane: k }; });
  const nSkill = scRaw.filter((i) => i.kind === 'skill').length; const nHead = scRaw.length - nSkill;
  // 足りない時間を時間帯ごとに1行にまとめる（ユニットの内訳は押したときだけ）
  const norm = (t: number) => (t < 420 ? t + 1440 : t);
  const BANDS = [{ k: 'am', l: '朝', a: 420, b: 750 }, { k: 'pm', l: '昼', a: 750, b: 1050 }, { k: 'ev', l: '夕', a: 1050, b: 1260 }, { k: 'nt', l: '夜間', a: 1260, b: 1860 }];
  const bands = BANDS.map((bd) => { const its = scRaw.filter((i) => norm(i.t0) >= bd.a && norm(i.t0) < bd.b); return { ...bd, its, skill: its.filter((i) => i.kind === 'skill').length, units: Array.from(new Set(its.map((i) => i.scope))) }; }).filter((b) => b.its.length);
  const [openBand, setOpenBand] = useState<string | null>(null);
  // 帯は重なりをまとめて1本に（スキル不足を含む区間は赤、人数だけなら落ち着いた色）
  const merged: { t0: number; t1: number; skill: boolean }[] = [];
  for (const i of [...scIssues].sort((x, y) => x.t0 - y.t0)) { const last = merged[merged.length - 1]; if (last && i.t0 <= last.t1) { last.t1 = Math.max(last.t1, i.t1); last.skill = last.skill || i.kind === 'skill'; } else merged.push({ t0: i.t0, t1: i.t1, skill: i.kind === 'skill' }); }
  const jump = (t: number) => { const el = gridRef.current; if (el) el.scrollTo({ left: Math.max(0, px(t) - 60), behavior: 'smooth' }); };
  const shortLabel = (i: Iss) => (i.kind === 'skill' ? `${i.scopes.join('・')} 医療的ケア` : `${i.scopes.join('・')} ${i.have}/${i.need}名`);
  return (
    <div class="day">
      <div class="row wrap tb" style="justify-content:space-between">
        <div class="row">
          <button class="iconbtn" disabled={date <= RANGE_START} onClick={() => go('day', { date: addDays(date, -1) })} aria-label="前の日"><Icon n="chevron_left" /></button>
          <h2 class="mtitle" style="min-width:0">{fmtLong(date)}</h2>
          <button class="iconbtn" disabled={date >= RANGE_END} onClick={() => go('day', { date: addDays(date, 1) })} aria-label="次の日"><Icon n="chevron_right" /></button>
          {date !== s.today && <button class="btn sm" onClick={() => go('day', { date: s.today })}>今日</button>}
        </div>
        <div class="row wrap" style="gap:8px">
          <select class="input scope" value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value)} aria-label="表示する範囲（フロア・ユニット）">{SCOPES.map((x) => <option key={x.v} value={x.v}>{x.v === 'all' || x.v[0] === 'F' ? x.l : `ユニット：${x.l}`}</option>)}</select>
          <div class="seg" aria-label="表示範囲">{(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => <button key={k} aria-pressed={preset === k} onClick={() => setPreset(k)}>{PRESETS[k].label}</button>)}</div>
          <details class="more-menu">
            <summary class="btn sm">表示 <Icon n="expand_more" sm /></summary>
            <div class="more-pop" style="right:0;left:auto">
              <span class="small">時間の刻み</span>
              <div class="seg" aria-label="表示刻み">{[15, 30, 60].map((n) => <button key={n} aria-pressed={step === n} onClick={() => setStep(n)}>{n}分</button>)}</div>
              <button class="btn sm" onClick={() => setClosedAll({})}>すべて開く</button>
              <button class="btn sm" onClick={() => setClosedAll(Object.fromEntries(['head', 'tail', ...SHIFT_KEYS].map((k) => [k, true])))}>すべて閉じる</button>
            </div>
          </details>
        </div>
      </div>
      {(holidayOf(date) || dayEvents.length > 0) && <div class="day-banner">
        {holidayOf(date) && <span class="chip bad">{holidayOf(date)}</span>}
        {dayEvents.map((e) => <span key={e.id} class="evc big" style={`background:${EVENT_STYLE[e.kind].bg};color:${EVENT_STYLE[e.kind].fg}`}>{e.title}{effectText(e) ? `（${effectText(e)}）` : ''}</span>)}
      </div>}
      <div class={`short-sum ${scIssues.length ? (nSkill ? 'bad' : 'calm') : 'ok'}`} role="status">
        <Icon n={scIssues.length ? 'warning' : 'check_circle'} sm />
        {scIssues.length ? <><b>足りない時間</b>
          <span class="band-list">{bands.map((bd) => <button key={bd.k} class={`band${bd.skill ? ' skill' : ''}${openBand === bd.k ? ' on' : ''}`} aria-expanded={openBand === bd.k} onClick={() => { setOpenBand(openBand === bd.k ? null : bd.k); jump(bd.a >= 1440 ? bd.a - 1440 : bd.a); }}>{bd.l} {fmtHM(bd.a % 1440)}〜{fmtHM(bd.b % 1440)}<span class="small">{bd.units.length}ユニット{bd.skill ? '・スキル不足あり' : ''}</span></button>)}</span>
          {openBand && <ul class="band-detail">{bands.find((b) => b.k === openBand)?.its.map((i, k) => <li key={k}><span class={i.kind === 'skill' ? 'sk' : ''}>{i.kind === 'skill' ? 'スキル' : '人数'}</span> {issueTime(i)} {i.scope}（必要{i.need}／いま{i.have}）</li>)}</ul>}</>
          : <span>この範囲では、人数・スキルの不足はありません</span>}
      </div>
      <div class="grid-wrap scroll" ref={gridRef}>
        <div style={`min-width:${NAMEW + W}px;position:relative`}>
          <div class="g-head"><div class="g-name head" style={`width:${NAMEW}px`}>職員／担当</div>
            <div class="track head" style={trackStyle}>{hours.map((t) => <span key={t} class="hl" style={`left:${px(t)}px`}>{t >= 1440 ? '翌' : ''}{fmtHM(t)}</span>)}
              {merged.map((m, k) => <span key={k} class={`hd-short ${m.skill ? 'bad' : 'calm'}`} style={`left:${px(Math.max(m.t0, A))}px;width:${px(Math.min(m.t1, B)) - px(Math.max(m.t0, A))}px`} />)}</div></div>
          {merged.length > 0 && <div class="g-row short-row" style="height:30px">
            <div class="g-name" style={`width:${NAMEW}px`}><span class="small" style="font-weight:500">足りない時間</span></div>
            <div class="track" style={trackStyle}>{merged.map((m, k) => { const l = px(Math.max(m.t0, A)); const w = px(Math.min(m.t1, B)) - l; return <button key={k} class={`sbar ${m.skill ? 'bad' : 'calm'}`} style={`left:${l}px;width:${Math.max(6, w - 2)}px;top:5px`} title={`${fmtHM(m.t0)}〜${fmtHM(m.t1)} ${m.skill ? 'スキル不足あり' : '人数不足'}`} onClick={() => jump(m.t0)} />; })}</div>
          </div>}
          {merged.map((m, k) => { const l = px(Math.max(m.t0, A)); const w = px(Math.min(m.t1, B)) - l; return <span key={'v' + k} class={`vshort ${m.skill ? 'bad' : 'calm'}`} aria-hidden="true" style={`left:${NAMEW + l}px;width:${w}px`} />; })}

          <button class="g-grp acc" aria-expanded={!closed.head} onClick={() => toggle('head')}><span class="acc-in"><Icon n={closed.head ? 'chevron_right' : 'expand_more'} sm /> ユニットごとの人数</span></button>
          {!closed.head && [...UNITS.filter((u) => scope === 'all' || (scope[0] === 'F' ? u.floor === +scope.slice(1) : u.id === scope)).map((u) => ({ id: u.id, name: `${u.name}（${u.floor}階）`, day: true as const, fn: (r: DayRow) => r.assignment.unitId === u.id })), ...[1, 2].filter((f) => scope === 'all' || (scope[0] === 'F' ? f === +scope.slice(1) : f === floorOf(scope))).map((f) => ({ id: `F${f}`, name: `${f}階 夜間`, day: false as const, fn: (r: DayRow) => floorOf(r.assignment.unitId) === f }))].map((u) => (
            <div class="g-row strip" key={u.id}><div class="g-name" style={`width:${NAMEW}px`}><span class="small" style="color:var(--tx)">{u.name}</span></div>
              <div class="track" style={`width:${W}px`}>
                {Array.from({ length: cols }, (_, i) => { const t0 = A + i * step; const inDay = t0 >= 420 && t0 < 1260; const inNight = t0 >= 1260 || t0 < 420; if (u.day ? !inDay : !inNight || t0 >= 1440) return null;
                  const have = countAt(u.fn, t0, t0 + step); const need = u.day ? (PEAKS.some(([a, b]) => t0 >= a && t0 < b) ? 2 : 1) : 1; const bad = have < need;
                  return <span key={i} class={`sc ${bad ? 'bad' : 'ok'}`} style={`left:${i * colW}px;width:${colW - 1}px`} title={`${fmtHM(t0)} 必要${need}／現在${have}`}>{have}</span>; })}
              </div></div>))}
          {groups.map((g) => (
            <div key={g.key}>
              <button class="g-grp acc" aria-expanded={!closed[g.key]} onClick={() => toggle(g.key)}><span class="acc-in"><Icon n={closed[g.key] ? 'chevron_right' : 'expand_more'} sm /> {g.title}<span class="small" style="margin-left:8px">{g.rows.length}名</span></span></button>
              {!closed[g.key] && g.rows.map((r) => { const ab = r.assignment.status === 'absent'; return (
                <div class={`g-row${ab ? ' absent' : ''}`} key={r.assignment.id + (r.tail ? 't' : '')}>
                  <div class="g-name" style={`width:${NAMEW}px`}>
                    <div class="row" style="gap:6px"><button class="link" onClick={() => openStaff(r.staff.id)}>{r.staff.name}</button>
                      {ab && <span class="chip bad">欠勤</span>}{r.assignment.status === 'late' && <span class="chip warn">遅刻</span>}{r.assignment.status === 'early' && <span class="chip warn">早退</span>}{r.tail && <span class="chip">夜勤明け</span>}</div>
                    <div class="row" style="gap:4px"><span class="small">{unitName(r.assignment.unitId)}</span>{!narrow && <SkillMini s={r.staff} max={3} />}</div>
                  </div>
                  <div class="track" style={trackStyle}>
                    {r.blocks.filter((b) => b.end > A && b.start < B).map((b, i) => { const t = TASKS[b.kind]; const l = px(Math.max(b.start, A)); const w = px(Math.min(b.end, B)) - l;
                      return <button key={i} class={`blk${b.kind === 'break' || b.kind === 'nap' ? ' brk' : ''}`} style={`left:${l}px;width:${Math.max(4, w - 2)}px;background:${t.bg};color:${t.fg}`} title={`${b.label} ${fmtMin(b.start)}〜${fmtMin(b.end)}`} onClick={() => setSel({ row: r, b })}>{b.label}</button>; })}
                    {ab && <span class="absent-note">欠勤のため配置なし</span>}
                  </div>
                </div>); })}
            </div>
          ))}
          {vis.length === 0 && <div class="empty">この時間帯に勤務する職員がいません。表示範囲を変えてください。</div>}
        </div>
      </div>
      <div class="split2">
        <details class="card">
          <summary class="h3" style="cursor:pointer">人数とスキルのチェック <span class="small">（{issues.length ? `${issues.length}件` : '問題なし'}）</span></summary>
          {issues.length === 0 && <p class="muted" style="margin-top:8px">必要人数・休憩・医療的ケアの検証で問題ありません。</p>}
          <ul class="issues" style="margin-top:8px">{issues.map((i, k) => <li key={k}><span class={`chip ${i.kind === 'skill' ? 'bad' : ''}`}>{i.kind === 'skill' ? 'スキル不足' : '人数不足'}</span> <b style="font-weight:500">{issueTime(i)}</b> {i.text}（必要{i.need}／現在{i.have}）</li>)}</ul>
          {issues.length > 0 && <div class="fix"><span class="small">修正案：</span>{vacs.length ? vacs.map((v) => <button key={v.id} class="btn sm tonal" onClick={() => go('vac', { vacId: v.id })}>{v.id} の候補を見る</button>) : <span class="muted">休憩時刻の入れ替えや他ユニットからのフォローを検討してください。</span>}</div>}
          {vacs.length > 0 && issues.length === 0 && <div class="fix"><span class="small">この日の欠員：</span>{vacs.map((v) => <button key={v.id} class="btn sm tonal" onClick={() => go('vac', { vacId: v.id })}>{v.id}</button>)}</div>}
        </details>
        <section class="card">
          <h3>休憩・仮眠の交代</h3>
          <p class="small" style="margin:4px 0 8px">全員が同時に休まないよう、ユニットごとに時間をずらしています。</p>
          <div class="stack" style="gap:4px;max-height:180px;overflow:auto">{breakers.filter((r) => !r.tail && r.assignment.status !== 'absent').map((r) => { const b = r.blocks.find((x) => x.kind === 'break' || x.kind === 'nap')!; return <div key={r.assignment.id} class="row spread small" style="color:var(--tx)"><span>{r.staff.name}（{unitName(r.assignment.unitId)}）</span><span>{b.kind === 'nap' ? '仮眠' : '休憩'} {fmtMin(b.start)}〜{fmtMin(b.end)}</span></div>; })}</div>
        </section>
      </div>
      <div class="card" style="margin-top:12px"><div class="sec-title" style="margin:0 0 8px">業務の凡例</div><Legend /></div>
      {sel && <Modal title={sel.b.label} onClose={() => setSel(null)}>
        <dl class="kv"><dt>担当</dt><dd><button class="link" onClick={() => { const id = sel.row.staff.id; setSel(null); openStaff(id); }}>{sel.row.staff.name}</button>（{sel.row.assignment.shift}）</dd>
          <dt>時間</dt><dd>{fmtMin(sel.b.start)}〜{fmtMin(sel.b.end)}</dd><dt>ユニット</dt><dd>{unitName(sel.row.assignment.unitId)}（{floorOf(sel.row.assignment.unitId)}階）</dd>
          <dt>業務種別</dt><dd><span class="chip" style={`background:${TASKS[sel.b.kind].bg};color:${TASKS[sel.b.kind].fg}`}>{TASKS[sel.b.kind].label}</span></dd></dl>
        {(sel.b.kind === 'break' || sel.b.kind === 'nap') && <p class="muted" style="margin-top:12px">休憩中も同じユニットの他の職員で必要人数を保つように調整しています。</p>}
        <div class="sec-title">{unitName(sel.row.assignment.unitId)}の入居者（タップで詳細）</div>
        <div class="stack" style="gap:6px">{residentsOf(sel.row.assignment.unitId).map((r) => <button key={r.id} class="listbtn" onClick={() => { setSel(null); openResident(r.id); }}><span>{r.room} {r.name}さん <span class="small">要介護{r.careLevel}</span></span><span class="row" style="gap:4px">{r.medical.length > 0 && <span class="mini bad">医療的ケア</span>}{r.fallRisk === 'high' && <span class="mini warn">転倒注意</span>}</span></button>)}</div>
      </Modal>}
    </div>
  );
}
