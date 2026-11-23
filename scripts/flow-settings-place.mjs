// 置き場所と導線（K1〜K6）の通し確認スクリプト。
//   node scripts/flow-settings-place.mjs [http://localhost:5173/]
// 終了コード: NG、ページ例外、コンソールエラー、または横はみ出し（表の内部スクロールを除く）が1件でもあれば 1。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = process.argv[2] ?? 'http://localhost:5173/';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'settings-place');
fs.mkdirSync(OUT, { recursive: true });

function makeTestSetup(currentStep = 2) {
  const units = [
    { id: 'u1', name: 'ひなた', floor: 1 },
    { id: 'u2', name: 'そよかぜ', floor: 1 },
    { id: 'u3', name: 'あかり', floor: 2 },
  ];
  const shifts = [
    { id: '早番', name: '早番', short: '早', enabled: true, startTime: '07:00', endTime: '16:00', group: '日勤系', counts: true, nextDay: 'なし' },
    { id: '日勤', name: '日勤', short: '日', enabled: true, startTime: '09:00', endTime: '18:00', group: '日勤系', counts: true, nextDay: 'なし' },
    { id: '遅番', name: '遅番', short: '遅', enabled: true, startTime: '12:00', endTime: '21:00', group: '日勤系', counts: true, nextDay: 'なし' },
    { id: '夜勤', name: '夜勤', short: '夜', enabled: true, startTime: '16:30', endTime: '09:30', group: '夜勤系', counts: true, nextDay: '明け' },
  ];
  const staff = Array.from({ length: 18 }, (_, i) => ({
    id: `S${String(i + 1).padStart(3, '0')}`,
    name: i === 0 ? '検証 花子' : `検証 職員${i + 1}`,
    role: i === 0 ? '主任' : i % 3 === 1 ? '介護福祉士' : '介護職員',
    employment: i >= 15 ? 'パート' : '常勤',
    shifts: i === 0 ? ['早番', '日勤', '遅番'] : i >= 15 ? ['早番', '日勤'] : ['早番', '日勤', '遅番', '夜勤'],
    canMedicalCare: i % 3 === 0,
    homeUnit: units[i % units.length].name,
    leaveBy: i >= 15 ? '16:00' : '',
    unavailableDaysOfWeek: i === 0 ? [0, 6] : [],
  }));
  return {
    currentStep,
    facility: {
      name: '検証ケアホーム',
      kind: '特別養護老人ホーム',
      units,
    },
    shifts,
    needPerShift: { 早番: 3, 日勤: 3, 遅番: 3, 夜勤: 3 },
    useWeekdayNeed: false,
    needByWeekday: {},
    staff,
    rules: { nightMax: 5 },
    carryIn: {},
    history: {},
  };
}

let ngCount = 0;
const errors = [];
const checks = [];
function record(ok, text) {
  checks.push({ ok: !!ok, text });
  if (!ok) ngCount += 1;
  console.log(`${ok ? 'OK' : 'NG'}  ${text}`);
}

async function attachListeners(page, tag) {
  page.on('pageerror', (e) => errors.push(`[pageerror:${tag}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console:${tag}] ${m.text()}`);
  });
  page.on('dialog', (d) => d.accept());
}

async function checkHorizontalFit(page, label) {
  const fit = await page.evaluate(() => {
    const pageEl = document.querySelector('.page');
    return {
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      pageScrollW: pageEl ? pageEl.scrollWidth : 0,
      pageClientW: pageEl ? pageEl.clientWidth : 0,
    };
  });
  const ok = fit.scrollW <= fit.innerW && (!fit.pageClientW || fit.pageScrollW <= fit.pageClientW);
  record(
    ok,
    `${label}: 横はみ出しなし（doc ${fit.scrollW}<=${fit.innerW}${fit.pageClientW ? `, page ${fit.pageScrollW}<=${fit.pageClientW}` : ''}）`,
  );
}

async function shot(page, file) {
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, file), fullPage: false });
}

const browser = await chromium.launch({ headless: true });

