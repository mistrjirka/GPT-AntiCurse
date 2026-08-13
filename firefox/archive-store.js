/* Persistent extension-origin IndexedDB store for conversation backups. */
(function (global) {
  "use strict";

  const DB_NAME = "gpt-anticurse";
  const DB_VERSION = 1;
  const STORE = "conversation-archives";
  let dbPromise = null;

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
    });
    return dbPromise;
  }

  async function withStore(mode, callback) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let result;
      try {
        result = callback(store);
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  async function put(archive) {
    if (!archive || !archive.id) throw new Error("Archive requires an id");
    await withStore("readwrite", (store) => store.put(archive));
    return archive;
  }

  async function get(id) {
    if (!id) return null;
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, "readonly");
      const request = transaction.objectStore(STORE).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
    });
  }

  async function remove(id) {
    if (!id) return;
    await withStore("readwrite", (store) => store.delete(id));
  }

  global.CGArchiveStore = { put, get, remove };
})(typeof globalThis !== "undefined" ? globalThis : this);
