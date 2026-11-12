// Per-origin persistent cache (IndexedDB). Sleipnir offers no cross-site storage to extensions,
// so every site keeps its own copy; falls back to memory when IndexedDB is unavailable.

const DB_NAME = 'slx-shield';
const STORE = 'kv';
const memory = new Map();
let dbPromise = null;

function openDb() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve) => {
            try {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => req.result.createObjectStore(STORE);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
                req.onblocked = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }
    return dbPromise;
}

function run(mode, fn) {
    return openDb().then(
        (db) =>
            new Promise((resolve) => {
                if (!db) return resolve(undefined);
                try {
                    const tx = db.transaction(STORE, mode);
                    const req = fn(tx.objectStore(STORE));
                    tx.oncomplete = () => resolve(req.result);
                    tx.onerror = () => resolve(undefined);
                    tx.onabort = () => resolve(undefined);
                } catch {
                    resolve(undefined);
                }
            }),
    );
}

export async function cacheGet(key) {
    if (memory.has(key)) return memory.get(key);
    const value = await run('readonly', (s) => s.get(key));
    if (value !== undefined) memory.set(key, value);
    return value;
}

export async function cacheSet(key, value) {
    memory.set(key, value);
    await run('readwrite', (s) => s.put(value, key));
}

export async function cacheClear() {
    memory.clear();
    await run('readwrite', (s) => s.clear());
}
