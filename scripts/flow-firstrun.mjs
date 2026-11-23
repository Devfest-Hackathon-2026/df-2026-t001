// 初めて開いたときの通し確認。空のブラウザで、入口 → はじめの条件 → リーダー画面 → シフト作成 までをたどり、
// 「入れた条件がシフト作成に届いているか」を1行ずつ出す。届いていない項目は NG と出る（いまは NG が正しい状態もある）。
//
//   npm run dev            # 別の端末で
//   node scripts/flow-firstrun.mjs [http://localhost:5173/]
//
// 終了コード: ページの例外が1件でもあれば 1。NG の行があっても 0（つなぐ作業の進み具合を見るためのもの）。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = process.argv[2] ?? 'http://localhost:5173/';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'firstrun');
fs.mkdirSync(OUT, { recursive: true });

const MARK = { facility: 'けんしょう苑', staff: '検証 太郎', nightMax: '5' };
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const solveBodies = [];
page.on('request', (r) => { if (r.url().includes('/api/v1/solve-inline')) solveBodies.push(r.postData() ?? ''); });
let n = 0;
const shot = (name) => page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: false });
const row = (ok, text) => console.log(`${ok ? 'OK' : 'NG'}  ${text}`);
const here = () => new URL(page.url()).pathname;

// 1. 空のブラウザでリーダー画面を開く → はじめの条件へ送られる
await page.goto(B + 'setup.html'); await page.evaluate(() => localStorage.clear());
await page.goto(B); await page.waitForTimeout(1000); await shot('entry');
row(here().endsWith('/setup.html'), `初めて開くと、はじめの条件へ送られる（いま ${here()}）`);

// 2. はじめの条件を入れて、確認まで進む
await page.getByRole('button', { name: '設定をはじめる' }).click();
await page.getByPlaceholder('例：ひだまりの郷').fill(MARK.facility);
const next = async () => { await page.getByRole('button', { name: '次へ進む' }).click(); await page.waitForTimeout(200); };
await next(); await next(); await next();
await page.getByLabel('職員1の名前').fill(MARK.staff); await next();
const nm = page.locator('input[type=number]').first(); if (await nm.count()) await nm.fill(MARK.nightMax);
await next(); await next(); await shot('verify');
const toLeader = page.getByRole('link', { name: /リーダー|シフト/ }).or(page.getByRole('button', { name: /リーダー画面|シフトを作る|シフト作成/ }));
const hasWay = (await toLeader.count()) > 0;
row(hasWay, '確認画面から、リーダー画面（シフト作成）へ進める');

// 3. リーダー画面へ（道が無ければ URL を直接開く）
if (hasWay) await toLeader.first().click(); else await page.goto(B);
await page.waitForTimeout(1200); await shot('leader');
row(here() !== '/setup.html', `はじめの条件を入れたあとは、リーダー画面が開く（いま ${here()}）`);
const header = await page.locator('header').first().innerText().catch(() => '');
row(header.includes(MARK.facility), `リーダー画面の施設名が、入れた施設名になる（いま「${header.split('\n')[1] ?? ''}」）`);
let setupAgain = await page.getByRole('button', { name: /はじめの条件|施設の条件/ }).count();
if (setupAgain === 0) {
  const settingsBtn = page.getByRole('button', { name: '設定', exact: true });
  if (await settingsBtn.count()) {
    await settingsBtn.first().click();
    await page.waitForTimeout(300);
    await shot('settings');
    setupAgain = await page.getByRole('button', { name: /はじめの条件|施設の条件/ }).count();
  }
}
row(setupAgain > 0, 'リーダー画面から、はじめの条件を開き直せる');

// 4. シフト作成
await page.getByRole('button', { name: 'シフト', exact: true }).first().click();
await page.getByRole('tab', { name: 'シフト作成' }).click();
await page.getByRole('button', { name: /シフトを作る|作り直す/ }).click();
await page.waitForFunction(() => !document.body.innerText.includes('ソルバーで最適化中'), null, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(500); await shot('plan');
const plan = await page.locator('.plan').innerText().catch(() => '');
const body = solveBodies.at(-1) ?? '';
row(solveBodies.length > 0, `シフト作成でソルバーを呼ぶ（${solveBodies.length}回）`);
row(body.includes('"staff_id":"S001"') && (body.match(/"staff_id"/g) ?? []).length === 20, `ソルバーに送る職員が、入れた20人になる（送ったのは ${(body.match(/"staff_id"/g) ?? []).length}人）`);
row(body.includes(`"night_max":${MARK.nightMax}`), `ソルバーに、入れた夜勤の上限（月${MARK.nightMax}回）が届く`);
row(plan.includes(MARK.staff), `作ったシフトに、入れた職員（${MARK.staff}）が出る`);
row(!plan.includes('簡易計算'), '端末内の簡易計算（架空データで組む）に落ちていない');

console.log(`\nスクリーンショット: ${OUT}`);
console.log(`ページの例外: ${errors.length}件${errors.length ? '\n' + errors.join('\n') : ''}`);
await browser.close();
process.exit(errors.length ? 1 : 0);
