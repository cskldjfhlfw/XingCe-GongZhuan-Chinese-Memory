import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const url = process.env.SHIYI_URL || 'http://127.0.0.1:18743';
const screenshotDir = process.env.SHIYI_SCREENSHOT_DIR || path.join(os.tmpdir(), 'shiyi-test-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];

async function assertNoOverflow(page, label) {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (size.scrollWidth > size.width) throw new Error(`${label} horizontal overflow: ${size.scrollWidth} > ${size.width}`);
}

const rowFor = (page, label) => page.locator('.live-review-row').filter({ has: page.locator('.live-course-cell strong', { hasText: label }) });

try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  const databasesBefore = await page.evaluate(async () => (await indexedDB.databases()).map(item => item.name).sort());
  await page.getByRole('button', { name: '直播课复习', exact: true }).click();
  await page.getByRole('heading', { name: '直播课复习', exact: true }).waitFor();
  await page.getByRole('button', { name: '生成课次表', exact: true }).click();
  await page.getByLabel('结束课次').fill('6');
  await page.getByLabel('每组课次').fill('2');
  await page.getByRole('button', { name: '生成表格', exact: true }).click();
  await page.locator('.live-course-cell').first().waitFor();

  const labels = await page.locator('.live-course-cell strong').allTextContents();
  if (labels.join(',') !== '1-2,3-4,5-6') throw new Error(`Unexpected generated ranges: ${labels.join(',')}`);

  await rowFor(page, '1-2').getByRole('button', { name: '编辑 1-2' }).click();
  await page.getByLabel('复习内容').fill('资料分析基础与速算');
  await page.getByLabel('备注').fill('重点复看截位直除');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await rowFor(page, '1-2').getByRole('button', { name: '1-2复习次数加一' }).click();
  await rowFor(page, '1-2').getByRole('button', { name: '1-2复习次数加一' }).click();
  await rowFor(page, '1-2').getByRole('button', { name: '1-2复习次数减一' }).click();

  await page.getByRole('button', { name: '插入特殊内容', exact: true }).click();
  await page.getByLabel('特殊内容标题').fill('阶段答疑');
  await page.getByLabel('排序位置').fill('2');
  await page.getByLabel('复习内容').fill('整理直播课集中问题');
  await page.getByLabel('备注').fill('优先复盘老师补充题');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await rowFor(page, '阶段答疑').waitFor();

  const ordered = await page.locator('.live-course-cell strong').allTextContents();
  if (ordered.join(',') !== '1-2,阶段答疑,3-4,5-6') throw new Error(`Special row was not inserted by order: ${ordered.join(',')}`);
  if ((await rowFor(page, '1-2').locator('.live-count-cell strong').textContent()) !== '1') throw new Error('Review count controls failed');
  await assertNoOverflow(page, 'Desktop live review');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(screenshotDir, 'live-review-desktop.png'), fullPage: true });

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '直播课复习', exact: true }).click();
  await rowFor(page, '1-2').waitFor();
  if (!await rowFor(page, '1-2').getByText('资料分析基础与速算', { exact: true }).isVisible()) throw new Error('Edited content did not persist after reload');
  if (!await rowFor(page, '阶段答疑').getByText('优先复盘老师补充题', { exact: true }).isVisible()) throw new Error('Special row did not persist after reload');

  const database = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('shiyi-live-review');
    request.onsuccess = () => {
      const db = request.result;
      const query = db.transaction('entries').objectStore('entries').getAll();
      query.onsuccess = () => resolve({ version: db.version, stores: [...db.objectStoreNames], entries: query.result });
      query.onerror = () => reject(query.error);
    };
    request.onerror = () => reject(request.error);
  }));
  if (database.version !== 1 || database.stores.join(',') !== 'entries' || database.entries.length !== 4) throw new Error('Live review IndexedDB isolation failed');
  const databasesAfter = await page.evaluate(async () => (await indexedDB.databases()).map(item => item.name).sort());
  if (databasesAfter.join(',') !== databasesBefore.join(',')) throw new Error(`Unexpected database changes: ${databasesBefore.join(',')} -> ${databasesAfter.join(',')}`);

  await page.getByRole('button', { name: '独立备份', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出 JSON/ }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const backup = JSON.parse(fs.readFileSync(downloadPath, 'utf8'));
  if (backup.format !== 'shiyi-live-review-backup' || backup.version !== 1 || backup.entries.length !== 4) throw new Error('Exported backup contract is invalid');

  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '独立备份', exact: true }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /合并导入/ }).click();
  const chooser = await chooserPromise;
  backup.entries.push({ id: 'import-check', kind: 'special', label: '导入校验', content: '合并导入内容', reviewCount: 2, notes: '独立备份', order: 99, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await chooser.setFiles({ name: 'live-review-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await rowFor(page, '导入校验').waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await assertNoOverflow(page, 'Mobile live review');
  const toolbarButtons = await page.locator('.live-review-toolbar button').evaluateAll(buttons => buttons.map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
  if (toolbarButtons.some(button => button.width < 120 || button.height < 40)) throw new Error('Mobile live review controls are too small');
  await page.screenshot({ path: path.join(screenshotDir, 'live-review-mobile.png'), fullPage: true });

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: live review generation, editing, ordering, counting, persistence, isolated backup, import, and responsive layout');
} finally {
  await browser.close();
}
