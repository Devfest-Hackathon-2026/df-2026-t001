import type { AutopilotSettings } from '../core/types';
import { Icon } from '../shared/ui';

export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (n: number) => void }) {
  return <div class="row" style="gap:4px"><button class="iconbtn" aria-label="減らす" disabled={value <= min} onClick={() => onChange(value - 1)}><Icon n="remove" /></button><b style="min-width:28px;text-align:center;font-weight:500">{value}</b><button class="iconbtn" aria-label="増やす" disabled={value >= max} onClick={() => onChange(value + 1)}><Icon n="add" /></button></div>;
}

const Toggle = ({ label, sub, on, onChange, disabled }: { label: string; sub?: string; on: boolean; onChange: (b: boolean) => void; disabled?: boolean }) => (
  <label class="row spread" style={`min-height:48px;gap:12px${disabled ? ';opacity:.5' : ''}`}><span><b style="font-weight:500;font-size:15px">{label}</b>{sub && <div class="small">{sub}</div>}</span>
    <input type="checkbox" class="sw" checked={on} disabled={disabled} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} /></label>
);
const Level = ({ value, onChange, label }: { value: 'low' | 'normal' | 'high'; onChange: (v: 'low' | 'normal' | 'high') => void; label: string }) => (
  <div class="field"><label>{label}</label><div class="seg" role="group" aria-label={label}>{(['low', 'normal', 'high'] as const).map((k) => <button key={k} aria-pressed={value === k} onClick={() => onChange(k)}>{{ low: '低', normal: '標準', high: '高' }[k]}</button>)}</div></div>
);

/** 詳細設定（全体の「自動対応」設定と、欠員ごとの上書きで共通） */
export function SettingsForm({ val, onChange }: { val: AutopilotSettings; onChange: (p: Partial<AutopilotSettings>) => void }) {
  const kinds = val.adjustKinds;
  return (
    <div class="stack" style="gap:4px">
      <h4 class="sec-title" style="margin-top:0">打診</h4>
      <div class="setgrid" style="margin-top:0">
        <div class="field"><label>打診する最大人数</label><Stepper value={val.maxCandidates} min={1} max={10} onChange={(n) => onChange({ maxCandidates: n })} /></div>
        <div class="field"><label>返信待ち：当日の欠員（分）</label><input class="input" type="number" min={5} step={5} value={val.waitSameDay} onInput={(e) => onChange({ waitSameDay: +(e.target as HTMLInputElement).value || 30 })} /></div>
        <div class="field"><label>返信待ち：それ以外（分）</label><input class="input" type="number" min={5} step={5} value={val.waitOther} onInput={(e) => onChange({ waitOther: +(e.target as HTMLInputElement).value || 120 })} /></div>
        <div class="field"><label>連絡しない時間（開始）</label><input class="input" type="time" value={val.quietStart} onInput={(e) => onChange({ quietStart: (e.target as HTMLInputElement).value })} /></div>
        <div class="field"><label>連絡しない時間（終了）</label><input class="input" type="time" value={val.quietEnd} onInput={(e) => onChange({ quietEnd: (e.target as HTMLInputElement).value })} /></div>
      </div>

      <h4 class="sec-title">求人</h4>
      <Toggle label="打診で埋まらなければ、求人を自動で掲載する" sub="オフにすると、求人の掲載はあなたの承認後に行います。" on={val.autoPost !== false} onChange={(b) => onChange({ autoPost: b })} />
      <h4 class="sec-title">時間をずらす調整</h4>
      <Toggle label="時間調整を先に確認する" sub="単独で足りなければ、方法を組み合わせて確認します。反映前に必ずあなたの承認を求めます。" on={val.useAdjust} onChange={(b) => onChange({ useAdjust: b })} />
      <div style="padding-left:12px;border-left:2px solid var(--line2)">
        <Toggle label="休憩・仮眠をずらす" on={kinds.break} disabled={!val.useAdjust} onChange={(b) => onChange({ adjustKinds: { ...kinds, break: b } })} />
        <Toggle label="他ユニットから一時応援に入る" on={kinds.support} disabled={!val.useAdjust} onChange={(b) => onChange({ adjustKinds: { ...kinds, support: b } })} />
        <Toggle label="出勤・退勤の時間を調整する" sub="退勤上限・勤務間隔を守れる範囲のみ" on={kinds.extend} disabled={!val.useAdjust} onChange={(b) => onChange({ adjustKinds: { ...kinds, extend: b } })} />
      </div>

      <h4 class="sec-title">優先ルール</h4>
      <Toggle label="「入れる日」を出していた人を最優先" on={val.priority.availFirst} onChange={(b) => onChange({ priority: { ...val.priority, availFirst: b } })} />
      <div class="setgrid" style="margin-top:4px">
        <Level label="スキルの重み" value={val.priority.skill} onChange={(k) => onChange({ priority: { ...val.priority, skill: k } })} />
        <Level label="勤務日数の少なさの重み" value={val.priority.days} onChange={(k) => onChange({ priority: { ...val.priority, days: k } })} />
      </div>

      <h4 class="sec-title">求人</h4>
      <div class="field"><label>既定の対価（夜勤は夜勤手当が加わります）</label><input class="input" value={val.defaultReward} onInput={(e) => onChange({ defaultReward: (e.target as HTMLInputElement).value })} /></div>
      <div class="field" style="margin-top:8px"><label>掲載文のひな形（職場の紹介文）</label><textarea class="input" rows={3} style="line-height:1.6" value={val.jobNote} onInput={(e) => onChange({ jobNote: (e.target as HTMLTextAreaElement).value })} /></div>
    </div>
  );
}
