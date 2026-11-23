// ホームの「欠員の見込み」カード。BigQuery の分析（GET /facilities/{fid}/insights）から、リーダーが先回りに使える2つだけを出す：
// 今後4週の欠員の予測（BigQuery ML ARIMA_PLUS）と、欠員が多い曜日・勤務帯。分析が無効・読めないときはカードごと出さない。
import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../../shared/ui';
import { get } from './api';
import type { InsightsRes } from './InsightsView';
import { RANK_MODEL_FID } from './AcceptNote';

export function Outlook({ onMore }: { onMore: () => void }) {
  const [k, setK] = useState<InsightsRes['kpis'] | null>(null);
  useEffect(() => {
    let live = true;
    get<InsightsRes>(`/api/v1/facilities/${RANK_MODEL_FID}/insights`).then((d) => { if (live && d.available) setK(d.kpis); }).catch(() => { /* 分析が無効・停止中ならカードを出さない */ });
    return () => { live = false; };
  }, []);
  if (!k || (k.forecast_next4w === null && !k.peak_slot)) return null;
  return (
    <section class="card" style="margin-top:12px">
      <h3 class="h3">欠員の見込み</h3>
      <div class="tiles" style="margin-top:8px;grid-template-columns:repeat(2,1fr)">
        {k.forecast_next4w !== null && <div class="tile"><span class="small">今後4週の欠員</span><b>{k.forecast_next4w}<span class="small">件ほど</span></b></div>}
        {k.peak_slot && <div class="tile"><span class="small">欠員が多い枠</span><b style="font-size:1.1em">{k.peak_slot.weekday}曜・{k.peak_slot.shift}</b></div>}
      </div>
      <div class="row spread wrap" style="margin-top:8px;gap:8px">
        <span class="small">これまでの欠員の記録（架空）から集計した目安です</span>
        <button class="btn sm" onClick={onMore}><Icon n="insights" sm /> くわしく見る</button>
      </div>
    </section>
  );
}
