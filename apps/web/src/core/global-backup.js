export const GLOBAL_BACKUP_FORMAT = 'shiyi-global-backup';
export const GLOBAL_BACKUP_VERSION = 1;

// API credentials live in shiyi-ai-settings and are intentionally excluded.
export const GLOBAL_DATA_STORES = Object.freeze([
  { database: 'shiyi-memory', store: 'items' },
  { database: 'shiyi-idioms', store: 'idioms' },
  { database: 'shiyi-mistakes', store: 'questions' },
  { database: 'shiyi-knowledge', store: 'entries' },
  { database: 'shiyi-ai-inbox', store: 'batches' },
  { database: 'shiyi-ai-usage', store: 'requests' },
  { database: 'shiyi-training', store: 'sessions' },
  { database: 'shiyi-pomodoro', store: 'sessions' },
  { database: 'shiyi-pomodoro', store: 'settings' },
  { database: 'shiyi-live-review', store: 'entries' },
  { database: 'shiyi-idiom-graph', store: 'records' },
  { database: 'shiyi-peanut800', store: 'records' },
]);

function requestResult(request, message) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(message));
  });
}

function openDatabase(name, storeNames) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => storeNames.forEach(storeName => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' });
    });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`无法打开 ${name}`));
  });
}

function groupedStores() {
  const grouped = new Map();
  GLOBAL_DATA_STORES.forEach(({ database, store }) => {
    if (!grouped.has(database)) grouped.set(database, []);
    grouped.get(database).push(store);
  });
  return grouped;
}

export function normalizeGlobalBackup(payload) {
  if (!payload || payload.format !== GLOBAL_BACKUP_FORMAT || payload.version !== GLOBAL_BACKUP_VERSION || !Array.isArray(payload.stores)) throw new Error('不是有效的拾忆全局备份文件');
  const allowed = new Set(GLOBAL_DATA_STORES.map(item => `${item.database}/${item.store}`));
  const seen = new Set();
  const stores = payload.stores.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.records)) throw new Error(`第 ${index + 1} 个数据域格式无效`);
    const database = String(entry.database || '');
    const store = String(entry.store || '');
    const key = `${database}/${store}`;
    if (!allowed.has(key) || seen.has(key)) throw new Error(`备份包含未知或重复的数据域：${key}`);
    if (entry.records.length > 50000) throw new Error(`${key} 的记录数量超过限制`);
    if (entry.records.some(record => !record || typeof record !== 'object' || Array.isArray(record))) throw new Error(`${key} 包含无效记录`);
    seen.add(key);
    return { database, store, records: entry.records };
  });
  if (seen.size !== allowed.size) {
    const missing = [...allowed].filter(key => !seen.has(key));
    throw new Error(`全局备份缺少数据域：${missing.join('、')}`);
  }
  return stores;
}

export async function exportGlobalBackup() {
  const stores = [];
  for (const [database, storeNames] of groupedStores()) {
    const db = await openDatabase(database, storeNames);
    try {
      for (const store of storeNames) {
        const tx = db.transaction(store, 'readonly');
        const records = await requestResult(tx.objectStore(store).getAll(), `无法读取 ${database}/${store}`);
        stores.push({ database, store, records });
      }
    } finally { db.close(); }
  }
  return { format: GLOBAL_BACKUP_FORMAT, version: GLOBAL_BACKUP_VERSION, exportedAt: new Date().toISOString(), stores };
}

export async function importGlobalBackup(payload, mode = 'merge') {
  const incoming = normalizeGlobalBackup(payload);
  const incomingMap = new Map(incoming.map(entry => [`${entry.database}/${entry.store}`, entry.records]));
  for (const [database, storeNames] of groupedStores()) {
    const db = await openDatabase(database, storeNames);
    try {
      const tx = db.transaction(storeNames, 'readwrite');
      const completion = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error(`无法导入 ${database}`));
        tx.onabort = () => reject(tx.error || new Error(`导入 ${database} 已取消`));
      });
      storeNames.forEach(storeName => {
        const store = tx.objectStore(storeName);
        if (mode === 'replace') store.clear();
        (incomingMap.get(`${database}/${storeName}`) || []).forEach(record => store.put(record));
      });
      await completion;
    } finally { db.close(); }
  }
}
