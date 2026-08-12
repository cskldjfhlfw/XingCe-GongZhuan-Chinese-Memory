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
  if (!(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))) {
    throw new Error(`${label} horizontal overflow`);
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => { window.__SHIYI_TRAINING_SPEED__ = 0.2; });
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  await page.goto(url);
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: '工作记忆', exact: true }).click();
  await page.getByRole('heading', { name: '工作记忆训练', exact: true }).waitFor();
  if (await page.locator('.training-game-card').count() !== 3) throw new Error('Training dashboard did not render all games');
  const externalLink = page.getByRole('link', { name: '打开 Free Focus Games（新标签页）' });
  if (await externalLink.getAttribute('href') !== 'https://www.freefocusgames.com/zh/games') throw new Error('Free Focus Games link target is incorrect');
  if (await externalLink.getAttribute('target') !== '_blank' || !String(await externalLink.getAttribute('rel')).includes('noopener')) throw new Error('External training link is missing safe new-tab attributes');
  const trainingFont = await page.locator('.training-header h1').evaluate(element => getComputedStyle(element).fontFamily);
  if (/STSong|SimSun|Georgia/i.test(trainingFont)) throw new Error(`Training page still uses decorative font: ${trainingFont}`);
  await assertNoOverflow(page, 'Training dashboard');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(screenshotDir, 'training-dashboard.png'), fullPage: true });

  const schulteCard = page.locator('.training-game-card.schulte');
  if (await schulteCard.locator('[data-schulte-mode]').count() !== 5) throw new Error('Schulte dynamic mode choices did not render');
  await schulteCard.getByRole('button', { name: '换位', exact: true }).click();
  await schulteCard.getByRole('button', { name: '开始训练', exact: true }).click();
  await page.getByRole('heading', { name: '舒尔特方格', exact: true }).waitFor();
  const firstOrder = await page.locator('.schulte-board button').allTextContents();
  await page.waitForTimeout(450);
  const secondOrder = await page.locator('.schulte-board button').allTextContents();
  if (firstOrder.join(',') === secondOrder.join(',')) throw new Error('Schulte shuffle mode did not refresh number positions');
  const firstCell = page.locator('.schulte-board button').first();
  const backgroundBeforeHover = await firstCell.evaluate(element => getComputedStyle(element).backgroundColor);
  await firstCell.hover();
  if (await firstCell.evaluate(element => getComputedStyle(element).backgroundColor) !== backgroundBeforeHover) throw new Error('Schulte hover still changes cell appearance');
  await page.screenshot({ path: path.join(screenshotDir, 'training-schulte-dynamic.png') });
  await page.keyboard.press('Escape');
  await page.locator('.training-game-card.schulte').getByRole('button', { name: '静态', exact: true }).click();

  const nbackCard = page.locator('.training-game-card.nback');
  await nbackCard.getByRole('button', { name: '挑战', exact: true }).click();
  await nbackCard.getByRole('button', { name: '开始训练', exact: true }).click();
  await page.getByRole('heading', { name: 'N-Back 回溯记忆', exact: true }).waitFor();
  await page.getByText('3-BACK', { exact: true }).waitFor();
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(screenshotDir, 'training-nback.png') });
  await page.keyboard.press('Escape');

  await page.locator('.training-game-card.serial').getByRole('button', { name: '开始训练', exact: true }).click();
  await page.getByRole('heading', { name: '序列相加', exact: true }).waitFor();
  await page.locator('[data-serial-answer]').first().waitFor();
  await page.screenshot({ path: path.join(screenshotDir, 'training-serial.png') });
  await page.keyboard.press('Escape');

  await page.evaluate(() => { window.__SHIYI_TRAINING_SPEED__ = 0.02; });
  await page.locator('.training-game-card.nback').getByRole('button', { name: '开始训练', exact: true }).click();
  await page.getByRole('heading', { name: '工作记忆训练', exact: true }).waitFor({ timeout: 5000 });
  await page.locator('.training-result').filter({ hasText: 'N-Back' }).waitFor();
  await page.locator('.training-record').filter({ hasText: 'N-Back' }).waitFor();

  await page.locator('.training-game-card.schulte').getByRole('button', { name: '开始训练', exact: true }).click();
  await page.getByRole('heading', { name: '舒尔特方格', exact: true }).waitFor();
  await page.locator('[data-schulte-number="1"]').click();
  if (await page.locator('.schulte-board .done, .schulte-board [aria-pressed="true"]').count()) throw new Error('Schulte board exposed already selected numbers');
  for (let value = 2; value <= 16; value += 1) await page.locator(`[data-schulte-number="${value}"]`).click();
  await page.locator('.training-record').filter({ hasText: '舒尔特' }).waitFor();

  await page.locator('.training-game-card.serial').getByRole('button', { name: '开始训练', exact: true }).click();
  await page.getByRole('heading', { name: '序列相加', exact: true }).waitFor();
  await page.getByRole('heading', { name: '工作记忆训练', exact: true }).waitFor({ timeout: 5000 });
  if (await page.locator('.training-record').count() !== 3) throw new Error('Completed sessions were not added to training history');

  const database = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('shiyi-training');
    request.onsuccess = () => {
      const db = request.result;
      const all = db.transaction('sessions').objectStore('sessions').getAll();
      all.onsuccess = () => resolve({ version: db.version, stores: [...db.objectStoreNames], records: all.result });
      all.onerror = () => reject(all.error);
    };
    request.onerror = () => reject(request.error);
  }));
  if (database.version !== 1 || database.stores.join(',') !== 'sessions' || database.records.length !== 3) throw new Error('Training IndexedDB isolation failed');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '工作记忆', exact: true }).click();
  if (await page.locator('.training-record').count() !== 3) throw new Error('Training history did not persist after reload');
  const reloadedNback = page.locator('.training-game-card.nback');
  if ((await reloadedNback.locator('.training-card-stats strong').allTextContents()).some(value => value !== '—')) throw new Error('Beginner N-Back statistics included challenge records');
  await reloadedNback.getByRole('button', { name: '挑战', exact: true }).click();
  if ((await reloadedNback.locator('.training-card-stats strong').first().textContent()) !== '0%') throw new Error('Challenge N-Back statistics did not restore its own record');
  const reloadedSchulte = page.locator('.training-game-card.schulte');
  if ((await reloadedSchulte.locator('.training-card-stats strong').first().textContent()) === '—') throw new Error('Beginner Schulte statistics were not restored');
  await reloadedSchulte.getByRole('button', { name: '挑战', exact: true }).click();
  if ((await reloadedSchulte.locator('.training-card-stats strong').allTextContents()).some(value => value !== '—')) throw new Error('Challenge Schulte statistics included beginner timing records');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  await assertNoOverflow(page, 'Mobile training dashboard');
  await page.screenshot({ path: path.join(screenshotDir, 'training-dashboard-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: '训练', exact: true }).click();

  await page.locator('.training-game-card.nback').getByRole('button', { name: '挑战', exact: true }).click();
  await page.locator('.training-game-card.nback').getByRole('button', { name: '开始训练', exact: true }).click();
  await page.getByText('3-BACK', { exact: true }).waitFor();
  await assertNoOverflow(page, 'Mobile N-Back board');
  await page.screenshot({ path: path.join(screenshotDir, 'training-nback-mobile.png') });
  await page.keyboard.press('Escape');

  await page.locator('.training-game-card.serial').getByRole('button', { name: '挑战', exact: true }).click();
  await page.locator('.training-game-card.serial').getByRole('button', { name: '开始训练', exact: true }).click();
  await page.locator('[data-serial-answer]').first().waitFor();
  await assertNoOverflow(page, 'Mobile serial addition');
  await page.screenshot({ path: path.join(screenshotDir, 'training-serial-mobile.png') });
  await page.keyboard.press('Escape');

  await page.locator('.training-game-card.schulte').getByRole('button', { name: '挑战', exact: true }).click();
  await page.locator('.training-game-card.schulte').getByRole('button', { name: '开始训练', exact: true }).click();
  await assertNoOverflow(page, 'Mobile Schulte board');
  await page.screenshot({ path: path.join(screenshotDir, 'training-schulte-mobile.png') });

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: three training games, difficulty controls, isolated history, persistence, statistics, and responsive layout');
} finally {
  await browser.close();
}
