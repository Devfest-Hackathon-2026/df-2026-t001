import { useEffect, useState } from 'preact/hooks';
import type { SkillId, Staff } from '../core/types';

export type View = 'dash' | 'month' | 'day' | 'plan' | 'vac' | 'req' | 'people' | 'labor' | 'collect' | 'health' | 'chat' | 'auto' | 'ai';
export interface Nav { view: View; date: string; vacId?: string; thread?: string; }
export type Go = (view: View, o?: Partial<Nav>) => void;

export const SHORT: Record<SkillId, string> = { medical: '医療', dementia: '認知', bath: '入浴', swallow: '嚥下', driver: '送迎', terminal: '看取', follow: 'フォロー', night: '夜勤', ict: 'ICT', preceptor: '指導' };
export const SkillMini = ({ s, max = 4 }: { s: Staff; max?: number }) => {
  const ks = [...s.skills.filter((k) => k === 'medical'), ...s.skills.filter((k) => k !== 'medical' && k !== 'night')];
  return (
    <span class="row" style="gap:3px;flex-wrap:wrap">
      {ks.slice(0, max).map((k) => <span key={k} class={`mini ${k === 'medical' ? 'bad' : ''}`}>{SHORT[k]}</span>)}
      {ks.length > max && <span class="mini">+{ks.length - max}</span>}
    </span>
  );
};

export function useWidth() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1280);
  useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
  return w;
}
export const useWide = (px = 1100) => useWidth() >= px;
export const VAC_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: '登録', cls: 'bad' }, offering: { label: '打診中', cls: 'warn' }, posted: { label: '掲載中', cls: 'warn' }, applied: { label: '応募確認', cls: 'pri' }, filled: { label: '充足', cls: 'ok' },
};
export const VAC_STEPS = ['open', 'offering', 'posted', 'applied', 'filled'] as const;
export const hm = (at: string) => at.slice(11, 16);
export const Back = ({ onClick, label = '一覧へ' }: { onClick: () => void; label?: string }) => <button class="btn sm back" onClick={onClick}><span class="ms sm" aria-hidden="true">arrow_back</span>{label}</button>;
