/* db.js — IndexedDB 封装 + 密码哈希工具 */
const DB = (() => {
  const DB_NAME = 'vault-db';
  const DB_VER = 1;
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return _db.transaction(store, mode).objectStore(store);
  }

  function add(store, value) {
    return new Promise((resolve, reject) => {
      const req = tx(store, 'readwrite').add(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function put(store, value) {
    return new Promise((resolve, reject) => {
      const req = tx(store, 'readwrite').put(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function getAll(store) {
    return new Promise((resolve, reject) => {
      const req = tx(store, 'readonly').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function del(store, id) {
    return new Promise((resolve, reject) => {
      const req = tx(store, 'readwrite').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function clear(store) {
    return new Promise((resolve, reject) => {
      const req = tx(store, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  return { open, add, put, getAll, del, clear };
})();

/* 密码哈希（SHA-256，带静态盐；不支持 subtle 时退化为 FNV 散列） */
const PwdStore = (() => {
  const KEY = 'vault-pwd-hash';
  const SALT = 'calc-vault::salt::';
  const DEFAULT_PWD = '1234';

  async function hash(text) {
    const data = SALT + text;
    if (window.crypto && crypto.subtle) {
      try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) { /* fall through */ }
    }
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < data.length; i++) {
      h1 = Math.imul(h1 ^ data.charCodeAt(i), 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ data.charCodeAt(i), 0x811c9dc5) >>> 0;
    }
    return 'fnv' + h1.toString(16) + h2.toString(16);
  }

  async function ensureInit() {
    if (!localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, await hash(DEFAULT_PWD));
    }
  }

  async function verify(pwd) {
    await ensureInit();
    return (await hash(pwd)) === localStorage.getItem(KEY);
  }

  async function set(pwd) {
    localStorage.setItem(KEY, await hash(pwd));
  }

  return { verify, set, ensureInit };
})();
