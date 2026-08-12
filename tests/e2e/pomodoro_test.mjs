import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '../..');
const url = process.env.SHIYI_URL || 'http://127.0.0.1:18743';
const screenshotDir = process.env.SHIYI_SCREENSHOT_DIR || path.join(os.tmpdir(), 'shiyi-test-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const errors = [];

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  if (dimensions.scrollWidth > dimensions.width) throw new Error(`${label} horizontal overflow: ${dimensions.scrollWidth} > ${dimensions.width}`);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => { window.__SHIYI_POMODORO_TEST_MS__ = Number(localStorage.getItem('pomodoro-test-ms') || 900); });
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: '番茄专注', exact: true }).click();
  await page.getByRole('heading', { name: '番茄专注', exact: true }).waitFor();
  if (await page.locator('[data-pomodoro-preset]').count() !== 3) throw new Error('Pomodoro presets did not render');
  await assertNoOverflow(page, 'Desktop Pomodoro');

  const task = page.locator('#pomodoro-task');
  await task.fill('完成资料分析错题复盘');
  await task.blur();
  await page.getByRole('button', { name: '开始专注', exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const pausedTime = await page.locator('.pomodoro-time').textContent();
  await page.waitForTimeout(350);
  if (await page.locator('.pomodoro-time').textContent() !== pausedTime) throw new Error('Paused Pomodoro continued counting down');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByText('完成 25 分钟专注，休息一下', { exact: true }).waitFor({ timeout: 4000 });
  if ((await page.locator('.pomodoro-summary strong').allTextContents())[0] !== '1') throw new Error('Completed focus session was not counted');
  if (await page.locator('.pomodoro-history article').count() !== 1) throw new Error('Completed focus session was not added to history');
  await page.screenshot({ path: path.join(screenshotDir, 'pomodoro-desktop.png'), fullPage: true });

  await page.evaluate(() => {
    localStorage.setItem('pomodoro-test-ms', '30000');
    window.__SHIYI_POMODORO_TEST_MS__ = 30000;
  });
  await page.getByRole('button', { name: '重置', exact: true }).click();
  await page.getByRole('button', { name: '开始专注', exact: true }).click();
  await page.getByRole('button', { name: '今日复习', exact: true }).click();
  await page.locator('.pomodoro-mini').waitFor();
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.locator('.pomodoro-mini').waitFor();
  await page.locator('.pomodoro-mini').click();
  await page.getByRole('heading', { name: '番茄专注', exact: true }).waitFor();
  if (!await page.getByRole('button', { name: '暂停', exact: true }).isVisible()) throw new Error('Running Pomodoro did not restore after reload');

  const database = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('shiyi-pomodoro');
    request.onsuccess = () => {
      const db = request.result;
      const sessions = db.transaction('sessions').objectStore('sessions').getAll();
      sessions.onsuccess = () => resolve({ version: db.version, stores: [...db.objectStoreNames], records: sessions.result });
      sessions.onerror = () => reject(sessions.error);
    };
    request.onerror = () => reject(request.error);
  }));
  if (database.version !== 1 || database.stores.join(',') !== 'sessions,settings' || database.records.length !== 1) throw new Error('Pomodoro IndexedDB isolation failed');

  await page.getByRole('button', { name: '暂停', exact: true }).evaluate(button => button.click());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await assertNoOverflow(page, 'Mobile Pomodoro');
  await page.screenshot({ path: path.join(screenshotDir, 'pomodoro-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '今日', exact: true }).click();
  await page.locator('.pomodoro-mini').waitFor();
  const miniBox = await page.locator('.pomodoro-mini').boundingBox();
  if (!miniBox || miniBox.y + miniBox.height > 768) throw new Error('Mobile mini timer overlaps the bottom navigation');

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: Pomodoro presets, timer lifecycle, persistence, isolated storage, statistics, mini timer, and responsive layout');
} finally {
  await browser.close();
}
