// チャットでルールを足して、今の表をもとに解き直す流れ（addChatRule → solve-inline の baseline つき）を、画面の store を headless で動かして確かめる。
// Gemini は呼ばない（ルールは translate-inline が返す形をここで直接書く）。ローカルの API を立ててから:
//   (cd solver-api && STORE=memory HEAVY_PER_MIN=100 .venv/bin/python -m uvicorn care.server:app --port 8765)   ※求解を続けて8回呼ぶので、1分6回の制限を上げる
//   npx esbuild scripts/check/chat-rule-resolve.ts --bundle --platform=node --format=esm \
//     '--define:import.meta.env={"VITE_SOLVER_URL":"http://127.0.0.1:8765"}' --outfile=/tmp/chat-rule.mjs && node /tmp/chat-rule.mjs
// 2026-11-24 の不具合：「全員の土日夜勤の差は1回以内」で、できれば → 変更0件なのに「もともと守れていた」、絶対 → 緩めるルールの名前が出ない。
import * as S from '../../src/core/store';
import type { RuleCand } from '../../src/core/chatRules';

const MONTH = process.env.MONTH ?? '2026-12';
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const until = async (f: () => boolean, ms = 60_000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); return f(); };
const night = (weekdays: number[] | null, spread: number, strength: RuleCand['strength']): RuleCand => ({
  scope: 'everyone', label: `夜勤の差は${spread}回以内（${strength}）`, strength, impact: null,
  rule: { type: 'balance', people: {}, shifts: { ids: ['夜勤'] }, days: weekdays ? { weekdays } : {}, max_spread: spread, strength },
});

async function run(cand: RuleCand) {
  S.resetDemo();
  S.createPlan(MONTH);
  await until(() => !S.planSolving());
  S.addChatRule(cand, MONTH);
  await until(() => S.getRuleChange()?.state !== 'solving');
  return { c: S.getRuleChange()!, notes: S.getState().plan!.notes };
}

// 1. できれば・土日・差1：夜勤に入れる人だけでそろえれば守れる（前は夜勤に入れない人の0回が混ざって守れなかった）
{
  const { c, notes } = await run(night([0, 6], 1, 'できれば'));
  console.log('  ', JSON.stringify({ state: c.state, count: c.count, broken: c.broken }));
  ok(c.state === 'done' && c.broken === 0 && (c.count ?? 0) > 0, 'できれば・土日の夜勤の差1：守れて、表が動く');
  const n = notes.find((x) => x.startsWith('夜勤の回数'));
  ok(!!n && n.includes('夜勤に入れる27名'), `夜勤に入れる人数の数え方: ${n}`);
}
// 2. 絶対・土日・差1：作れる
{
  const { c } = await run(night([0, 6], 1, '絶対'));
  console.log('  ', JSON.stringify({ state: c.state, count: c.count, broken: c.broken, message: c.message }));
  ok(c.state === 'done', '絶対・土日の夜勤の差1：作れる');
}
// 3. できれば・月全体・差0：守れない → 「守れていた」と言わず、守れていない件数を持つ
{
  const { c } = await run(night(null, 0, 'できれば'));
  console.log('  ', JSON.stringify({ state: c.state, count: c.count, broken: c.broken }));
  ok(c.state === 'done' && (c.broken ?? 0) > 0, 'できれば・月の夜勤の差0：守れていない件数が出る');
}
// 4. 絶対・月全体・差0：作れない → 緩めるルールの名前が出る
{
  const { c } = await run(night(null, 0, '絶対'));
  console.log('  ', JSON.stringify({ state: c.state, message: c.message }));
  ok(c.state === 'failed' && !!c.message?.includes('夜勤の差は0回以内'), '絶対・月の夜勤の差0：作れない理由にルールの名前が出る');
}
console.log(fails ? `\n${fails} 件失敗` : '\nすべて通りました');
process.exit(fails ? 1 : 0);
