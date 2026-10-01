// One-time migration of the page storage written by earlier builds under their previous key prefix (layouts, recent
// projects, settings, open files, canvases), so they keep working under the zevrin- prefix. Safe to delete later.
const previousPrefix = "blue" + "berry-";

export function migrateStorageKeys(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage) {
  if (!storage) return 0;
  let moved = 0;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key?.startsWith(previousPrefix)));
    for (const key of keys) {
      const next = "zevrin-" + key.slice(previousPrefix.length);
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(next) === null) { storage.setItem(next, value); moved += 1; }
      storage.removeItem(key);
    }
  } catch { /* storage unavailable */ }
  return moved;
}

migrateStorageKeys();
