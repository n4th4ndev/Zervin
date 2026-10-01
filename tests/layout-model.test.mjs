import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTile, defaultLayout, dropSideFor, findTile, hasTile, insertBeside, isLayoutNode, mapTiles, moveNode, normalizeLayout, removeNode, split, tile, tiles, updateRatio, updateTile,
} from "../app/layout-model.ts";

function ids(node) { return tiles(node).map(item => item.type + (item.assistant ? ":" + item.assistant : "")); }

test("default layout holds a terminal, the explorer and the editor", () => {
  const layout = defaultLayout();
  assert.deepEqual(ids(layout), ["terminal", "files", "editor"]);
  assert.equal(isLayoutNode(layout), true);
  assert.equal(hasTile(layout, "preview"), false);
});

test("inserting beside a tile creates a split on the requested side", () => {
  const editor = tile("editor");
  const preview = tile("preview");
  const right = insertBeside(editor, editor.id, preview, "right");
  assert.equal(right.kind, "split");
  assert.equal(right.direction, "columns");
  assert.deepEqual(ids(right), ["editor", "preview"]);
  const above = insertBeside(editor, editor.id, preview, "top");
  assert.equal(above.direction, "rows");
  assert.deepEqual(ids(above), ["preview", "editor"]);
  assert.deepEqual(ids(insertBeside(editor, editor.id, preview, "center")), ["preview"]);
  assert.deepEqual(ids(appendTile(null, preview)), ["preview"]);
  assert.deepEqual(ids(appendTile(editor, preview, "bottom")), ["editor", "preview"]);
});

test("removing tiles collapses empty splits", () => {
  const layout = defaultLayout();
  const files = findTile(layout, item => item.type === "files");
  const withoutFiles = removeNode(layout, files.id);
  assert.deepEqual(ids(withoutFiles), ["terminal", "editor"]);
  assert.equal(withoutFiles.kind, "split");
  assert.equal(withoutFiles.children[1].kind, "tile");
  const only = removeNode(removeNode(withoutFiles, withoutFiles.children[0].id), withoutFiles.children[1].id);
  assert.equal(only, null);
});

test("moving a tile re-parents it and dropping on a center swaps tiles", () => {
  const layout = defaultLayout();
  const terminal = findTile(layout, item => item.type === "terminal");
  const editor = findTile(layout, item => item.type === "editor");
  const moved = moveNode(layout, terminal.id, editor.id, "bottom");
  assert.deepEqual(ids(moved), ["files", "editor", "terminal"]);
  const swapped = moveNode(layout, terminal.id, editor.id, "center");
  assert.deepEqual(ids(swapped), ["editor", "files", "terminal"]);
  assert.equal(moveNode(layout, terminal.id, terminal.id, "left"), layout);
  const root = layout;
  assert.equal(moveNode(layout, root.id, editor.id, "left"), layout, "a split cannot be dropped inside itself");
});

test("ratios are clamped and tiles can be updated in place", () => {
  const layout = split("rows", tile("terminal"), tile("canvas"), 0.7);
  assert.equal(updateRatio(layout, layout.id, 0.02).ratio, 0.15);
  assert.equal(updateRatio(layout, layout.id, 0.99).ratio, 0.85);
  const terminal = layout.children[0];
  const renamed = updateTile(layout, terminal.id, { name: "Claude", assistant: "claude" });
  assert.deepEqual(ids(renamed), ["terminal:claude", "canvas"]);
});

test("normalizeLayout drops malformed saved trees but keeps valid parts", () => {
  assert.equal(normalizeLayout({ kind: "tile", id: "x", type: "nope" }), null);
  assert.equal(normalizeLayout("junk"), null);
  const valid = defaultLayout();
  assert.deepEqual(ids(normalizeLayout(JSON.parse(JSON.stringify(valid)))), ids(valid));
  const duplicated = split("columns", tile("editor"), tile("editor"));
  duplicated.children[1] = { ...duplicated.children[1], id: duplicated.children[0].id };
  assert.deepEqual(ids(normalizeLayout(duplicated)), ["editor"]);
  assert.equal(isLayoutNode({ kind: "tile", id: "t", type: "editor", assistant: "claude" }), false, "only terminals host assistants");
});

test("drop side follows the pointer position inside a tile", () => {
  assert.equal(dropSideFor(50, 50, 100, 100), "center");
  assert.equal(dropSideFor(5, 50, 100, 100), "left");
  assert.equal(dropSideFor(95, 50, 100, 100), "right");
  assert.equal(dropSideFor(50, 4, 100, 100), "top");
  assert.equal(dropSideFor(50, 96, 100, 100), "bottom");
});

test("agent tiles keep their worktree folder and branch, and reject relative folders", () => {
  const node = tile("agent", { assistant: "claude", cwd: "/Users/me/app-worktrees/agent/chat-1", branch: "agent/chat-1" });
  const restored = normalizeLayout(JSON.parse(JSON.stringify(node)));
  assert.equal(restored.cwd, "/Users/me/app-worktrees/agent/chat-1");
  assert.equal(restored.branch, "agent/chat-1");
  assert.equal(normalizeLayout({ ...node, cwd: "relative/path" }), null);
  const extension = tile("vscode", { assistant: "codex", cwd: "/tmp/x" });
  assert.equal(normalizeLayout(extension).assistant, "codex");
});

test("mapTiles rewrites tiles in place and drops cleared fields", () => {
  const extension = tile("vscode");
  const codex = tile("vscode", { assistant: "codex" });
  const layout = split("columns", extension, codex);
  const migrated = mapTiles(layout, node => node.type !== "vscode" ? node : !node.assistant ? { ...node, type: "agent", assistant: "claude", name: undefined } : { ...node, type: "terminal", name: "Codex" });
  assert.equal(migrated.id, layout.id);
  assert.deepEqual(tiles(migrated).map(node => [node.id, node.type, node.assistant ?? null, node.name ?? null]), [[extension.id, "agent", "claude", null], [codex.id, "terminal", "codex", "Codex"]]);
  assert.ok(!("name" in tiles(migrated)[0]));
});
