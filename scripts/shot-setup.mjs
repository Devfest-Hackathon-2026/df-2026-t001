import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
let stepArg = 'S0';
let baseUrl = 'http://localhost:5173/setup.html';
let suffix = '';
let clickSelector = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) {
    baseUrl = args[++i];
  } else if (args[i] === '--suffix' && args[i + 1]) {
    suffix = args[++i];
  } else if (args[i] === '--click' && args[i + 1]) {
    clickSelector = args[++i];
  } else if (!args[i].startsWith('--') && stepArg === 'S0') {
    stepArg = args[i];
  }
}
const arg = stepArg;
const samplePath = path.join(__dirname, 'setup-sample.json');
const sampleData = JSON.parse(fs.readFileSync(samplePath, 'utf-8'));

const stepIndexMap = {
  S0: 0,
  S1: 1,
  S2: 2,
  S3: 3,
  S4: 4,
  S5: 5,
  S6: 6,
  S7: 7,
};

const targetStepIndex = stepIndexMap[arg] ?? 0;

function makeState() {
  const base = JSON.parse(JSON.stringify(sampleData));
  return {
    currentStep: targetStepIndex,
    facility: base.facility,
    shifts: base.shifts,
    needPerShift: base.needPerShift,
    useWeekdayNeed: base.useWeekdayNeed ?? false,
    needByWeekday: base.needByWeekday ?? {},
    staff: base.staff,
    rules: base.rules,
    carryIn: base.carryIn,
    history: base.history ?? {},
  };
}

const outDir = path.join(__dirname, '..', 'artifacts', 'setup');
fs.mkdirSync(outDir, { recursive: true });

async function run() {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const stateToInject = makeState();
  const stem = suffix ? `${arg}-${suffix}` : arg;

  const targets = [
    { name: `${stem}-desktop.png`, width: 1280, height: 800 },
    { name: `${stem}-tablet.png`, width: 768, height: 1024 },
  ];

  for (const t of targets) {
    const page = await browser.newPage({
      viewport: { width: t.width, height: t.height },
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(`[Console Error] ${msg.text()}`);
      }
    });

    page.on('pageerror', (err) => {
      errors.push(`[Page Error] ${err.message}`);
    });

    // はじめの設定ではシフトを作らない。ソルバーへのリクエストが1件でもあれば失敗にする
    page.on('request', (req) => {
      if (req.url().includes('/api/v1/')) {
        errors.push(`[Unexpected Request] setup がソルバーを呼んでいます: ${req.url()}`);
      }
    });

    await page.goto(baseUrl);
    await page.evaluate((data) => {
      localStorage.clear();
      localStorage.setItem('care-setup-v2', JSON.stringify(data));
    }, stateToInject);

    await page.reload({ waitUntil: 'networkidle' });
    if (clickSelector) {
      await page.click(clickSelector);
    }
    await page.waitForTimeout(400);

    // 全体を1枚に撮るとき、固定のフッターが本文に重ならないようにする
    await page.addStyleTag({ content: '.setup-footer { position: static !important; }' });

    const overflow = await page.evaluate(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }));
    if (overflow.scrollW > overflow.innerW) {
      console.log(`OVERFLOW ${t.name}: scrollWidth=${overflow.scrollW} > innerWidth=${overflow.innerW}`);
    } else {
      console.log(`FIT ${t.name}: scrollWidth=${overflow.scrollW} <= innerWidth=${overflow.innerW}`);
    }

    const outPath = path.join(outDir, t.name);
    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`Saved screenshot: ${outPath}`);
    await page.close();
  }

  await browser.close();

  if (errors.length > 0) {
    console.error('Errors encountered during shot-setup:');
    for (const e of errors) {
      console.error(e);
    }
    process.exit(1);
  } else {
    console.log('No console or page errors detected.');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
