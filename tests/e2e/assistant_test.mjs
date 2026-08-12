import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '../..');
const url = process.env.SHIYI_URL || 'http://127.0.0.1:18743';
const screenshotDir = process.env.SHIYI_SCREENSHOT_DIR || path.join(os.tmpdir(), 'shiyi-test-screenshots');
const mistakeBackupPath = path.join(root, 'tests', '.tmp-mistakes.json');
const knowledgeBackupPath = path.join(root, 'tests', '.tmp-knowledge.json');
fs.mkdirSync(screenshotDir, { recursive: true });

const mockResult = {
  paper: '2026 国考模拟卷一', sourceType: 'text',
  questions: [{ paper: '2026 国考模拟卷一', number: '12', questionType: '言语理解', stem: '原始识别题干', options: ['A. 缘木求鱼', 'B. 因地制宜'], correctAnswer: 'B', userAnswer: 'A', analysis: '应结合方法与目标判断。', reviewNote: '识别语境关系。', tags: ['逻辑填空'] }],
  idioms: [{ term: '缘木求鱼', type: '成语', meaning: '方向或方法不对，不可能达到目的。', distinction: '强调方法与目标相悖。', example: '方法错误仍期待结果，无异于缘木求鱼。', source: '2026 国考模拟卷一' }],
  knowledge: [{ domain: '政治', title: '实事求是', content: '从客观实际出发，理论联系实际。', source: '2026 国考模拟卷一', tags: ['政治理论'] }],
};

const browser = await chromium.launch({ headless: true });
const errors = [];

