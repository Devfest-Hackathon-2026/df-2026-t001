import { useEffect, useRef, useState } from 'preact/hooks';
import { advanceClock, resetDemo } from '../core/store';
import type { State } from '../core/store';
import { inQuiet } from '../core/store';
import { Icon } from '../shared/ui';

/** デモ用の操作を1つにまとめたメニュー（実際の業務画面とは分けて、上部バーから開く） */
export function DemoMenu({ s }: { s: State }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', f); window.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', f); window.removeEventListener('keydown', k); };
  }, [open]);
  const running = s.vacancies.filter((v) => v.auto?.mode === 'running' && v.offers.some((o) => o.status === 'pending')).length;
  return (
    <div class="demo-wrap" ref={ref}>
      <button class="btn sm demo-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog"><Icon n="science" sm /> デモ</button>
      {open && (
        <div class="demo-pop" role="dialog" aria-label="デモ用の操作">
          <div class="small" style="margin-bottom:8px">デモ用の操作です（架空データ・モック）</div>
          <div class="demo-time"><span class="small">デモ時刻</span><b>{s.now}</b>{inQuiet(s.now, s.autopilot) && <span class="chip warn">連絡しない時間</span>}</div>
          <div class="row wrap" style="margin:8px 0 12px">
            <button class="btn sm" onClick={() => advanceClock(30)}>+30分</button>
            <button class="btn sm" onClick={() => advanceClock(120)}>+2時間</button>
            {running > 0 && <span class="small">打診中 {running}件</span>}
          </div>
          <div class="stack" style="gap:8px">
            <button class="btn sm block" onClick={() => { if (confirm('架空データを初期状態に戻します。よろしいですか？')) { resetDemo(); setDone(true); setTimeout(() => setDone(false), 1500); } }}><Icon n="restart_alt" sm /> 最初からやり直す</button>
            <a class="btn sm block" href="./employee.html"><Icon n="smartphone" sm /> 従業員画面を開く</a>
            {done && <span class="small" role="status">初期化しました</span>}
          </div>
        </div>
      )}
    </div>
  );
}
