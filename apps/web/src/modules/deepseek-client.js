const API_BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-v4-flash';
const INPUT_PRICE = 0.14;
const OUTPUT_PRICE = 0.28;
const SETTINGS_DB = 'shiyi-ai-settings';
const USAGE_DB = 'shiyi-ai-usage';
const SYSTEM_PROMPT = `你是公务员考试学习资料整理助手。阅读用户提供的题目、错题复盘、笔记或图片，并严格分类：
1. questions：可独立作答的题目或错题复盘，题型只能是言语理解、判断推理、数量关系、资料分析、常识判断、申论、其他。
2. idioms：值得用于言语理解逻辑填空积累的成语、实词、关联词。
3. knowledge：值得独立积累的常识或政治知识点，domain 只能是常识或政治。
不要重复同一内容，不要臆造看不清的答案。只输出 JSON 对象：
{"questions":[{"paper":"","number":"","questionType":"","stem":"","options":[],"correctAnswer":"","userAnswer":"","analysis":"","reviewNote":"","tags":[]}],"idioms":[{"term":"","type":"成语","meaning":"","distinction":"","example":"","source":""}],"knowledge":[{"domain":"常识","title":"","content":"","source":"","tags":[]}]}
如果某类没有内容，返回空数组。`;

function openDatabase(name, storeName) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开浏览器 AI 存储'));
  });
}

function createBrowserStore(databaseName, storeName) {
  let databasePromise;
  const database = () => databasePromise ||= openDatabase(databaseName, storeName);
  const transaction = async (mode, operation) => {
    const db = await database();
    const tx = db.transaction(storeName, mode);
    const completion = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('浏览器 AI 存储失败'));
      tx.onabort = () => reject(tx.error || new Error('浏览器 AI 存储已取消'));
    });
    const request = operation(tx.objectStore(storeName));
    const result = request instanceof IDBRequest ? await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('浏览器 AI 存储操作失败'));
    }) : request;
    await completion;
    return result;
  };
  return {
    get: id => transaction('readonly', store => store.get(id)),
    getAll: () => transaction('readonly', store => store.getAll()),
    put: value => transaction('readwrite', store => store.put(value)),
    delete: id => transaction('readwrite', store => store.delete(id)),
  };
}

const settingsStore = createBrowserStore(SETTINGS_DB, 'settings');
const usageStore = createBrowserStore(USAGE_DB, 'requests');

function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function loadApiKey() {
  const entry = await settingsStore.get('deepseek-api-key');
  return String(entry?.value || '');
}

export async function saveApiKey(value) {
  const apiKey = String(value || '').trim();
  if (apiKey.length < 8 || apiKey.length > 512) throw new Error('请输入有效的 DeepSeek API Key');
  await settingsStore.put({ id: 'deepseek-api-key', value: apiKey, updatedAt: new Date().toISOString() });
}

export async function clearApiKey() {
  await settingsStore.delete('deepseek-api-key');
}

export function normalizeUsage(raw) {
  const promptTokens = Number(raw?.prompt_tokens ?? raw?.input_tokens ?? 0) || 0;
  const completionTokens = Number(raw?.completion_tokens ?? raw?.output_tokens ?? 0) || 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(raw?.total_tokens ?? (promptTokens + completionTokens)) || 0,
  };
}

function usageRecord(raw, success = true) {
  const normalized = normalizeUsage(raw);
  const inputCost = normalized.promptTokens * INPUT_PRICE / 1_000_000;
  const outputCost = normalized.completionTokens * OUTPUT_PRICE / 1_000_000;
  return {
    id: createId(), requestId: createId(), requestedAt: new Date().toISOString(), model: MODEL,
    ...normalized, estimatedCost: inputCost + outputCost, currency: 'USD', success, reported: Boolean(raw),
  };
}

function dateKey(date) { return date.toISOString().slice(0, 10); }

export function buildUsageSummary(entries, days = 30) {
  const count = Math.max(1, Math.min(90, Number(days) || 30));
  const now = new Date();
  const dates = Array.from({ length: count }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (count - index - 1));
    return dateKey(date);
  });
  const byDate = new Map(dates.map(date => [date, { date, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, requests: 0 }]));
  const sorted = [...entries].sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
  for (const entry of sorted) {
    const bucket = byDate.get(String(entry.requestedAt || '').slice(0, 10));
    if (!bucket) continue;
    bucket.promptTokens += Number(entry.promptTokens || 0);
    bucket.completionTokens += Number(entry.completionTokens || 0);
    bucket.totalTokens += Number(entry.totalTokens || 0);
    bucket.estimatedCost += Number(entry.estimatedCost || 0);
    bucket.requests += 1;
  }
  const total = values => values.reduce((result, value) => ({
    promptTokens: result.promptTokens + value.promptTokens,
    completionTokens: result.completionTokens + value.completionTokens,
    totalTokens: result.totalTokens + value.totalTokens,
    estimatedCost: result.estimatedCost + value.estimatedCost,
    requests: result.requests + value.requests,
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0, requests: 0 });
  const daily = [...byDate.values()];
  return {
    days: count, currency: 'USD', pricing: { currency: 'USD', inputPerMillion: INPUT_PRICE, outputPerMillion: OUTPUT_PRICE },
    lastRequest: sorted.at(-1) || null, totals7d: total(daily.slice(-7)), totals30d: total(daily), daily,
  };
}

