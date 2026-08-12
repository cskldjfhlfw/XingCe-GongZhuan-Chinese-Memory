function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('浏览器存储操作失败'));
  });
}

export function createIndexedDbStore({
  dbName,
  version = 1,
  storeName,
  openError = '无法打开浏览器存储',
  transactionError = '浏览器存储事务失败',
  importError = '导入事务失败',
  sort,
}) {
  let databasePromise;

  function open() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('当前浏览器不支持 IndexedDB'));
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(storeName)) {
            request.result.createObjectStore(storeName, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error(openError));
      });
    }
    return databasePromise;
  }

  async function transaction(mode, operation) {
    const db = await open();
    const tx = db.transaction(storeName, mode);
    const complete = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error(transactionError));
      tx.onabort = () => reject(tx.error || new Error(transactionError));
    });
    try {
      const result = await operation(tx.objectStore(storeName));
      await complete;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Transaction may already be closed. */ }
      throw error;
    }
  }

  async function writeMany(values, clearFirst) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      if (clearFirst) store.clear();
      values.forEach(value => store.put(value));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error(importError));
      tx.onabort = () => reject(tx.error || new Error(importError));
    });
  }

  return {
    async getAll() {
      const values = await transaction('readonly', store => requestResult(store.getAll()));
      return sort ? values.sort(sort) : values;
    },
    put(value) { return transaction('readwrite', store => requestResult(store.put(value))); },
    delete(id) { return transaction('readwrite', store => requestResult(store.delete(id))); },
    clear() { return transaction('readwrite', store => requestResult(store.clear())); },
    import(values, mode) { return writeMany(values, mode === 'replace'); },
    replaceAll(values) { return writeMany(values, true); },
  };
}
