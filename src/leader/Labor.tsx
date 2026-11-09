import { useMemo, useState } from 'preact/hooks';
import { staffById, unitName } from '../core/facility';
import { LABOR_RULES, monthStats } from '../core/labor';
import type { State } from '../core/store';
import { Icon } from '../shared/ui';

const MONTHS = ['2026-11', '2026-12'];
export function Labor({ s, openStaff, onPrint }: { s: State; openStaff: (id: string) => void; onPrint: (ym: string) => void }) {
  const [ym, setYm] = useState(MONTHS[0]);
  const stats = useMemo(() => monthStats(s.assignments, `${ym}-01`).sort((a, b) => b.warnings.length - a.warnings.length || a.staffId.localeCompare(b.staffId)), [s.assignments, ym]);
  const warnN = stats.filter((x) => x.warnings.length).length;
  return (
    <div class="page scroll">
      <div class="row spread wrap" style="margin-bottom:12px">
        <div class="seg">{MONTHS.map((m) => <button key={m} aria-pressed={ym === m} onClick={() => setYm(m)}>{Number(m.slice(5))}月</button>)}</div>
        <button class="btn" onClick={() => onPrint(ym)}><Icon n="print" sm /> 勤務表を印刷</button>
      </div>
      <div class="card" style="margin-bottom:12px"><span class={`chip ${warnN ? 'warn' : 'ok'}`}>要確認 {warnN}名</span>
        <p class="small" style="margin-top:8px">連勤は{LABOR_RULES.maxConsecutive}日まで／勤務間{LABOR_RULES.minIntervalH}時間以上／夜勤は月{LABOR_RULES.maxNightsPerMonth}回まで／公休は月{LABOR_RULES.minOffDays}日以上を目安にしています。目安です。法令・就業規則に基づく最終判断は施設で行ってください。</p></div>
      <div class="cards">{stats.map((x) => { const st = staffById(x.staffId); return (
        <section key={x.staffId} class={`card${x.warnings.length ? ' warncard' : ''}`}>
          <div class="row spread"><button class="link" onClick={() => openStaff(x.staffId)}>{st.name}</button><span class="small">{unitName(st.homeUnit)}・{st.employment}</span></div>
          <div class="nums"><div><b>{x.workDays}</b><span class="small">勤務日</span></div><div><b>{x.nights}</b><span class="small">夜勤</span></div><div><b>{x.offDays}</b><span class="small">公休</span></div><div><b>{Math.round(x.hours)}</b><span class="small">時間</span></div><div><b>{x.maxConsecutive}</b><span class="small">最大連勤</span></div></div>
          {x.warnings.map((w, i) => <p key={i} class="warnline"><span class="chip warn">{w.kind}</span> {w.text}</p>)}
        </section>); })}</div>
    </div>
  );
}
