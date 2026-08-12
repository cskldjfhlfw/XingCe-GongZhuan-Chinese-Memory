import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const screenshotDir = process.env.SHIYI_SCREENSHOT_DIR || path.join(os.tmpdir(), 'shiyi-test-screenshots');
const memoryBackupPath = path.join(root, 'tests', '.tmp-memory-backup.json');
const idiomBackupPath = path.join(root, 'tests', '.tmp-idiom-backup.json');
const url = process.env.SHIYI_URL || 'http://127.0.0.1:8765';
fs.mkdirSync(screenshotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];

function collectErrors(page, label) {
  page.on('console', message => { if (message.type() === 'error') errors.push(`${label} console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`${label} page: ${error.message}`));
}

async function assertNoOverflow(page, label) {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  if (!fits) throw new Error(`${label} horizontal overflow`);
}

async function importBackup(page, actionName, filePath, confirmation) {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: actionName }).click();
  const chooser = await chooserPromise;
  const confirmationPromise = page.getByText(confirmation, { exact: true }).waitFor();
  await chooser.setFiles(filePath);
  await confirmationPromise;
}

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  collectErrors(desktop, 'desktop');
  await desktop.goto(url);
  await desktop.waitForLoadState('networkidle');
  await desktop.getByText('拾忆', { exact: true }).waitFor();

  const databaseShape = await desktop.evaluate(async () => {
    const inspect = name => new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => {
        const result = { name, version: request.result.version, stores: [...request.result.objectStoreNames] };
        request.result.close();
        resolve(result);
      };
      request.onerror = () => reject(request.error);
    });
    return Promise.all([inspect('shiyi-memory'), inspect('shiyi-idioms')]);
  });
  const memoryDb = databaseShape.find(database => database.name === 'shiyi-memory');
  const idiomDb = databaseShape.find(database => database.name === 'shiyi-idioms');
  if (memoryDb.version !== 1 || memoryDb.stores.join(',') !== 'items') throw new Error('Original memory database schema changed');
  if (idiomDb.version !== 1 || idiomDb.stores.join(',') !== 'idioms') throw new Error('Idiom database is not independent');

  await desktop.getByRole('button', { name: '记忆内容', exact: true }).first().click();
  await desktop.getByRole('button', { name: '新增内容', exact: true }).click();
  await desktop.getByLabel('标题').fill('测试背诵内容');
  await desktop.getByLabel('背诵内容').fill('这是一段用于验证原记忆库兼容、排期和持久化的内容。');
  await desktop.getByRole('button', { name: '生成复习计划' }).click();
  await desktop.getByText('测试背诵内容', { exact: true }).waitFor();

  await desktop.getByRole('button', { name: '成语词语', exact: true }).first().click();
  await desktop.locator('.topbar').getByRole('button', { name: '新增词语', exact: true }).click();
  await desktop.getByLabel('成语或词语').fill('缘木求鱼');
  await desktop.getByLabel('准确释义').fill('方向或方法不对，不可能达到目的。');
  await desktop.getByLabel(/易混辨析/).fill('强调方法与目标相悖。');
  await desktop.getByLabel(/语境例句/).fill('不改进调查方法却希望获得准确结论，无异于缘木求鱼。');
  await desktop.getByLabel(/来源/).fill('2025 国考言语理解');
  await desktop.getByRole('button', { name: '保存词语' }).click();
  await desktop.getByRole('heading', { name: '缘木求鱼', exact: true }).waitFor();
  await desktop.locator('[data-idiom-toggle]').click();
  await desktop.locator('.idiom-card').getByText('已掌握', { exact: true }).waitFor();

  await desktop.reload();
  await desktop.waitForLoadState('networkidle');
  await desktop.getByRole('button', { name: '成语词语', exact: true }).first().click();
  await desktop.getByRole('heading', { name: '缘木求鱼', exact: true }).waitFor();
  await desktop.locator('.idiom-card').filter({ hasText: '缘木求鱼' }).getByText('已掌握', { exact: true }).waitFor({ timeout: 60000 });

  await desktop.getByRole('button', { name: '词语备份', exact: true }).click();
  const idiomDownloadPromise = desktop.waitForEvent('download');
  await desktop.getByRole('button', { name: /导出词语 JSON/ }).click();
  await (await idiomDownloadPromise).saveAs(idiomBackupPath);
  const idiomBackup = JSON.parse(fs.readFileSync(idiomBackupPath, 'utf8'));
  if (idiomBackup.format !== 'shiyi-idiom-backup' || idiomBackup.idioms.length !== 1) throw new Error('Invalid idiom JSON backup');
  if ('items' in idiomBackup || 'reviews' in idiomBackup.idioms[0]) throw new Error('Idiom backup leaked memory schedule data');

  desktop.once('dialog', dialog => dialog.accept());
  await desktop.getByRole('button', { name: '清空全部词语' }).click();
  await desktop.getByRole('button', { name: '记忆内容', exact: true }).first().click();
  await desktop.getByText('测试背诵内容', { exact: true }).waitFor();

  await desktop.getByRole('button', { name: '成语词语', exact: true }).first().click();
  await desktop.getByRole('button', { name: '词语备份', exact: true }).click();
  await importBackup(desktop, /合并导入/, idiomBackupPath, '已合并导入 1 个词语');
  await desktop.getByRole('heading', { name: '缘木求鱼', exact: true }).waitFor();

  await desktop.getByRole('button', { name: '记忆备份', exact: true }).click();
  const memoryDownloadPromise = desktop.waitForEvent('download');
  await desktop.getByRole('button', { name: /^导出 JSON/ }).click();
  await (await memoryDownloadPromise).saveAs(memoryBackupPath);
  const memoryBackup = JSON.parse(fs.readFileSync(memoryBackupPath, 'utf8'));
  if (memoryBackup.format !== 'shiyi-memory-backup' || memoryBackup.items.length !== 1) throw new Error('Original memory JSON backup changed');
  if ('idioms' in memoryBackup || !Array.isArray(memoryBackup.items[0].reviews)) throw new Error('Memory backup format is not isolated');

  desktop.once('dialog', dialog => dialog.accept());
  await desktop.getByRole('button', { name: '清空此浏览器的全部数据' }).click();
  await desktop.getByRole('button', { name: '成语词语', exact: true }).first().click();
  await desktop.getByRole('heading', { name: '缘木求鱼', exact: true }).waitFor();

  await desktop.getByRole('button', { name: '记忆备份', exact: true }).click();
  await importBackup(desktop, /合并导入/, memoryBackupPath, '已合并导入 1 段记忆');
  await desktop.getByRole('button', { name: '记忆内容', exact: true }).first().click();
  await desktop.getByText('测试背诵内容', { exact: true }).waitFor();

  await desktop.getByRole('button', { name: '成语词语', exact: true }).first().click();
  await desktop.getByPlaceholder('搜索词语、释义或辨析').fill('目标相悖');
  await desktop.getByRole('heading', { name: '缘木求鱼', exact: true }).waitFor();
  await desktop.waitForTimeout(600);
  await assertNoOverflow(desktop, 'Desktop');
  await desktop.screenshot({ path: path.join(screenshotDir, 'desktop.png'), fullPage: true });

  await desktop.setViewportSize({ width: 390, height: 844 });
  await desktop.locator('.mobile-nav').waitFor();
  await desktop.locator('.mobile-nav [data-view="idioms"]').click();
  await desktop.getByRole('heading', { name: '言语积累', exact: true }).waitFor();
  await desktop.getByRole('heading', { name: '缘木求鱼', exact: true }).waitFor();
  await desktop.waitForTimeout(600);
  await assertNoOverflow(desktop, 'Mobile');
  await desktop.screenshot({ path: path.join(screenshotDir, 'mobile.png'), fullPage: true });

  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
  console.log('PASS: isolated memory/idiom databases, separate JSON backups, persistence, restore, mastered state, and responsive layout');
} finally {
  await browser.close();
  for (const file of [memoryBackupPath, idiomBackupPath]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
