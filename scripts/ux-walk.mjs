// 画面を一通り歩いて撮る（UI/UX の確認用）。リーダーは PC とタブレット、職員はスマホの幅で。
// 各画面・各タブで、スクリーンショットと「画面に出ている文字」（数の食い違いを探すため）を残す。
//
//   node scripts/ux-walk.mjs [http://localhost:5180/]
// 出力: artifacts/ux/<幅>/<番号>-<画面>.png と artifacts/ux/text.json
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = process.argv[2] ?? 'http://localhost:5180/';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'ux');
fs.mkdirSync(OUT, { recursive: true });
const texts = {};
const errors = [];
const browser = await chromium.launch();

async function walk(label, url, viewport, navNames, opts = {}) {
  const ctx = await browser.newContext({ viewport, locale: 'ja-JP', deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text().slice(0, 200)}`); });
  page.on('dialog', (d) => d.dismiss());
  const dir = path.join(OUT, label);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const shot = async (name) => {
    await page.waitForTimeout(500);
    const f = `${String(++n).padStart(2, '0')}-${name}`.replace(/[\/\s]/g, '_');
    await page.screenshot({ path: path.join(dir, f + '.png'), fullPage: !!opts.full });
    texts[`${label}/${f}`] = (await page.locator('main, body').first().innerText().catch(() => '')).slice(0, 4000);
  };
  await page.goto(url);
  await page.waitForTimeout(1500);
  if (opts.before) await opts.before(page, shot);
  await shot('start');
  for (const nav of navNames) {
    const btn = page.getByRole('button', { name: nav, exact: true }).first();
    if (!(await btn.count())) { await shot(`${nav}-無い`); continue; }
    await btn.click();
    await shot(nav);
    const tabs = page.getByRole('tab');
    const k = await tabs.count();
    for (let i = 1; i < k; i++) {
      const t = tabs.nth(i);
      const nm = (await t.innerText().catch(() => `tab${i}`)).trim().split('\n')[0].slice(0, 16);
      await t.click().catch(() => {});
      await shot(`${nav}-${nm}`);
    }
  }
  await ctx.close();
}

// ---- Q7：シフト作成のチャットから決まり（ルール）を足す流れ
// ルールの翻訳（translate-inline）と言葉の分類（plan-intent）は、UX_AI_URL（既定 http://localhost:8091、bench/scripted_ai.py の
// 台本の答えを返す LLM）に回す。翻訳・検証・候補のコードは本物。解き直し（solve-inline）は画面のソルバーそのまま。
const AI = process.env.UX_AI_URL ?? 'http://localhost:8091';
const q7 = { checks: [], solves: [], inputs: {} };
async function ruleFlow() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'ja-JP', deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`q7: ${e.message}`));
  page.on('dialog', (d) => d.dismiss());
  for (const p of ['/api/v1/rules/translate-inline', '/api/v1/plan-intent']) {
    await page.route(`**${p}`, async (route) => { const r = await route.fetch({ url: AI + p }); await route.fulfill({ response: r }); });
  }
  page.on('request', (r) => { if (r.url().endsWith('/api/v1/solve-inline')) { try { const b = JSON.parse(r.postData() ?? '{}'); q7.solves.push({ rules: (b.rules ?? []).length, baseline: !!b.baseline }); } catch { /* ignore */ } } });
  const dir = path.join(OUT, 'walk-q7'); fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(dir, `${String(++n).padStart(2, '0')}-${name}.png`) }); };
  const check = (name, ok, detail) => q7.checks.push({ name, ok: !!ok, detail });
  let clicks = 0, keys = 0;
  const click = async (loc) => { clicks++; await loc.click(); };
  const say = async (t) => { const box = page.getByLabel('シフト作成君へのメッセージ'); await box.fill(t); keys += t.length; await click(page.locator('.plandockchat button[type=submit]')); };
  const body = () => page.locator('body').innerText();
  const waitText = (rx, timeout = 40000) => page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), rx.source, { timeout }).then(() => true).catch(() => false);

  await page.goto(B + '?demo'); await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'シフト', exact: true }).first().click();
  await page.getByRole('tab', { name: 'シフト作成' }).click();
  await page.getByRole('button', { name: /シフトを作る|作り直す/ }).first().click();
  await page.waitForFunction(() => !document.body.innerText.includes('最適化中'), null, { timeout: 40000 }).catch(() => {});
  clicks = 0; keys = 0;

  // 1) 書ける決まり：言葉 → 候補 → 足す → 今の表をもとに作り直す → 変わった勤務の件数と場所
  await say('月1回は土日とも休みにして');
  check('候補が出る', await waitText(/このルールを足す/));
  check('候補を出しただけでは何も変えない', !(await body()).includes('AIで追加したルール'));
  await shot('候補');
  await click(page.getByRole('button', { name: 'このルールを足す' }).first());
  check('作り直して変わった勤務の件数が出る', await waitText(/作り直しました。変更\d+件/));
  const chg = ((await body()).match(/作り直しました。変更(\d+)件/) ?? [])[1];
  q7.inputs.add = { clicks, keys, utterances: 1, changed: chg != null ? +chg : null };
  const last = q7.solves.at(-1);
  check('解き直しは足したルールと前の表を送る', last && last.rules === 1 && last.baseline, JSON.stringify(last));
  await page.getByRole('tab', { name: /作る前/ }).click();
  check('作る前の確認にルールが1本出る', (await body()).includes('労務ルール＋追加1本'));
  await shot('足して作り直した');
  const txt = await body();
  check('内部の言葉を出さない', !/CP-SAT|Occurrence|Balance|baseline|target|hard\b/.test(txt), (txt.match(/CP-SAT|Occurrence|Balance|baseline|target|hard\b/) ?? [])[0]);

  // 2) 元に戻す：足す前のルールと表に戻る
  await click(page.getByRole('button', { name: '元に戻す' }));
  await page.waitForTimeout(500);
  check('元に戻すとルールが消える', !(await body()).includes('AIで追加したルール'));
  await shot('元に戻した');

  // 3) 書けない決まり：「書けません」だけを返し、近い形を勝手に出さない
  const before = await page.getByRole('button', { name: 'このルールを足す' }).count();
  await say('夜勤中に連続で2時間仮眠が取れるように回して');
  check('書けない決まりには「書けません」', await waitText(/今のルールの形では書けません/));
  check('書けない決まりに候補を出さない', (await page.getByRole('button', { name: 'このルールを足す' }).count()) === before);
  await shot('書けない');

  // 4) 入力欄で入る条件：欄を案内する（AI の分類 add_rule を通る経路）
  await say('勤務と勤務の間を11時間空けて');
  check('入力欄で入る条件は欄を案内する', await waitText(/設定の「勤務と勤務の間隔」で入ります/));
  await shot('欄の案内');

  // 5) 足して無効にする：チェックを外すと次の作成から外れる
  await say('月1回は土日とも休みにして');
  await waitText(/このルールを足す/);
  await page.getByRole('button', { name: 'このルールを足す' }).last().click();
  await waitText(/作り直しました。変更\d+件/);
  await page.locator('.chatrule-lbl input[type="checkbox"]').first().uncheck();
  check('無効にすると一覧に「無効」', await waitText(/（無効）/, 5000));
  const k = q7.solves.length;
  await page.getByRole('button', { name: /シフトを作る|作り直す/ }).first().click();
  await page.waitForFunction(() => !document.body.innerText.includes('最適化中'), null, { timeout: 40000 }).catch(() => {});
  check('止めたルールは次の作成で送らない', q7.solves.length > k && q7.solves.at(-1).rules === 0, JSON.stringify(q7.solves.at(-1)));
  await shot('止めて作り直した');
  await ctx.close();
}

const LEADER = ['ホーム', 'シフト', '要対応', '職員', '体調', 'チャット', '設定'];
const makePlan = async (page, shot) => {
  // シフト作成で案を作る（ローカルのソルバー）
  await page.getByRole('button', { name: 'シフト', exact: true }).first().click();
  const tab = page.getByRole('tab', { name: 'シフト作成' });
  if (await tab.count()) {
    await tab.click();
    await shot('シフト作成-作る前');
    const mk = page.getByRole('button', { name: /シフトを作る|作り直す/ });
    if (await mk.count()) {
      await mk.first().click();
      await page.waitForFunction(() => !document.body.innerText.includes('最適化中'), null, { timeout: 40000 }).catch(() => {});
      await shot('シフト作成-作った後');
    }
  }
  await page.getByRole('button', { name: 'ホーム', exact: true }).first().click();
};
await walk('leader-desktop', B + '?demo', { width: 1280, height: 860 }, LEADER, { before: makePlan });
await ruleFlow().catch((e) => q7.checks.push({ name: '流れが最後まで進む', ok: false, detail: String(e).split('\n')[0] }));
await walk('leader-tablet', B + '?demo', { width: 768, height: 1024 }, LEADER);
await walk('employee-phone', B + 'employee.html', { width: 390, height: 844 }, ['ホーム', 'シフト', '体調', 'チャット', '設定'], { full: true });

fs.writeFileSync(path.join(OUT, 'walk-q7', 'result.json'), JSON.stringify(q7, null, 1));
console.log(`Q7 チャットでルールを足す: ${q7.checks.filter((c) => c.ok).length}/${q7.checks.length} OK${q7.checks.filter((c) => !c.ok).map((c) => `\n  NG ${c.name}: ${c.detail ?? ''}`).join('')}`);
fs.writeFileSync(path.join(OUT, 'text.json'), JSON.stringify(texts, null, 1));
console.log(`撮影 ${Object.keys(texts).length} 枚 -> ${OUT}`);
console.log(`ページの例外・console.error: ${errors.length}件${errors.length ? '\n' + [...new Set(errors)].slice(0, 20).join('\n') : ''}`);
await browser.close();
