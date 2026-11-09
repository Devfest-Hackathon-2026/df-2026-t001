// AIパネル（public/ai-panel.js）がアプリの状態を読むための、読み取り専用の橋渡し。
// 状態を書き換える関数は公開しない。個人情報は含まない（氏名はデモ用の架空名のみ）。
import { getState } from './store';
import { rankCandidates } from './roster';
import { SKILLS, STAFF, unitName } from './facility';

export function installAiBridge() {
  const bridge = {
    // 同期用の読み取り専用スナップショット（アプリが初回コミットするまでlocalStorageに無いため）
    snapshot: () => getState(),
    staff: () => STAFF.map((s) => ({ id: s.id, name: s.name })),
    vacancies: () => getState().vacancies.filter((v) => v.state !== 'filled').map((v) => ({ id: v.id, date: v.date, shift: v.shift, unit: unitName(v.unitId), state: v.state, needSkills: v.needSkills.map((k) => SKILLS[k].label), reason: v.reason })),
    candidates: (vacancyId: string) => {
      const s = getState(); const v = s.vacancies.find((x) => x.id === vacancyId); if (!v) return null;
      const hopes = Object.fromEntries(Object.entries(s.prefs).map(([k, p]) => [k, p.shiftHope]));
      const cs = rankCandidates(s.assignments, v, hopes, s.availability).filter((c) => !c.blocked).slice(0, 6);
      return {
        vacancy: { date: v.date, shift: v.shift, unit: unitName(v.unitId), needSkills: v.needSkills.map((k) => SKILLS[k].label) },
        candidates: cs.map((c) => ({ id: c.staff.id, name: c.staff.name, score: Math.round(c.score), reasons: c.reasons.slice(0, 5), skills: c.staff.skills.map((k) => SKILLS[k].label) })),
      };
    },
    health: () => { const s = getState(); return s.health.filter((h) => h.date === s.today).map((h) => ({ staffId: h.staffId, temp: h.temp, symptoms: h.symptoms.slice(0, 5), sleep: h.sleep, consult: h.consult })); },
    plan: () => { const p = getState().plan; return p ? { month: p.month, status: p.status, stats: p.stats, notes: p.notes.slice(0, 20) } : null; },
  };
  (window as unknown as { __careAi: typeof bridge }).__careAi = bridge;
}
