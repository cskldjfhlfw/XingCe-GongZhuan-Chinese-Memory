import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const url = process.env.SHIYI_URL || 'http://127.0.0.1:18743';
const browser = await chromium.launch({ headless: true });
const errors = [];
const screenshotDir = process.env.SHIYI_SCREENSHOT_DIR || path.join(os.tmpdir(), 'shiyi-test-screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://api.deepseek.com/chat/completions', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ seedTags: { semantic: ['风险预防'], sentiment: ['褒义'], object: ['方法措施'], context: ['提出对策'], exam: ['近义替换'] }, suggestions: [{ term: '防患未然', type: '成语', meaning: '在事故发生前采取防范措施。', distinction: '强调在问题发生前主动防范。', example: '完善风险预警机制，做到防患未然。', tags: { semantic: ['风险预防'], sentiment: ['褒义'], object: ['方法措施'], context: ['提出对策'], exam: ['近义替换'] }, relation: { type: 'synonym', reason: '都强调提前预防。', weight: 4 }, confidence: .95 }, { term: '居安思危', type: '成语', meaning: '处在安定环境也要想到可能的危险。', distinction: '更强调保持忧患意识。', example: '发展顺利时仍需居安思危。', tags: { semantic: ['风险预防'], sentiment: ['褒义'], object: ['人物行为'], context: ['提出对策'], exam: ['共同出现'] }, relation: { type: 'co_exam', reason: '常用于风险意识语境对比。', weight: 3 }, confidence: .9 }] }) } }], usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 } }) }));
  await page.route('https://api.deepseek.com/user/balance', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '99.00' }] }) }));
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    const put = (name, storeName, values) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' });
      request.onsuccess = () => { const tx = request.result.transaction(storeName, 'readwrite'); values.forEach(value => tx.objectStore(storeName).put(value)); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); };
      request.onerror = () => reject(request.error);
    });
    const now = new Date().toISOString();
    await put('shiyi-idioms', 'idioms', [{ id: 'seed', term: '未雨绸缪', type: '成语', meaning: '事先做好准备。', distinction: '', example: '工作要未雨绸缪。', source: '测试', mastered: false, createdAt: now, updatedAt: now }]);
    await put('shiyi-ai-settings', 'settings', [{ id: 'deepseek-api-key', value: 'sk-test-graph-key', updatedAt: now }]);
  });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '成语词语', exact: true }).first().click();
  await page.locator('#idiom-overview-graph canvas').first().waitFor();
  await page.waitForTimeout(900);
  await page.locator('[data-graph-open="seed"]').click();
  await page.getByRole('button', { name: 'AI 生成联想词', exact: true }).click();
  await page.getByRole('heading', { name: '审核 AI 联想词', exact: true }).waitFor();
  await page.locator('[data-generation-field="example"]').first().fill('应建立长效机制，真正做到防患未然。');
  await page.getByRole('button', { name: '全部通过', exact: true }).click();
  await page.getByRole('button', { name: '返回词语库', exact: true }).click();
  await page.getByRole('heading', { name: '防患未然', exact: true }).waitFor();
  await page.locator('#idiom-overview-graph canvas').first().waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(screenshotDir, 'idiom-graph-overview-desktop.png'), fullPage: true });
  const paintedPixels = await page.locator('#idiom-overview-graph').evaluate(container => {
    return [...container.querySelectorAll('canvas')].reduce((total, canvas) => {
      if (!canvas.width || !canvas.height) return total;
      const context = canvas.getContext('2d');
      if (!context) return total;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const step = Math.max(4, Math.floor(pixels.length / 8000 / 4) * 4);
      let painted = 0;
      for (let index = 3; index < pixels.length; index += step) {
        if (pixels[index] > 0) painted += 1;
      }
      return total + painted;
    }, 0);
  });
  if (paintedPixels < 20) throw new Error('Knowledge graph canvas has no visible drawing');
  const graphRecords = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('shiyi-idiom-graph');
    request.onsuccess = () => { const db = request.result; const query = db.transaction('records').objectStore('records').getAll(); query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error); };
    request.onerror = () => reject(request.error);
  }));
  if (graphRecords.filter(record => record.kind === 'node_meta').length !== 3) throw new Error('AI tags were not stored independently');
  if (graphRecords.filter(record => record.kind === 'relation').length !== 2) throw new Error('AI relations were not approved');
  if (graphRecords.some(record => record.kind === 'generation_draft')) throw new Error('Approved generation drafts were not cleared');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '词语', exact: true }).click();
  await page.locator('#idiom-overview-graph canvas').first().waitFor();
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(screenshotDir, 'idiom-graph-overview-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error('Mobile idiom graph overflows horizontally');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS: AI idiom associations, independent tags, clustered overview, and mobile layout');
} finally {
  await browser.close();
}