// ============================================================
// 1. デスクトップ (1280x900) 機能検証 + 比較スクリーンショット
// ============================================================
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  await attachListeners(page, 'desktop');

  // K2 (?demo 未保存)
  await page.goto(B + 'setup.html');
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '?demo&open=settings');
  await page.waitForTimeout(400);
  const demoUrl = new URL(page.url());
  record(
    demoUrl.searchParams.has('demo') && !demoUrl.searchParams.has('open'),
    `K1 ?demo&open=settings で demo を残し open を消す（${demoUrl.search}）`,
  );
  const demoSettingsText = await page.locator('main').innerText();
  record(
    demoSettingsText.includes('まだ入れていません') &&
      demoSettingsText.includes('はじめの条件を入れる') &&
      !demoSettingsText.includes('施設とユニット'),
    'K2 ?demo（未保存）の設定タブに「まだ入れていません」と「はじめの条件を入れる」だけが出る',
  );
  await checkHorizontalFit(page, 'desktop settings-demo');
  await shot(page, '01-settings-demo-desktop.png');

  // テスト用データを保存（currentStep = 2 にしておく）
  const testData = makeTestSetup(2);
  await page.evaluate((data) => {
    localStorage.setItem('care-setup-v2', JSON.stringify(data));
  }, testData);

  // K1: setup.html?step=4&from=settings
  await page.goto(B + 'setup.html?step=4&from=settings');
  await page.waitForTimeout(400);
  const s4Text = await page.locator('body').innerText();
  const s4BackBtn = page.getByRole('button', { name: '設定へ戻る' });
  const staff1Val = await page.getByLabel('職員1の名前').inputValue().catch(() => '');
  record(
    s4Text.includes('職員の一覧') && staff1Val === '検証 花子' && (await s4BackBtn.count()) > 0,
    `K1 setup.html?step=4&from=settings で S4 が開き「検証 花子」と「設定へ戻る」が出る（職員1=${staff1Val}）`,
  );
  await checkHorizontalFit(page, 'desktop setup-s4');
  await shot(page, '02-setup-s4-desktop.png');

  // K1: 範囲外 step=99 は無視され、保存済みの currentStep=2 が開きデータも消えない
  await page.goto(B + 'setup.html?step=99&from=settings');
  await page.waitForTimeout(400);
  const s99Text = await page.locator('main').innerText();
  const savedAfter99 = await page.evaluate(() => JSON.parse(localStorage.getItem('care-setup-v2') || '{}'));
  record(
    s99Text.includes('使う勤務の種類と時刻を教えてください') && savedAfter99?.staff?.[0]?.name === '検証 花子',
    'K1 ?step=99 は無視され、直前の step=2 が開き入力データも消えない',
  );

  // K1: 設定へ戻る → 設定タブが開き open=settings が消える → リロードで設定タブに飛び続けない
  await page.goto(B + 'setup.html?step=4&from=settings');
  await page.waitForTimeout(300);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith('/setup.html')),
    page.getByRole('button', { name: '設定へ戻る' }).click(),
  ]);
  await page.waitForFunction(() => !new URLSearchParams(window.location.search).has('open'));
  await page.waitForTimeout(200);
  const backUrl = new URL(page.url());
  const settingsHeading = await page.locator('h1.ptitle').innerText().catch(() => '');
  record(
    !backUrl.pathname.endsWith('/setup.html') &&
      !backUrl.searchParams.has('open') &&
      settingsHeading.trim() === '設定',
    `K1 「設定へ戻る」でリーダー画面の設定タブが開き URL から ?open= が消える（${backUrl.pathname}${backUrl.search} / 見出し=${settingsHeading}）`,
  );
  await page.reload();
  await page.waitForTimeout(500);
  const afterReloadHeading = await page.locator('h1.ptitle').innerText().catch(() => '');
  record(
    afterReloadHeading.trim() !== '設定',
    `K1 再読み込みで同じ画面（設定）に飛び続けない（見出し=${afterReloadHeading || 'ホーム'}）`,
  );

  // K2 & K5: 設定タブに戻って 4項目＋職員＋夜勤上限の確認
  await page.getByRole('button', { name: '設定', exact: true }).first().click();
  await page.waitForTimeout(400);
  const settingsBody = await page.locator('main').innerText();
  record(
    settingsBody.includes('施設とユニット') &&
      settingsBody.includes('検証ケアホーム・ユニット3つ') &&
      settingsBody.includes('勤務帯') &&
      settingsBody.includes('早番 7:00〜16:00 ほか3つ') &&
      settingsBody.includes('毎日の必要人数') &&
      settingsBody.includes('1日合計 12人') &&
      settingsBody.includes('守ること') &&
      settingsBody.includes('まだ使っていません'),
    'K2 設定タブに4項目の要約と「まだ使っていません」チップが出る',
  );
  record(
    settingsBody.includes('職員 18人') && settingsBody.includes('職員の画面で見る'),
    'K2 設定タブに「職員 18人」と「職員の画面で見る」が出る',
  );
  record(
    settingsBody.includes('夜勤の上限（既定）：月8回まで') &&
      settingsBody.includes('入れた値：月5回まで（まだ使っていません）') &&
      settingsBody.includes('労務の目安（月8回）は警告を出す基準で、作成の上限とは別'),
    'K5 設定タブの「守ること」に既定の値・入れた値・労務の目安との違いが出る',
  );
  await checkHorizontalFit(page, 'desktop settings-saved');
  await shot(page, '03-settings-saved-desktop.png');

  // K6: 4項目（facility / shifts / need / rules）を順番に設定タブ内で展開・比較撮影し、閉じる・リンク往復を確認
  const embedSpecs = [
    { key: 'facility', step: 1, expected: '施設とユニットを教えてください', embedShot: '14-settings-embed-s1-desktop.png', setupShot: '18-setup-s1-desktop.png' },
    { key: 'shifts', step: 2, expected: '使う勤務の種類と時刻を教えてください', embedShot: '15-settings-embed-s2-desktop.png', setupShot: '19-setup-s2-desktop.png' },
    { key: 'need', step: 3, expected: '毎日の必要人数を教えてください', embedShot: '16-settings-embed-s3-desktop.png', setupShot: '20-setup-s3-desktop.png' },
    { key: 'rules', step: 5, expected: 'シフト作成で守ることを確認してください', embedShot: '17-settings-embed-s5-desktop.png', setupShot: '21-setup-s5-desktop.png' },
  ];
  for (const sp of embedSpecs) {
    const row = page.locator(`[data-setup-row="${sp.key}"]`);
    await row.getByRole('button', { name: '直す' }).click();
    await page.waitForTimeout(250);
    const embed = page.locator(`[data-setup-embed="${sp.key}"]`);
    const embedText = await embed.innerText().catch(() => '');
    record(
      (await embed.count()) === 1 && embedText.includes(sp.expected),
      `K6 設定タブの「直す」(${sp.key}) で同じ画面部品が埋め込み展開される`,
    );
    await checkHorizontalFit(page, `desktop settings-embed-${sp.key}`);
    await embed.scrollIntoViewIfNeeded();
    await shot(page, sp.embedShot);

    // 閉じる
    await row.getByRole('button', { name: '閉じる' }).click();
    await page.waitForTimeout(150);
    record((await embed.count()) === 0, `K6 「閉じる」(${sp.key}) で埋め込みが閉じる`);
  }

  // K6: 保存一本化・即時要約更新・Step5Rules の「人数を直す」・setup.html との共有確認
  const storageKeysBefore = await page.evaluate(() => Object.keys(localStorage).sort());
  await page.locator('[data-setup-row="facility"]').getByRole('button', { name: '直す' }).click();
  await page.locator('[data-setup-embed="facility"] #facility-name').fill('設定タブ編集苑');
  await page.waitForTimeout(150);
  const facRowText = await page.locator('[data-setup-row="facility"]').innerText();
  record(
    facRowText.includes('設定タブ編集苑・ユニット3つ'),
    'K6 設定タブで施設名を編集すると上の要約が即座に更新される',
  );

  await page.locator('[data-setup-row="rules"]').getByRole('button', { name: '直す' }).click();
  await page.locator('[data-setup-embed="rules"]').getByLabel('夜勤の月間上限回数').fill('7');
  await page.waitForTimeout(150);
  const rulesRowText = await page.locator('[data-setup-row="rules"]').innerText();
  record(
    rulesRowText.includes('入れた値：月7回まで'),
    'K6 設定タブで夜勤上限を編集すると上の要約が即座に更新される',
  );

  // Step5Rules 内の「人数を直す」で設定タブ内の need が開く
  await page.locator('[data-setup-embed="rules"]').getByRole('button', { name: '人数を直す' }).click();
  await page.waitForTimeout(200);
  record(
    (await page.locator('[data-setup-embed="need"]').count()) === 1,
    'K6 埋め込み内の「人数を直す」で設定タブ内の「毎日の必要人数」が開く',
  );
  await page.locator('[data-setup-row="need"]').getByRole('button', { name: '閉じる' }).click();

  const storageKeysAfter = await page.evaluate(() => Object.keys(localStorage).sort());
  const savedAfterEdit = await page.evaluate(() => JSON.parse(localStorage.getItem('care-setup-v2') || '{}'));
  record(
    JSON.stringify(storageKeysBefore) === JSON.stringify(storageKeysAfter) &&
      savedAfterEdit?.facility?.name === '設定タブ編集苑' &&
      savedAfterEdit?.rules?.nightMax === 7,
    'K6 保存先は care-setup-v2 に1本化され、専用キーが増えない',
  );

  // K6: setup.html 側の表示・値一致確認と比較スクリーンショット撮影
  for (const sp of embedSpecs) {
    await page.goto(`${B}setup.html?step=${sp.step}&from=settings`);
    await page.waitForTimeout(300);
    await shot(page, sp.setupShot);
    if (sp.step === 1) {
      const val = await page.locator('#facility-name').inputValue();
      record(val === '設定タブ編集苑', `K6 setup.html?step=1 に設定タブの施設名が表示される（${val}）`);
    }
    if (sp.step === 5) {
      const val = await page.getByLabel('夜勤の月間上限回数').inputValue();
      record(val === '7', `K6 setup.html?step=5 に設定タブの夜勤上限が表示される（${val}）`);
    }
  }
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith('/setup.html')),
    page.getByRole('button', { name: '設定へ戻る' }).click(),
  ]);
  await page.waitForTimeout(300);

  // K2 & K4: 「職員の画面で見る」で職員画面へ移動
  await page.locator('[data-setup-row="staff"]').getByRole('button', { name: '職員の画面で見る' }).click();
  await page.waitForTimeout(400);
  const peopleText = await page.locator('main').innerText();
  record(
    peopleText.includes('この一覧は仮のデータです。はじめの条件で入れた職員（18人）は、まだここに出ません') &&
      peopleText.includes('職員を直す（はじめの条件）'),
    'K4 設定タブから職員の画面に移動でき、仮データの案内と「職員を直す（はじめの条件）」が出る',
  );
  await checkHorizontalFit(page, 'desktop people');
  await shot(page, '04-people-desktop.png');

  // K4: 職員の画面 → S4 → 職員へ戻る
  await Promise.all([
    page.waitForURL((u) => u.pathname.endsWith('/setup.html')),
    page.getByRole('button', { name: /職員を直す（はじめの条件）/ }).click(),
  ]);
  await page.waitForTimeout(300);
  const fromPeopleS4 = await page.locator('body').innerText();
  const backToPeopleBtn = page.getByRole('button', { name: '職員へ戻る' });
  record(
    fromPeopleS4.includes('職員の一覧') && (await backToPeopleBtn.count()) > 0,
    'K4 「職員を直す（はじめの条件）」で S4 が開き「職員へ戻る」ボタンが出る',
  );
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith('/setup.html')),
    backToPeopleBtn.click(),
  ]);
  await page.waitForTimeout(300);
  const returnedPeopleText = await page.locator('main').innerText();
  record(
    returnedPeopleText.includes('職員を直す（はじめの条件）'),
    'K4 「職員へ戻る」で職員の画面に戻る',
  );

  // K3 & K5: シフト作成 → 使うデータ「設定を開く」・夜勤チェックボックス・守るルール「見る」
  await page.getByRole('button', { name: 'シフト', exact: true }).first().click();
  await page.getByRole('tab', { name: 'シフト作成' }).click();
  await page.waitForTimeout(400);
  const planText = await page.locator('.plan').innerText();
  const ckTitles = await page.locator('.plan .ck-t').allInnerTexts();
  const openSettingsBtn = page.getByRole('button', { name: '設定を開く' });
  record(
    !ckTitles.some((t) => t.includes('必要人数')),
    'K3 作る前の確認に「必要人数」の行は追加していない',
  );
  record(
    (await openSettingsBtn.count()) > 0 &&
      planText.includes('夜勤を月6回までにする') &&
      planText.includes('いつもは月8回'),
    'K3・K5 作る前の確認に「設定を開く」と夜勤上限（今回だけ・既定・入れた値・労務との違い）が出る',
  );
  await checkHorizontalFit(page, 'desktop plan');
  await shot(page, '05-plan-desktop.png');

  // K3: 守るルールの「見る」を開く → 労務を見る / 守ることを見る（設定）
  const seeSummary = page.locator('.plan .ck', { hasText: '守るルール' }).locator('details.ck-more > summary');
  await seeSummary.click();
  await page.waitForTimeout(200);
  const ruleSeeText = await page.locator('.plan .rule-see-list').innerText().catch(() => '');
  record(
    ruleSeeText.includes('労務の目安（警告）') &&
      ruleSeeText.includes('作成の上限') &&
      ruleSeeText.includes('月7回はまだ使っていません'),
    'K3 「守るルール」の「見る」で労務の目安とはじめの条件の「守ること」の両方が出る',
  );
  await shot(page, '12-plan-rule-see-desktop.png');

  // 労務を見る → ブラウザ戻るでシフト作成へ
  await page.getByRole('button', { name: '労務を見る' }).click();
  await page.waitForTimeout(300);
  const laborText = await page.locator('main').innerText();
  record(laborText.includes('連勤は5日まで') && laborText.includes('要確認'), 'K3 「労務を見る」で労務画面へ移動する');
  await page.goBack();
  await page.waitForTimeout(300);
  record((await page.locator('.plan').count()) > 0, 'K3 労務画面からブラウザ「戻る」でシフト作成に戻る');

  // 守ることを見る（設定） → 設定タブの rules が展開状態で開く → ブラウザ戻るでシフト作成へ
  await page.locator('.plan .ck', { hasText: '守るルール' }).locator('details.ck-more > summary').click();
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: '設定を見る' }).click();
  await page.waitForTimeout(300);
  record(
    (await page.locator('[data-setup-embed="rules"]').count()) === 1,
    'K3 「守ることを見る（設定）」で設定タブの「守ること」が開いた状態で表示される',
  );
  await page.goBack();
  await page.waitForTimeout(300);
  record((await page.locator('.plan').count()) > 0, 'K3 設定（守ること）からブラウザ「戻る」でシフト作成に戻る');

  // 「設定を開く」→ ページ遷移せずに設定タブへ → ブラウザ戻る
  await openSettingsBtn.click();
  await page.waitForTimeout(300);
  const movedToSettings = await page.locator('h1.ptitle').innerText().catch(() => '');
  record(
    movedToSettings.trim() === '設定' && !new URL(page.url()).pathname.endsWith('/setup.html'),
    'K3 「設定を開く」でページ遷移せずに設定タブへ移動する',
  );
  await page.goBack();
  await page.waitForTimeout(300);
  record((await page.locator('.plan').count()) > 0, 'K3 ブラウザの「戻る」でシフト作成に戻る');

  await ctx.close();
}