async function assertNoOverflow(page, label) {
  if (!(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))) throw new Error(`${label} horizontal overflow`);
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const expectedAuthorization = ['Bearer', 'browser-persistent-key'].join(' ');
  const localServiceRequests = [];
  page.on('request', request => { if (/127\.0\.0\.1:8766|localhost:8766/.test(request.url())) localServiceRequests.push(request.url()); });
  page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  await page.route('https://api.deepseek.com/user/balance', route => {
    if (route.request().headers().authorization !== expectedAuthorization) throw new Error('Balance request did not use browser-stored key');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '23.75' }] }) });
  });
  await page.route('https://api.deepseek.com/chat/completions', route => {
    const request = route.request();
    if (request.headers().authorization !== expectedAuthorization) throw new Error('DeepSeek request did not use browser-stored key');
    const payload = request.postDataJSON();
    if (payload.model !== 'deepseek-v4-flash') throw new Error(`Unexpected model: ${payload.model}`);
    return new Promise(resolve => setTimeout(resolve, 2200)).then(() => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify(mockResult) } }],
      usage: { prompt_tokens: 128, completion_tokens: 256, total_tokens: 384 },
    }) }));
  });

  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'AI 整理台', exact: true }).first().click();
  await page.getByText('请填写 DeepSeek API Key', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'AI 用量', exact: true }).waitFor();
  if (await page.locator('.usage-day').count() !== 30) throw new Error('Usage chart did not render 30 daily columns');
  await page.getByRole('button', { name: '填写 Key', exact: true }).click();
  await page.getByLabel('DeepSeek API Key').fill('browser-persistent-key');
  await page.getByRole('button', { name: '保存到浏览器', exact: true }).click();
  const browserCredential = await page.evaluate(async () => {
    const legacy = { local: localStorage.getItem('shiyi-ai-api-key'), session: sessionStorage.getItem('shiyi-ai-api-key') };
    const stored = await new Promise((resolve, reject) => {
      const open = indexedDB.open('shiyi-ai-settings');
      open.onsuccess = () => {
        const request = open.result.transaction('settings').objectStore('settings').get('deepseek-api-key');
        request.onsuccess = () => resolve(request.result?.value || '');
        request.onerror = () => reject(request.error);
      };
      open.onerror = () => reject(open.error);
    });
    return { ...legacy, stored };
  });
  if (browserCredential.local !== null || browserCredential.session !== null || browserCredential.stored !== 'browser-persistent-key') throw new Error('API key was not isolated in browser IndexedDB');
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'AI 整理台', exact: true }).first().click();
  await page.getByText('DeepSeek V4 Flash 已配置', { exact: true }).waitFor();
  await page.locator('.topbar').getByRole('button', { name: '导入资料', exact: true }).click();
  await page.getByLabel(/所属试卷或资料名/).fill('2026 国考模拟卷一');
  await page.getByLabel('题目、复盘笔记或知识材料').fill('请识别这份言语题、成语和政治知识。');
  const analyzeResponsePromise = page.waitForResponse(response => response.url().includes('/chat/completions'));
  await page.getByRole('button', { name: /开始 AI 识别/ }).click();
  await page.getByRole('heading', { name: '正在整理学习资料', exact: true }).waitFor();
  await page.getByRole('progressbar', { name: 'AI 资料整理进度' }).waitFor();
  await page.getByText(/已等待 \d+ 秒/).waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(screenshotDir, 'assistant-processing.png') });
  const analyzeResponse = await analyzeResponsePromise;
  if (!analyzeResponse.ok()) throw new Error(`AI analyze HTTP ${analyzeResponse.status()}: ${await analyzeResponse.text()}`);
  try {
    await page.locator('.draft-card').first().waitFor({ timeout: 10000 });
  } catch {
    const toast = await page.locator('.toast').textContent().catch(() => 'no toast');
    throw new Error(`AI drafts were not rendered after HTTP 200: ${toast}`);
  }
  if (await page.locator('.draft-card').count() !== 3) throw new Error('AI review queue did not contain all routes');
  await page.getByText('128 入 / 256 出', { exact: true }).waitFor();
  const browserUsage = await page.evaluate(async () => new Promise((resolve, reject) => {
    const open = indexedDB.open('shiyi-ai-usage');
    open.onsuccess = () => {
      const request = open.result.transaction('requests').objectStore('requests').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  }));
  if (browserUsage.length !== 1 || browserUsage[0].model !== 'deepseek-v4-flash' || browserUsage[0].totalTokens !== 384) throw new Error('Token usage was not persisted in browser IndexedDB');
  if (localServiceRequests.length) throw new Error(`Frontend still contacted local AI service: ${localServiceRequests.join(', ')}`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await assertNoOverflow(page, 'AI review desk');
  await page.screenshot({ path: path.join(screenshotDir, 'assistant-review.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await assertNoOverflow(page, 'Mobile AI review desk');
  await page.screenshot({ path: path.join(screenshotDir, 'assistant-review-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: '一键全部通过', exact: true }).click();
  await page.getByText('已审核并分类保存 3 项内容', { exact: true }).waitFor();

  await page.getByRole('button', { name: '错题库', exact: true }).first().click();
  await page.locator('.paper-archive-row').first().waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(screenshotDir, 'mistake-papers.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  await assertNoOverflow(page, 'Mobile paper archive');
  await page.screenshot({ path: path.join(screenshotDir, 'mistake-papers-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator('[data-paper-open="2026 国考模拟卷一"]').click();
  await page.locator('.mistake-card').first().waitFor();
  await page.locator('[data-mistake-edit]').click();
  await page.getByLabel('题干').fill('入库后修改的言语理解题干');
  await page.getByLabel('我的复盘批注').fill('错因：忽略转折后的目标条件。下次先圈定逻辑关系。');
  await page.getByLabel('复盘状态').selectOption('复盘中');
  await page.getByLabel('标记为重点错题').check();
  await page.getByRole('button', { name: '保存错题', exact: true }).click();
  try {
    await page.getByText(/错因：忽略转折后的目标条件/).waitFor();
  } catch (error) {
    await page.screenshot({ path: path.join(screenshotDir, 'mistake-save-failure.png'), fullPage: true });
    const state = await page.evaluate(() => ({
      body: document.body.innerText,
      paper: document.querySelector('.paper-detail-heading h2')?.textContent || '',
      cards: [...document.querySelectorAll('.mistake-card')].map(card => card.innerText),
      modalOpen: Boolean(document.querySelector('#mistake-form')),
    }));
    const persisted = await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('shiyi-mistakes');
      open.onsuccess = () => {
        const request = open.result.transaction('questions').objectStore('questions').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      };
      open.onerror = () => reject(open.error);
    }));
    throw new Error(`Mistake was not visible after save: ${JSON.stringify({ state, persisted })}\n${error.message}`);
  }
  if (!(await page.locator('.mistake-card').first().evaluate(element => element.classList.contains('marked')))) throw new Error('Mistake highlight did not persist');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '错题库', exact: true }).first().click();
  await page.locator('[data-paper-open="2026 国考模拟卷一"]').click();
  await page.getByText(/错因：忽略转折后的目标条件/).waitFor();
  await page.getByRole('button', { name: '错题备份', exact: true }).click();
  const mistakeDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出 JSON/ }).click();
  await (await mistakeDownload).saveAs(mistakeBackupPath);
  const mistakeBackup = JSON.parse(fs.readFileSync(mistakeBackupPath, 'utf8'));
  if (mistakeBackup.format !== 'shiyi-mistakes-backup' || mistakeBackup.questions.length !== 1) throw new Error('Invalid mistake backup');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '清空错题库', exact: true }).click();

  await page.getByRole('button', { name: '常识政治', exact: true }).first().click();
  await page.getByRole('heading', { name: '实事求是', exact: true }).waitFor();
  await page.getByRole('button', { name: '成语词语', exact: true }).first().click();
  await page.getByRole('heading', { name: '缘木求鱼', exact: true }).waitFor();
  await page.getByRole('button', { name: '错题库', exact: true }).first().click();
  await page.getByRole('button', { name: '错题备份', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /合并导入/ }).click();
  await (await chooser).setFiles(mistakeBackupPath);
  await page.getByText('已合并导入独立备份', { exact: true }).waitFor();
  await page.locator('[data-paper-open="2026 国考模拟卷一"]').click();
  await page.getByRole('heading', { name: '入库后修改的言语理解题干', exact: true }).waitFor();

  await page.getByRole('button', { name: '常识政治', exact: true }).first().click();
  await page.getByRole('button', { name: '知识备份', exact: true }).click();
  const knowledgeDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出 JSON/ }).click();
  await (await knowledgeDownload).saveAs(knowledgeBackupPath);
  const knowledgeBackup = JSON.parse(fs.readFileSync(knowledgeBackupPath, 'utf8'));
  if (knowledgeBackup.format !== 'shiyi-knowledge-backup' || knowledgeBackup.entries.length !== 1) throw new Error('Invalid knowledge backup');
  await page.getByRole('button', { name: '关闭', exact: true }).click();

  const databases = await page.evaluate(async () => {
    const inspect = name => new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => { resolve({ name, version: request.result.version, stores: [...request.result.objectStoreNames] }); request.result.close(); };
      request.onerror = () => reject(request.error);
    });
    return Promise.all(['shiyi-memory', 'shiyi-idioms', 'shiyi-mistakes', 'shiyi-knowledge', 'shiyi-ai-inbox'].map(inspect));
  });
  const expected = { 'shiyi-memory': 'items', 'shiyi-idioms': 'idioms', 'shiyi-mistakes': 'questions', 'shiyi-knowledge': 'entries', 'shiyi-ai-inbox': 'batches' };
  for (const database of databases) if (database.version !== 1 || database.stores.join(',') !== expected[database.name]) throw new Error(`Database isolation failed for ${database.name}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '错题', exact: true }).click();
  await page.getByRole('heading', { name: '入库后修改的言语理解题干', exact: true }).waitFor();
  await page.waitForTimeout(600);
  await assertNoOverflow(page, 'Mobile assistant');
  await page.screenshot({ path: path.join(screenshotDir, 'assistant-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(600);
  await assertNoOverflow(page, 'Desktop assistant');
  await page.screenshot({ path: path.join(screenshotDir, 'assistant-desktop.png'), fullPage: true });

  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
  console.log('PASS: AI intake, editable routing, mistake annotation, isolated backups, persistence, and responsive layout');
} finally {
  await browser.close();
  for (const file of [mistakeBackupPath, knowledgeBackupPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
}
