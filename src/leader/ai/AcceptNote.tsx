// 打診の行の「応諾の見込み ○%」を押すと出す説明。画面の順位付け（POST /api/v1/rank-candidates）が使っているモデル
// （サーバーの RANK_PRIOR_FACILITY、既定 fac-sakura の champion）の学習の状況を、数字の名前を出さずに言葉で見せる。
import { useEffect, useState } from 'preact/hooks';
import { get } from './api';
import type { ModelInfo } from './api';

export const RANK_MODEL_FID = 'fac-sakura';
let cache: Promise<ModelInfo> | null = null;
/** 学習の状況（同じ画面で何度も開くので、1回だけ取りに行く。失敗したら次に開いたときに取り直す） */
export const rankModelInfo = () => (cache ??= get<ModelInfo>(`/api/v1/facilities/${RANK_MODEL_FID}/models/acceptance`).catch((e) => { cache = null; throw e; }));

export function AcceptNote({ onMore }: { onMore?: () => void }) {
  const [m, setM] = useState<ModelInfo | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { let live = true; rankModelInfo().then((x) => live && setM(x)).catch(() => live && setErr(true)); return () => { live = false; }; }, []);
  const c = m?.champion;
  return (
    <div class="accnote small" role="note">
      {!m && !err && <p>学習の状況を読み込んでいます…</p>}
      {err && <p>学習の状況を読み込めませんでした。見込みは、過去の打診の記録から学習した予測です。</p>}
      {c && <p>過去の打診 {c.rows.toLocaleString()}件（応諾・辞退と、そのときの連勤・依頼までの余裕・今月の勤務時間など）から学習した予測です。
        {c.logloss_gain !== null && c.logloss_gain > 0 ? `全員を同じ確率とみなす予測より、当たり方が${(c.logloss_gain * 100).toFixed(1)}%よいことを確かめてから使っています。` : ''}</p>}
      {m && !c && <p>{m.note ?? '学習したモデルがまだないため、過去の応諾率をもとにした見込みです。'}</p>}
      <p>打診してよいかは、この見込みではなく連勤・夜勤明け・スキルなどのルールで決めています。見込みは順番を並べ替えるだけです。学習に使っているのは架空の履歴です。</p>
      {onMore && <button class="link" onClick={onMore}>学習のしくみを見る</button>}
    </div>
  );
}
