import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon } from '../../shared/ui';
import { TASKS } from '../../core/facility';
import type { TaskKind } from '../../core/types';
import type { Ctx } from './AiHub';
import { WD, errText, get, post } from './api';
import type { DailyRes, SolveRes, VerifyRes } from './api';

const SH: Record<string, string> = { 早番: '早', 日勤: '日', 遅番: '遅', 夜勤: '夜' };
const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return h + m / 60; };
const STRENGTH: Record<string, string> = { 絶対: 'bad', 強く: 'warn', できれば: '' };

export function RosterView({ ctx }: { ctx: Ctx }) {
  const { fid, month, fac, roster, reload } = ctx;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [solve, setSolve] = useState<SolveRes | null>(null);
  const [verify, setVerify] = useState<VerifyRes | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [daily, setDaily] = useState<DailyRes | null>(null);
  const [dBusy, setDBusy] = useState(false);
  const [aiText, setAiText] = useState<{ text: string; route: string } | null>(null);

  const refreshVerify = () => get<VerifyRes>(`/api/v1/facilities/${fid}/rosters/${month}/verify`).then(setVerify).catch((e) => setErr(errText(e)));
  // 施設・月を替えたときだけ、結果の表示を初期化する。提案が替わった（＝今作った）ときは、作成結果のサマリーを残す
  useEffect(() => { setSolve(null); setVerify(null); setDay(null); setDaily(null); setAiText(null); setErr(''); }, [fid, month]);
  useEffect(() => { if (roster) { setAiText(null); void refreshVerify(); } }, [roster?.proposal_id, roster?.edits, fid, month]);

  const runSolve = async () => {
    setBusy(true); setErr(''); setSolve(null); setDay(null); setDaily(null); setAiText(null);
    try { const r = await post<SolveRes>(`/api/v1/facilities/${fid}/rosters/${month}/solve`, { time_limit: 15, daily: true }); setSolve(r); await reload(); }
    catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const openDay = async (d: number) => {
    setDay(d); setDaily(null); setDBusy(true); setErr('');
    try { setDaily(await get<DailyRes>(`/api/v1/facilities/${fid}/daily/${month}-${String(d).padStart(2, '0')}`)); } catch (e) { setErr(errText(e)); } finally { setDBusy(false); }
  };
  const explain = async () => {
    setAiText(null); setErr('');
    try { const r = await post<{ text: string; route: string }>(`/api/v1/facilities/${fid}/explain`, { kind: 'verify', month }); setAiText(r); } catch (e) { setErr(errText(e)); }
  };

  const days = roster?.days ?? 30;
  const staff = fac?.staff ?? [];
  const nightCount = (sid: string) => (roster?.current[sid] ?? []).filter((x) => x === '夜勤').length;
  const first = roster?.first_weekday ?? 0;
  const wd = (d: number) => (first + d - 1) % 7;
  const cover = useMemo(() => { // 日ごとの人数（要対応の日を見つけやすくする）
    const m: Record<number, Record<string, number>> = {};
    if (!roster) return m;
    for (const row of Object.values(roster.current)) row.forEach((x, i) => { if (x) { (m[i + 1] ??= {})[x] = (m[i + 1]?.[x] ?? 0) + 1; } });
    return m;
  }, [roster]);

  return (
    <div class="stack">
      <section class="card">
        <div class="row spread wrap">
          <div><b style="font-weight:500">月次の勤務表を、CP-SAT（制約最適化）で作る</b>
            <p class="sv-note">必須のルールは必ず守り、日課から導いた時間帯ごとの必要人数も満たす案を作ります。日次の時間割が解けない日があれば、月次に戻して作り直します。</p></div>
          <button class="btn pri" onClick={() => void runSolve()} disabled={busy || !roster}>{busy ? <><span class="sv-spin" /> 作成中…</> : <><Icon n="bolt" sm /> シフトを作る</>}</button>
        </div>
        {err && <div class="sv-err" role="alert">{err}</div>}
        {solve && <>
          <div class="sv-kpis">
            <div class="sv-kpi"><b>{solve.status === 'OPTIMAL' ? '最適' : solve.status}</b><span>求解の結果</span></div>
            <div class="sv-kpi"><b>{(solve.wall_ms / 1000).toFixed(1)}秒</b><span>かかった時間（月次＋日次30日）</span></div>
            <div class="sv-kpi"><b>{solve.iterations?.length ?? 1}回</b><span>月次↔日次の反復</span></div>
            <div class="sv-kpi"><b>{solve.unmet_total ?? 0}件</b><span>日次で割り当てられなかった業務</span></div>
          </div>
          {solve.explanation.map((l, i) => <p key={i} class="small">{l}</p>)}
          {!!solve.relaxation?.length && <p class="sv-err">今のルールのままでは作れません。次を緩める必要があります: {solve.relaxation.map((b) => `「${b.label}」${b.count}件`).join('、')}</p>}
        </>}
      </section>

      <section class="card">
        <div class="row spread wrap"><b style="font-weight:500">今の勤務表のルール違反</b>
          <div class="row"><span class={`chip ${verify ? (verify.ok ? 'ok' : 'warn') : ''}`}>{verify ? (verify.ok ? '違反なし' : `${verify.broken.length}種類のルールで違反`) : '確認中…'}</span>
            {verify && !verify.ok && <button class="btn sm" onClick={() => void explain()}><Icon n="auto_awesome" sm /> AIで説明</button>}</div></div>
        {verify && !verify.ok && <table class="sv-table" style="margin-top:8px"><thead><tr><th>ルール</th><th>強さ</th><th>件数</th></tr></thead>
          <tbody>{verify.broken.map((b) => <tr key={b.rule_id}><td>{b.label}</td><td><span class={`chip ${STRENGTH[b.strength ?? ''] ?? ''}`}>{b.strength}</span></td><td>{b.count}</td></tr>)}</tbody></table>}
        {verify && !verify.ok && <p class="sv-note" style="margin-top:6px">「シフトを作る」で作り直すと、優先度の高いルールから守る案になります。</p>}
        {aiText && <div class="sv-ok" style="margin-top:8px"><b>AIの説明</b>（{aiText.route === 'template' ? '定型の説明' : 'Gemini'}）<br />{aiText.text}</div>}
        {roster && roster.proposal_id && <p class="sv-note" style="margin-top:6px">提案ID: {roster.proposal_id}（提案は上書きされず、作るたびに新しく追記されます）</p>}
        {roster && !roster.proposal_id && <p class="sv-note" style="margin-top:6px">これは初期の提案（貪欲法で作った仮の表）です。「シフトを作る」でソルバーの案に置き換わります。</p>}
      </section>

      <section class="card">
        <div class="row spread wrap"><b style="font-weight:500">{Number(month.slice(5))}月の勤務表</b><span class="sv-note">日付をクリックすると、その日の時間帯別の業務割当が見られます</span></div>
        <div class="sv-legend"><span class="c-早">早 早番</span><span class="c-日">日 日勤</span><span class="c-遅">遅 遅番</span><span class="c-夜">夜 夜勤</span><span class="c-休">・ 休み</span></div>
        {!roster || !fac ? <p class="muted"><span class="sv-spin" /> 読み込み中…</p> :
          <div class="sv-grid-wrap"><table class="sv-grid"><thead><tr><th class="who">職員（夜勤回数）</th>
            {Array.from({ length: days }, (_, i) => i + 1).map((d) => <th key={d} class={`${day === d ? 'sel' : ''} ${wd(d) === 0 || wd(d) === 6 ? 'we' : ''}`} onClick={() => void openDay(d)} title={`${month}-${String(d).padStart(2, '0')}（${WD[wd(d)]}）`}>{d}<br /><span style="font-weight:400">{WD[wd(d)]}</span></th>)}</tr></thead>
            <tbody>{staff.map((s) => <tr key={s.staff_id}><td class="who" title={`${s.role}・${s.employment}`}>{s.name}<span class="sv-note"> {nightCount(s.staff_id) || ''}</span></td>
              {(roster.current[s.staff_id] ?? []).map((x, i) => <td key={i} class={x ? `c-${SH[x]}` : 'c-休'} onClick={() => void openDay(i + 1)}>{x ? SH[x] : '・'}</td>)}</tr>)}</tbody></table></div>}
        <p class="sv-note" style="margin-top:6px">{fac && `各勤務の基準人数（仮）: ${Object.entries(fac.need_per_shift).map(([k, v]) => `${k}${v}`).join('・')}`}{day && cover[day] ? `／${day}日の配置: ${Object.entries(cover[day]).map(([k, v]) => `${k}${v}`).join('・')}` : ''}</p>
      </section>

      {day && <section class="card">
        <div class="row spread wrap"><b style="font-weight:500">{Number(month.slice(5))}月{day}日（{WD[wd(day)]}）の時間割</b>{daily && <span class="sv-note">{(daily.wall_ms / 1000).toFixed(2)}秒・担当の入れ替わり{daily.switches}回</span>}</div>
        {dBusy && <p class="muted"><span class="sv-spin" /> 時間割を作っています…</p>}
        {daily && <Timeline d={daily} />}
      </section>}
    </div>
  );
}

function Timeline({ d }: { d: DailyRes }) {
  const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  const col = (t: string) => { const k = TASKS[t as TaskKind]; return k ? { bg: k.bg, fg: k.fg, label: k.label } : { bg: '#eee', fg: '#444', label: t }; };
  const pos = (h: number) => `${(h / 24) * 100}%`;
  const span = (s: string): [number, number] => (s === '早番' ? [7, 16] : s === '日勤' ? [9, 18] : s === '遅番' ? [12, 21] : [16.5, 24]);
  return (
    <div class="sv-tl">
      {d.unmet.length > 0 && <div class="sv-err">割り当てられなかった業務: {d.unmet.map((u) => `${u.label} ${col(u.task).label}（${u.cause}）`).join('、')}</div>}
      {d.unmet.length === 0 && <div class="sv-ok">この日の業務は、すべて割り当てられました。</div>}
      <div class="sv-tl-axis"><span /><div class="ticks">{ticks.map((h) => <i key={h} style={`left:${pos(h)}`}>{h}</i>)}</div></div>
      {d.staff.map((s) => { const [a, b] = s.carried_from_previous_night ? [0, 9.5] : span(s.shift); return (
        <div key={s.staff_id + s.shift + String(s.carried_from_previous_night)} class="sv-tl-row"><div class="nm" title={s.name}>{s.name}<span class="sv-note"> {s.carried_from_previous_night ? '夜勤明け' : s.shift}</span></div>
          <div class="sv-tl-track"><div class="sv-tl-shift" style={`left:${pos(a)};width:${((b - a) / 24) * 100}%`} />
            {s.items.map((it, i) => { const x = hm(it.start); const y = it.end === '24:00' ? 24 : hm(it.end); const c = col(it.task); return <div key={i} class="sv-tl-bar" title={`${it.start}-${it.end} ${c.label}`} style={`left:${pos(x)};width:${((y - x) / 24) * 100}%;background:${c.bg};color:${c.fg};${it.kind === 'break' ? 'border:1px dashed var(--line)' : ''}`}>{c.label}</div>; })}</div></div>); })}
      <p class="sv-note" style="margin-top:8px">薄い青の帯が勤務時間、色つきの帯が業務です。休憩は破線で表示します。</p>
    </div>
  );
}
