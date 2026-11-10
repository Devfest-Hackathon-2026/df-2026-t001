// 分析タブ。BigQuery の分析ビュー（care_ml / care_analytics）を care-solver-api 経由で読み、グラフと数字で見せる。
// グラフは外部ライブラリを使わず SVG で描く（CSP の script-src 'self' のまま）。API が無効（404）なら「準備中」と出す。
import { useEffect, useState } from 'preact/hooks';
import type { Ctx } from './AiHub';
import { ApiError, FACILITIES, errText, get } from './api';
import './insights.css';

type Row = Record<string, string | number | boolean | null>;
interface Section { title: string; ok: boolean; cached: boolean; rows: Row[] }
export interface InsightsRes {
  facility_id: string; available: boolean; generated_at: string; note: string;
  kpis: {
    vacancies: number | null; fill_rate: number | null; avg_minutes_to_fill: number | null;
    peak_slot: { weekday: string; shift: string; vacancies: number } | null;
    accept_rate: number | null; offers: number | null; model_auc: number | null; model_promoted: boolean | null;
    forecast_next4w: number | null; solver_avg_ms: number | null; ai_calls_30d: number | null; ai_tokens_30d: number | null;
  };
  sections: Record<string, Section>;
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const pct = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100)}%`);
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const mins = (v: number | null) => (v === null ? '-' : v >= 90 ? `${(v / 60).toFixed(1)}時間` : `${Math.round(v)}分`);
const WDS = ['日', '月', '火', '水', '木', '金', '土'];
const SHIFTS = ['早番', '日勤', '遅番', '夜勤'];
const FEATURE: Record<string, string> = {
  chat: 'チャット', explain: '候補の説明', translate: 'ルールの翻訳', candidate_reasons: '候補の理由', employee_compose: '職員向け文面',
  plan_intent: 'シフト作成の指示', leader_intent: 'リーダーの指示', employee_intent: '職員の申し出',
};
const LINE_COLORS = ['var(--pri)', '#e37400', '#188038', '#a142f4'];

/** 週ごとの欠員数：実績（灰）と予測（青、縦線は 80% 予測区間）。 */
function ForecastChart({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p class="muted small">データがありません</p>;
  const W = 640, H = 200, L = 30, B = 24, T = 8;
  const max = Math.max(1, ...rows.map((r) => n(r.upper_80 ?? r.vacancies)));
  const step = (W - L - 8) / rows.length, bw = Math.max(4, step * 0.6);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), Math.ceil(max)];
  return (
    <svg class="in-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="週ごとの欠員数の実績と予測">
      {ticks.map((t) => <g key={t}><line class="grid" x1={L} x2={W - 4} y1={y(t)} y2={y(t)} /><text x={L - 6} y={y(t) + 4} text-anchor="end">{t}</text></g>)}
      {rows.map((r, i) => {
        const x = L + i * step + (step - bw) / 2, v = n(r.vacancies), fc = r.series === '予測';
        return (
          <g key={`${r.week_start}${r.series}`}>
            <rect class={fc ? 'fc' : 'act'} x={x} y={y(v)} width={bw} height={Math.max(0, y(0) - y(v))} rx={2}><title>{`${r.week_start} の週 ${r.series} ${v.toFixed(1)}件${fc ? `（80%区間 ${n(r.lower_80).toFixed(1)}〜${n(r.upper_80).toFixed(1)}）` : ''}`}</title></rect>
            {fc && <line class="band" x1={x + bw / 2} x2={x + bw / 2} y1={y(n(r.lower_80))} y2={y(n(r.upper_80))} />}
            {i % 2 === 0 && <text x={x + bw / 2} y={H - 6} text-anchor="middle">{md(String(r.week_start))}</text>}
          </g>
        );
      })}
      <line class="axis" x1={L} x2={W - 4} y1={y(0)} y2={y(0)} />
    </svg>
  );
}

/** 曜日 × 勤務帯の欠員数（濃いほど多い）と、充足までの平均時間。 */
function Heatmap({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p class="muted small">データがありません</p>;
  const get1 = (wd: number, s: string) => rows.find((r) => n(r.weekday_num) === wd && r.shift === s);
  const max = Math.max(1, ...rows.map((r) => n(r.vacancies)));
  return (
    <div class="in-heat" role="table" aria-label="曜日と勤務帯ごとの欠員数">
      <span />{WDS.map((w) => <span key={w} class="h">{w}</span>)}
      {SHIFTS.map((s) => [<span key={s} class="r">{s}</span>, ...WDS.map((w, i) => {
        const r = get1(i + 1, s), v = r ? n(r.vacancies) : 0, a = Math.round((v / max) * 85);
        return (
          <div key={`${s}${w}`} class="c" style={{ background: `color-mix(in srgb, var(--pri) ${a}%, var(--bg3))`, color: a > 50 ? '#fff' : undefined }}
            title={r ? `${w}曜 ${s}: 欠員${v}件・充足まで平均${mins(r.avg_minutes_to_fill as number | null)}` : `${w}曜 ${s}: 欠員なし`}>
            <b>{v}</b><span>{r ? mins(r.avg_minutes_to_fill as number | null) : ''}</span>
          </div>
        );
      })])}
    </div>
  );
}

/** 月ごとの応諾率（全体と雇用形態別）の折れ線。 */
function AcceptChart({ rows }: { rows: Row[] }) {
  const months = [...new Set(rows.map((r) => String(r.month)))].sort();
  if (months.length < 2) return <p class="muted small">データがありません</p>;
  const groups = ['全体', ...[...new Set(rows.map((r) => String(r.employment)))].sort()];
  const rate = (m: string, g: string) => {
    const rs = rows.filter((r) => r.month === m && (g === '全体' || r.employment === g));
    const o = rs.reduce((s, r) => s + n(r.offers), 0);
    return o ? rs.reduce((s, r) => s + n(r.accepted), 0) / o : null;
  };
  const W = 400, H = 200, L = 34, B = 22, T = 8;
  const x = (i: number) => L + (W - L - 12) * (i / (months.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v);
  return (
    <>
      <svg class="in-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="月ごとの応諾率">
        {[0, 0.5, 1].map((t) => <g key={t}><line class="grid" x1={L} x2={W - 4} y1={y(t)} y2={y(t)} /><text x={L - 6} y={y(t) + 4} text-anchor="end">{t * 100}%</text></g>)}
        {months.map((m, i) => (months.length <= 6 || i % 2 === 0) && <text key={m} x={x(i)} y={H - 6} text-anchor="middle">{Number(m.slice(5))}月</text>)}
        {groups.slice(0, LINE_COLORS.length).map((g, gi) => {
          const pts = months.map((m, i) => [i, rate(m, g)] as const).filter(([, v]) => v !== null) as [number, number][];
          return (
            <g key={g}>
              <polyline fill="none" stroke={LINE_COLORS[gi]} stroke-width={gi === 0 ? 2.5 : 1.5} stroke-dasharray={gi === 0 ? undefined : '4 3'} points={pts.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')} />
              {pts.map(([i, v]) => <circle key={i} cx={x(i)} cy={y(v)} r={gi === 0 ? 3 : 2} fill={LINE_COLORS[gi]}><title>{`${months[i]} ${g} ${Math.round(v * 100)}%`}</title></circle>)}
            </g>
          );
        })}
      </svg>
      <div class="in-legend">{groups.slice(0, LINE_COLORS.length).map((g, gi) => <span key={g}><i style={{ background: LINE_COLORS[gi] }} />{g}</span>)}</div>
    </>
  );
}

function SoonCard({ msg }: { msg: string }) {
  return <section class="card in-soon"><b style="font-weight:500">分析は準備中です</b><p class="small" style="margin-top:6px">{msg}</p></section>;
}

export function InsightsView({ ctx }: { ctx: Ctx }) {
  const [data, setData] = useState<InsightsRes | null>(null);
  const [err, setErr] = useState('');
  const [off, setOff] = useState(false);
  useEffect(() => {
    setData(null); setErr(''); setOff(false);
    let live = true;
    get<InsightsRes>(`/api/v1/facilities/${ctx.fid}/insights`)
      .then((d) => { if (live) setData(d); })
      .catch((e) => { if (!live) return; if (e instanceof ApiError && e.status === 404) setOff(true); else setErr(errText(e)); });
    return () => { live = false; };
  }, [ctx.fid]);

  if (off) return <SoonCard msg="この環境では分析（BigQuery）が有効になっていません。" />;
  if (err) return <div class="sv-err" role="alert">{err}</div>;
  if (!data) return <p class="muted"><span class="sv-spin" /> BigQuery から集計しています…</p>;
  if (!data.available) return <SoonCard msg={data.note} />;

  const k = data.kpis, S = data.sections, fac = FACILITIES.find((f) => f.id === ctx.fid);
  const fm = S.forecast_model?.rows[0];
  const flat = fm && n(fm.non_seasonal_p) + n(fm.non_seasonal_d) + n(fm.non_seasonal_q) === 0 && !fm.has_drift;
  const monthly = S.vacancy_monthly?.rows ?? [];
  const runs = S.model_runs?.rows ?? [];
  const ai = S.ai_usage?.rows ?? [];
  const aiMax = Math.max(1, ...ai.map((r) => n(r.total_tokens)));
  const solver = S.solver_runs?.rows ?? [];
  const broken = Object.values(S).filter((s) => !s.ok).map((s) => s.title);

  return (
    <div class="stack">
      <section class="card">
        <div class="row spread"><b style="font-weight:500">{fac?.name ?? ctx.fid} の分析（BigQuery）</b><span class="sv-note">集計 {new Date(data.generated_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
        <div class="sv-kpis">
          <div class="sv-kpi"><b>{k.vacancies ?? '-'}件</b><span>これまでの欠員</span></div>
          <div class="sv-kpi"><b>{mins(k.avg_minutes_to_fill)}</b><span>充足までの平均</span></div>
          <div class="sv-kpi"><b>{k.peak_slot ? `${k.peak_slot.weekday}曜・${k.peak_slot.shift}` : '-'}</b><span>欠員が最も多い枠</span></div>
          <div class="sv-kpi"><b>{pct(k.accept_rate)}</b><span>打診の応諾率（{k.offers ?? 0}件）</span></div>
          <div class="sv-kpi"><b>{k.forecast_next4w ?? '-'}件</b><span>今後4週の欠員の予測</span></div>
          <div class="sv-kpi"><b>{k.model_auc?.toFixed(2) ?? '-'}</b><span>応諾予測の AUC（最新）</span></div>
        </div>
        <p class="sv-note">{data.note}</p>
        {broken.length > 0 && <p class="sv-note">一部を読み込めませんでした: {broken.join('、')}</p>}
      </section>

      <section class="card">
        <b style="font-weight:500">欠員数の予測（週ごと・BigQuery ML ARIMA_PLUS）</b>
        <ForecastChart rows={S.forecast?.rows ?? []} />
        <div class="in-legend"><span><i style={{ background: 'var(--tx3)' }} />実績（直近12週）</span><span><i style={{ background: 'var(--pri)' }} />予測（縦線は80%予測区間）</span></div>
        {fm && <p class="small" style="margin-top:6px">{flat
          ? '過去の欠員に周期（季節性）や増減の傾向が見られなかったため、モデルは平均的な水準で予測しています。区間の幅が、週ごとのばらつきの目安です。'
          : `モデル: ARIMA(${fm.non_seasonal_p},${fm.non_seasonal_d},${fm.non_seasonal_q})${fm.has_drift ? '・傾向あり' : ''}・周期 ${fm.seasonal_periods}`}</p>}
        <p class="sv-note">毎週月曜に BigQuery のスケジュールドクエリで学習し直します。</p>
      </section>

      <div class="sv-two">
        <section class="card">
          <b style="font-weight:500">曜日 × 勤務帯ごとの欠員</b>
          <p class="sv-note">数字は欠員の件数、下は充足までの平均時間。濃いほど多い枠です。</p>
          <Heatmap rows={S.vacancy_slots?.rows ?? []} />
        </section>
        <section class="card">
          <b style="font-weight:500">打診の応諾率の推移</b>
          <p class="sv-note">月ごと。実線が全体、点線が雇用形態別です。</p>
          <AcceptChart rows={S.acceptance?.rows ?? []} />
        </section>
      </div>

      <div class="sv-two">
        <section class="card">
          <b style="font-weight:500">月ごとの欠員と埋まり方</b>
          <div class="in-scroll"><table class="sv-table"><thead><tr><th>月</th><th>欠員</th><th>打診</th><th>応募</th><th>調整</th><th>充足まで</th></tr></thead>
            <tbody>{monthly.slice(-6).map((r) => <tr key={String(r.month)}><td>{Number(String(r.month).slice(5))}月</td><td>{r.vacancies}</td><td>{r.filled_by_offer}</td><td>{r.filled_by_applicant}</td><td>{r.adjusted_by_leader}</td><td>{mins(r.avg_minutes_to_fill as number | null)}</td></tr>)}</tbody></table></div>
        </section>
        <section class="card">
          <b style="font-weight:500">応諾予測モデルの精度の推移</b>
          {runs.length ? <div class="in-scroll"><table class="sv-table"><thead><tr><th>学習</th><th>件数</th><th>AUC</th><th>対数損失の改善</th><th>昇格</th></tr></thead>
            <tbody>{runs.slice(-5).map((r) => <tr key={String(r.version)}><td title={String(r.version)}>{new Date(String(r.run_at)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>{r.train_rows}</td><td>{n(r.auc).toFixed(3)}</td><td>{r.logloss_gain === null ? '-' : `${(n(r.logloss_gain) * 100).toFixed(1)}%`}</td><td>{r.promoted ? '○' : '見送り'}</td></tr>)}</tbody></table></div>
            : <p class="muted small">まだ学習の記録がありません</p>}
        </section>
      </div>

      <div class="sv-two">
        <section class="card">
          <b style="font-weight:500">AI（Gemini）の利用状況</b>
          <p class="sv-note">全施設・直近30日。{k.ai_calls_30d ?? 0}回・{(k.ai_tokens_30d ?? 0).toLocaleString()}トークン</p>
          {ai.length ? <div class="in-scroll"><table class="sv-table"><thead><tr><th>機能</th><th>回数</th><th>トークン</th><th>応答（平均 / 95%）</th></tr></thead>
            <tbody>{ai.map((r) => <tr key={`${r.feature}${r.model}`}><td title={String(r.model)}>{FEATURE[String(r.feature)] ?? r.feature}</td><td>{r.calls}</td>
              <td><div class="in-bar" title={`${n(r.total_tokens).toLocaleString()}`}><i style={{ width: `${(n(r.total_tokens) / aiMax) * 100}%` }} /></div><span class="sv-note">{n(r.total_tokens).toLocaleString()}</span></td>
              <td>{(n(r.avg_latency_ms) / 1000).toFixed(1)}秒 / {(n(r.p95_latency_ms) / 1000).toFixed(1)}秒</td></tr>)}</tbody></table></div>
            : <p class="muted small">直近30日の呼び出しはありません</p>}
        </section>
        <section class="card">
          <b style="font-weight:500">ソルバー（CP-SAT）の実行時間</b>
          <p class="sv-note">この施設のシフト作成（月次＋日次の反復）。平均 {k.solver_avg_ms !== null ? `${(k.solver_avg_ms / 1000).toFixed(1)}秒` : '-'}</p>
          {solver.length ? <div class="in-scroll"><table class="sv-table"><thead><tr><th>実行</th><th>対象月</th><th>結果</th><th>所要</th></tr></thead>
            <tbody>{solver.slice(0, 6).map((r) => <tr key={String(r.solved_at)}><td>{new Date(String(r.solved_at)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>{r.roster_month}</td><td>{r.status}</td><td>{(n(r.wall_ms) / 1000).toFixed(1)}秒</td></tr>)}</tbody></table></div>
            : <p class="muted small">まだ実行の記録がありません</p>}
        </section>
      </div>
      <p class="sv-note">同じ数字は Looker Studio でも開けます（BigQuery の care_ml / care_analytics の v_ で始まるビュー）。</p>
    </div>
  );
}
