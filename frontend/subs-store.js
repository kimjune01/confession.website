const DB_NAME = "confession.website";
const DB_VERSION = 1;
const STORE_NAME = "subscriptions";

let openPromise = null;

function promisify(request) {
    return new Promise((resolve, reject) => {
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
    });
}

export async function open() {
    if (openPromise) {
        return openPromise;
    }
    openPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.addEventListener("upgradeneeded", () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: "slug_id" });
                store.createIndex("subscribed_at", "subscribed_at", { unique: false });
            }
        });
        req.addEventListener("success", () => resolve(req.result), { once: true });
        req.addEventListener("error", () => reject(req.error), { once: true });
    });
    return openPromise;
}

export async function put(rec) {
    const db = await open();
    await promisify(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(rec));
    await prune();
}

export async function get(slug_id) {
    const db = await open();
    const result = await promisify(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(slug_id));
    return result || null;
}

export async function list() {
    const db = await open();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const records = await promisify(store.getAll());
    return records.sort((a, b) => String(b.subscribed_at).localeCompare(String(a.subscribed_at)));
}

export async function del(slug_id) {
    const db = await open();
    await promisify(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(slug_id));
}

export async function prune(maxEntries = 5) {
    const records = await list();
    const overflow = records.slice(maxEntries);
    for (const record of overflow) {
        await del(record.slug_id);
    }
}