export async function usageSummary(days = 30) {
  return buildUsageSummary(await usageStore.getAll(), days);
}

export async function fetchBalance(apiKey) {
  if (!apiKey) return { supported: true, available: false };
  try {
    const response = await fetch(`${API_BASE}/user/balance`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    if (!response.ok) return { supported: true, available: false, error: `HTTP ${response.status}` };
    const body = await response.json();
    const balances = Array.isArray(body.balance_infos) ? body.balance_infos : [];
    const selected = balances.find(item => item.currency === 'CNY') || balances[0];
    if (!selected) return { supported: true, available: false };
    return { supported: true, available: Boolean(body.is_available), balance: Number(selected.total_balance), currency: selected.currency };
  } catch {
    return { supported: true, available: false, error: '无法连接 DeepSeek 余额接口' };
  }
}

export function parseModelJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); }
  catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('模型没有返回可解析的 JSON');
    return JSON.parse(match[0]);
  }
}

export async function requestDeepSeekJson({ apiKey, systemPrompt, userContent, onProgress, signal }) {
  if (!apiKey) throw new Error('请先填写 DeepSeek API Key');
  checkAborted(signal);
  onProgress?.('已发送至 DeepSeek，正在分析', 46);
  let response;
  try {
    response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({ model: MODEL, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }] }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('无法连接 DeepSeek API，请检查网络或浏览器跨域权限');
  }
  const body = await response.json().catch(() => ({}));
  const usage = usageRecord(body.usage, response.ok);
  await usageStore.put(usage);
  if (!response.ok) throw new Error(body.error?.message || `DeepSeek 调用失败（HTTP ${response.status}）`);
  onProgress?.('已收到结果，正在校验字段', 90);
  return { result: parseModelJson(body.choices?.[0]?.message?.content), usage };
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function checkAborted(signal) {
  if (signal?.aborted) throw new DOMException('操作已取消', 'AbortError');
}

async function extractPdf(file, onProgress, signal) {
  const pdfjs = await import('../vendor/pdf.mjs');
  checkAborted(signal);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;
  const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let index = 1; index <= Math.min(document.numPages, 300); index++) {
    checkAborted(signal);
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str || '').join(' '));
    onProgress?.(`正在解析 PDF（${index}/${Math.min(document.numPages, 300)} 页）`, 10 + Math.round(index / Math.min(document.numPages, 300) * 20));
  }
  return pages.join('\n\n').trim();
}

async function extractDocx(file, signal) {
  if (!globalThis.mammoth?.extractRawText) throw new Error('Word 解析组件未加载');
  const result = await globalThis.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  checkAborted(signal);
  return String(result.value || '').trim();
}

async function prepareFile(file, onProgress, signal) {
  if (!file) return { text: '', imageUrl: '' };
  checkAborted(signal);
  if (file.size > 20 * 1024 * 1024) throw new Error('文件不能超过 20MB');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return { text: '', imageUrl: await readAsDataUrl(file) };
  if (extension === 'txt') return { text: await file.text(), imageUrl: '' };
  if (extension === 'pdf') return { text: await extractPdf(file, onProgress, signal), imageUrl: '' };
  if (extension === 'docx') return { text: await extractDocx(file, signal), imageUrl: '' };
  throw new Error('仅支持 PNG、JPG、WEBP、PDF、DOCX 和 TXT');
}

export async function analyzeWithDeepSeek({ paper, text, file, apiKey, onProgress, signal }) {
  if (!apiKey) throw new Error('请先填写 DeepSeek API Key');
  onProgress?.(file ? '正在读取本地资料' : '正在整理粘贴文字', 8);
  const prepared = await prepareFile(file, onProgress, signal);
  checkAborted(signal);
  onProgress?.('正在组织题目与知识提示', 34);
  const materialText = [String(text || '').trim(), prepared.text].filter(Boolean).join('\n\n').slice(0, 120_000);
  const userContent = [{ type: 'text', text: `资料名称：${String(paper || '').trim() || '未命名资料'}\n\n${materialText || '请识别图片中的学习内容。'}` }];
  if (prepared.imageUrl) userContent.push({ type: 'image_url', image_url: { url: prepared.imageUrl } });
  let response;
  try {
    onProgress?.('已发送至 DeepSeek，正在分析', 46);
    response = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: MODEL, temperature: 0.1, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
      }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new Error('无法连接 DeepSeek API，请检查网络或浏览器跨域权限');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `DeepSeek 调用失败（HTTP ${response.status}）`);
  onProgress?.('已收到结果，正在拆分分类', 90);
  const result = parseModelJson(body.choices?.[0]?.message?.content);
  const usage = usageRecord(body.usage, true);
  await usageStore.put(usage);
  onProgress?.('正在生成可审核草稿', 98);
  return { ...result, paper: String(paper || '').trim(), sourceType: file ? file.name.split('.').pop()?.toLowerCase() : 'text', usage };
}

export const DEEPSEEK_MODEL = MODEL;
