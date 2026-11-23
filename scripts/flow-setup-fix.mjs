// はじめの設定（setup.html）の「嘘をつかない」修正（F1〜F3）の通し確認スクリプト。
// 空のブラウザから S0〜S7 → リーダー画面 → シフト作成 まで操作し、
// 各画面のスクリーンショットを artifacts/setup-fix/ に保存する。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = process.argv[2] ?? 'http://localhost:5173/';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'setup-fix');
fs.mkdirSync(OUT, { recursive: true });

const TSV_STAFF = [
  '山田 和子\t管理者\t常勤\t早日\t可\tひまわり\t\t土日',
  '佐藤 花子\t介護福祉士\t常勤\t早日遅夜\t可\tひまわり\t\t',
  '鈴木 一郎\t介護福祉士\t常勤\t早日遅夜\t可\tひまわり\t\t',
  '高橋 誠\t介護職員\t常勤\t早日遅夜\t\tひまわり\t\t',
  '田中 美穂\t介護職員\t常勤\t早日遅夜\t\tひまわり\t\t',
  '伊藤 健\t介護職員\t常勤\t早日遅夜\t\tひまわり\t\t',
  '渡辺 由美\t介護福祉士\t常勤\t早日遅夜\t可\tあさがお\t\t',
  '中村 翔\t介護職員\t常勤\t早日遅夜\t\tあさがお\t\t',
  '小林 さやか\t介護職員\t常勤\t早日遅夜\t\tあさがお\t\t',
  '加藤 大輔\t介護福祉士\t常勤\t早日遅夜\t可\tあさがお\t\t',
  '吉田 恵\t介護職員\t常勤\t早日遅夜\t\tあさがお\t\t',
  '山本 洋子\t介護職員\tパート\t早日\t\tひまわり\t16:00\t日',
  '松本 京子\t介護職員\tパート\t早日\t\tあさがお\t17:00\t土日',
  '井上 拓\t介護職員\tパート\t夜\t\tあさがお\t\t水',
  '木村 真理\t介護職員\tパート\t遅\t\tひまわり\t\t',
].join('\n');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('dialog', (d) => d.accept());

const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
};
const next = async () => {
  await page.getByRole('button', { name: '次へ進む' }).click();
  await page.waitForTimeout(250);
};

// 0. 空のブラウザで / を開く → setup.html に送られる
await page.goto(B + 'setup.html');
await page.evaluate(() => localStorage.clear());
await page.goto(B);
await page.waitForTimeout(600);
await shot('01-S0-intro');
console.log('S0 URL:', new URL(page.url()).pathname);

// S0 → S1
await page.getByRole('button', { name: '設定をはじめる' }).click();
await page.waitForTimeout(250);
await page.locator('#facility-name').fill('グループホーム ひだまりの家');
await page.locator('#facility-kind').selectOption('グループホーム');
const unitInputs = page.locator('.unit-row input[type="text"]');
await unitInputs.nth(0).fill('ひまわり');
await unitInputs.nth(1).fill('あさがお');
await page.waitForTimeout(150);
await shot('02-S1-facility');

// S1 → S2: 日勤を 09:00〜18:00
await next();
await page.locator('#shift-start-日勤').fill('09:00');
await page.locator('#shift-end-日勤').fill('18:00');
await page.waitForTimeout(150);
await shot('03-S2-shifts');

// S2 → S3: 日勤を 1人に
await next();
await page.getByLabel('日勤の必要人数').fill('1');
await page.waitForTimeout(150);
await shot('04-S3-need');

// S3 → S4: Excel から貼り付け → いまの表をすべて入れ替える → 15行取り込む
await next();
await page.getByRole('button', { name: 'Excel から貼り付け' }).click();
await page.locator('.paste-textarea').fill(TSV_STAFF);
await page.getByLabel('いまの表をすべて入れ替える').check();
await page.getByRole('button', { name: '貼り付けを取り込む' }).click();
await page.waitForTimeout(250);
const yamadaRoleS4 = await page.getByLabel('山田 和子の役割').inputValue();
const pasteNoticeText = await page.locator('.paste-panel').innerText();
console.log('S4 山田 和子の役割:', yamadaRoleS4);
console.log('S4 貼り付け結果:', pasteNoticeText.split('\n').at(-1));
await shot('05-S4-staff');

// S4 → S5: 夜勤の上限を 6回に
await next();
await page.getByLabel('夜勤の月間上限回数').fill('6');
await page.waitForTimeout(150);
await shot('06-S5-rules');

// S5 → S6: 佐藤 花子・渡辺 由美を「夜勤」、鈴木 一郎を「遅番」に
await next();
const setCarry = async (name, shiftLabel) => {
  const row = page.locator('.carry-table tbody tr', { hasText: name });
  await row.getByRole('button', { name: shiftLabel, exact: true }).click();
};
await setCarry('佐藤 花子', '夜勤');
await setCarry('渡辺 由美', '夜勤');
await setCarry('鈴木 一郎', '遅番');
await page.waitForTimeout(150);
const yamadaRowS6 = await page.locator('.carry-table tbody tr', { hasText: '山田 和子' }).innerText();
console.log('S6 山田 和子行:', yamadaRowS6.replace(/\s+/g, ' ').trim());
await shot('07-S6-carryin');

// S6 → S7
await next();
await page.waitForTimeout(200);
await shot('08-S7-verify');

// S7 → リーダー画面へ → シフト → シフト作成 → 作ってもらう
await page.getByRole('button', { name: 'リーダー画面へ', exact: true }).click();
await page.waitForTimeout(1000);
await page.getByRole('button', { name: 'シフト', exact: true }).first().click();
await page.getByRole('tab', { name: 'シフト作成' }).click();
await page.waitForTimeout(400);
await shot('09-plan-before');
await page.getByRole('button', { name: /シフトを作る|作り直す/ }).click();
await page.waitForFunction(() => !document.body.innerText.includes('ソルバーで最適化中'), null, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(500);
await shot('10-plan-after');
const planText = await page.locator('.plan').innerText();
console.log('F3 注意あり（保存あり）:', planText.includes('はじめの条件（グループホーム ひだまりの家・職員15人）は、まだシフト作成に使っていません'));

// ?demo（care-setup-v2 なし）では注意が出ないことを確認
await page.evaluate(() => localStorage.removeItem('care-setup-v2'));
await page.goto(B + '?demo');
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'シフト', exact: true }).first().click();
await page.getByRole('tab', { name: 'シフト作成' }).click();
await page.waitForTimeout(300);
const demoPlanText = await page.locator('.plan').innerText();
console.log('F3 注意なし（?demo・未保存）:', !demoPlanText.includes('まだシフト作成に使っていません'));

console.log(`スクリーンショット: ${OUT}`);
console.log(`エラー: ${errors.length}件${errors.length ? '\n' + errors.join('\n') : ''}`);
await browser.close();
process.exit(errors.length ? 1 : 0);