// ============================================================
// 2. モバイル (390x844) 表示・横はみ出しチェック + スクリーンショット
// ============================================================
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  await attachListeners(page, 'mobile390');

  // ?demo 設定タブ
  await page.goto(B + 'setup.html');
  await page.evaluate(() => localStorage.clear());
  await page.goto(B + '?demo&open=settings');
  await page.waitForTimeout(400);
  await checkHorizontalFit(page, 'mobile390 settings-demo');
  await shot(page, '06-settings-demo-390.png');

  // 保存済み 設定タブ
  await page.evaluate((data) => {
    localStorage.setItem('care-setup-v2', JSON.stringify(data));
  }, makeTestSetup(2));
  await page.goto(B + '?open=settings');
  await page.waitForTimeout(400);
  await checkHorizontalFit(page, 'mobile390 settings-saved');
  await shot(page, '07-settings-saved-390.png');

  // K6 390px 展開チェック（S1 / S2 / S3 / S5 + 曜日別表）
  const mobileEmbeds = [
    { key: 'facility', file: '22-settings-embed-s1-390.png' },
    { key: 'shifts', file: '23-settings-embed-s2-390.png' },
    { key: 'need', file: '24-settings-embed-s3-390.png' },
    { key: 'rules', file: '25-settings-embed-s5-390.png' },
  ];
  for (const m of mobileEmbeds) {
    await page.locator(`[data-setup-row="${m.key}"]`).getByRole('button', { name: '直す' }).click();
    await page.waitForTimeout(250);
    await page.locator(`[data-setup-embed="${m.key}"]`).scrollIntoViewIfNeeded();
    await checkHorizontalFit(page, `mobile390 settings-embed-${m.key}`);
    await shot(page, m.file);
    if (m.key === 'need') {
      await page.locator('[data-setup-embed="need"] .need-mode-left label.shift-toggle-label').click();
      await page.waitForTimeout(200);
      await checkHorizontalFit(page, 'mobile390 settings-embed-need-weekday');
      await shot(page, '26-settings-embed-s3-weekday-390.png');
      await page.locator('[data-setup-embed="need"] .need-mode-left label.shift-toggle-label').click();
      await page.waitForTimeout(150);
    }
    await page.locator(`[data-setup-row="${m.key}"]`).getByRole('button', { name: '閉じる' }).click();
    await page.waitForTimeout(150);
  }

  // 職員画面
  await page.locator('[data-setup-row="staff"]').getByRole('button', { name: '職員の画面で見る' }).click();
  await page.waitForTimeout(400);
  await checkHorizontalFit(page, 'mobile390 people');
  await shot(page, '08-people-390.png');

  // シフト作成 & 守るルール「見る」
  await page.getByRole('button', { name: 'シフト', exact: true }).first().click();
  await page.getByRole('tab', { name: 'シフト作成' }).click();
  await page.waitForTimeout(400);
  await checkHorizontalFit(page, 'mobile390 plan');
  await shot(page, '09-plan-390.png');

  await page.locator('.ck-opt').scrollIntoViewIfNeeded();
  await shot(page, '10-plan-nightcap-390.png');

  const mSeeSummary = page.locator('.plan .ck', { hasText: '守るルール' }).locator('details.ck-more > summary');
  await mSeeSummary.scrollIntoViewIfNeeded();
  await mSeeSummary.click();
  await page.waitForTimeout(200);
  await checkHorizontalFit(page, 'mobile390 plan-rule-see');
  await shot(page, '13-plan-rule-see-390.png');

  // setup S4 (?step=4&from=settings)
  await page.goto(B + 'setup.html?step=4&from=settings');
  await page.waitForTimeout(400);
  await checkHorizontalFit(page, 'mobile390 setup-s4');
  await shot(page, '11-setup-s4-390.png');

  await ctx.close();
}

await browser.close();

console.log(`\nスクリーンショット: ${OUT}`);
console.log(`チェック: ${checks.length - ngCount} OK / ${ngCount} NG`);
console.log(`エラー: ${errors.length}件${errors.length ? '\n' + errors.join('\n') : ''}`);
process.exit(ngCount > 0 || errors.length > 0 ? 1 : 0);
