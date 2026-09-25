// Session journal: finished sessions with notes and an optional audio clip.
// Stored in IndexedDB because audio does not fit in localStorage.

export const DB_NAME = 'sessionPrompter';
export const DB_VERSION = 1;
export const STORE = 'sessions';
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const BACKUP_KIND = 'session-prompter-backup';

let dbPromise = null;

export function openDb(indexedDB = globalThis.indexedDB) {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        tx.oncomplete = () => resolve(result?.result ?? result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
      }),
  );
}

export function listEntries() {
  return run('readonly', (store) => store.getAll()).then((rows) =>
    (rows || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
  );
}

export function putEntry(entry) {
  return run('readwrite', (store) => store.put(entry)).then(() => entry);
}

export function deleteEntry(id) {
  return run('readwrite', (store) => store.delete(id));
}

export function clearEntries() {
  return run('readwrite', (store) => store.clear());
}

/** Ask the browser not to evict our data when storage runs low (best effort). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Build a journal entry from a generated session.
 * @param {object} session  the result of generateSession()
 * @param {{startedAt?: number|null, elapsedMs?: number|null, plannedMs?: number|null, notes?: string, audio?: object|null, id?: string, createdAt?: number}} extra
 */
export function makeEntry(session, extra = {}) {
  const now = Date.now();
  return {
    id: extra.id || `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: extra.createdAt || now,
    startedAt: extra.startedAt ?? null,
    elapsedMs: extra.elapsedMs ?? null,
    plannedMs: extra.plannedMs ?? null,
    categoryLabel: session.categoryLabel || '',
    title: session.title || '',
    prompt: session.prompt || '',
    twist: session.twist || '',
    detail: Array.isArray(session.detail) ? [...session.detail] : [],
    selections: { ...(session.selections || {}) },
    bpm: session.bpm ?? null,
    constraint: session.constraint || '',
    rating: Number.isInteger(extra.rating) && extra.rating >= 1 && extra.rating <= 5 ? extra.rating : null,
    notes: (extra.notes || '').trim(),
    audio: extra.audio || null, // { name, type, size, blob, durationSec? }
  };
}

/** Totals for the top of the journal. */
export function summarize(entries) {
  const byCategory = {};
  let totalMs = 0;
  for (const e of entries) {
    totalMs += e.elapsedMs || 0;
    const key = e.categoryLabel || 'Other';
    byCategory[key] = (byCategory[key] || 0) + 1;
  }
  const rated = entries.filter((e) => e.rating);
  const avgRating = rated.length ? rated.reduce((sum, e) => sum + e.rating, 0) / rated.length : null;
  const last = entries[0] || null;
  const lastByCategory = {};
  for (const e of entries) {
    const key = e.categoryLabel || 'Other';
    if (!lastByCategory[key] || e.createdAt > lastByCategory[key]) lastByCategory[key] = e.createdAt;
  }
  return { count: entries.length, totalMs, byCategory, lastByCategory, last, avgRating, ratedCount: rated.length };
}

export function formatDuration(ms) {
  if (!ms || ms < 60000) return ms ? `${Math.round(ms / 1000)} s` : '0 min';
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A backup contains settings and the journal (without audio, which is too large for JSON). */
export function makeBackup(settings, entries) {
  return {
    kind: BACKUP_KIND,
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
    journal: entries.map((e) => ({
      ...e,
      audio: e.audio ? { name: e.audio.name, type: e.audio.type, size: e.audio.size, omitted: true } : null,
    })),
  };
}

/**
 * Validate a parsed backup file. Returns { settings, journal } or throws.
 * Journal entries are normalised; audio blobs are never restored from a backup.
 */
export function parseBackup(data) {
  if (!data || typeof data !== 'object') throw new Error('Not a backup file');
  const isBackup = data.kind === BACKUP_KIND;
  const looksLikeSettings = data.weights || data.hardware || data.timer;
  if (!isBackup && !looksLikeSettings) throw new Error('Not a Session Prompter backup');
  const settings = isBackup ? data.settings : data;
  const journal = (isBackup && Array.isArray(data.journal) ? data.journal : [])
    .filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && typeof e.prompt === 'string')
    .map((e) => ({
      id: e.id,
      createdAt: Number(e.createdAt) || Date.now(),
      startedAt: Number.isFinite(e.startedAt) ? e.startedAt : null,
      elapsedMs: Number.isFinite(e.elapsedMs) ? e.elapsedMs : null,
      plannedMs: Number.isFinite(e.plannedMs) ? e.plannedMs : null,
      categoryLabel: String(e.categoryLabel || ''),
      title: String(e.title || ''),
      prompt: String(e.prompt || ''),
      twist: String(e.twist || ''),
      detail: Array.isArray(e.detail) ? e.detail.map(String) : [],
      selections: e.selections && typeof e.selections === 'object' ? e.selections : {},
      bpm: Number.isFinite(e.bpm) ? e.bpm : null,
      constraint: String(e.constraint || ''),
      rating: Number.isInteger(e.rating) && e.rating >= 1 && e.rating <= 5 ? e.rating : null,
      notes: String(e.notes || ''),
      // The clip itself never travels in a backup; keep its name so the journal can say so.
      audio:
        e.audio && typeof e.audio === 'object' && e.audio.name
          ? {
              name: String(e.audio.name),
              type: String(e.audio.type || ''),
              size: Number(e.audio.size) || 0,
              omitted: true,
            }
          : null,
    }));
  return { settings: settings && typeof settings === 'object' ? settings : null, journal };
}
