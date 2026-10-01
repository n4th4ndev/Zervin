import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/storage-migration.ts", import.meta.url), "utf8").replace(/\nmigrateStorageKeys\(\);\n?$/, "\n");
const ts = (await import("typescript")).default;
const { migrateStorageKeys } = await import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64"));

function memoryStorage(entries) {
  const map = new Map(Object.entries(entries));
  return { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key), map };
}

test("keys of earlier builds move to the zevrin- prefix without overwriting newer values", () => {
  const old = "blue" + "berry-";
  const storage = memoryStorage({ [old + "projects"]: "[1]", [old + "tiles:/p"]: "{}", [old + "rail"]: "old", "zevrin-rail": "new", other: "x" });
  assert.equal(migrateStorageKeys(storage), 2);
  assert.deepEqual(Object.fromEntries(storage.map), { "zevrin-rail": "new", other: "x", "zevrin-projects": "[1]", "zevrin-tiles:/p": "{}" });
});
