import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasConnectionPath,
  canvasItemCenter,
  isCanvasItem,
  loadCanvasItems,
  removeCanvasItems,
} from "../app/canvas-model.ts";

const card = { id: "card-a", type: "rectangle", x: 10, y: 20, text: "Start" };
const note = { id: "note-b", type: "note", x: 240, y: 80, text: "Next" };
const link = { id: "link-a-b", type: "connector", x: 0, y: 0, text: "", from: card.id, to: note.id };

test("validates saved canvas items and rejects malformed connections", () => {
  assert.equal(isCanvasItem(card), true);
  assert.equal(isCanvasItem(link), true);
  assert.equal(isCanvasItem({ ...link, from: link.to, to: link.to }), false);
  assert.equal(isCanvasItem({ ...link, to: undefined }), false);
  assert.equal(isCanvasItem({ ...card, text: "x".repeat(2001) }), false);
});

test("loads legacy connectors and removes links with missing endpoints", () => {
  const legacyConnector = { id: "legacy", type: "connector", x: 40, y: 60, text: "" };
  const loaded = loadCanvasItems([card, note, link, legacyConnector, { ...link, id: "orphan", to: "missing" }]);
  assert.deepEqual(loaded.map(item => item.id), ["card-a", "note-b", "link-a-b", "legacy"]);
  assert.deepEqual(loadCanvasItems({ not: "a board" }), []);
});

test("computes item centers using each shape's dimensions", () => {
  assert.deepEqual(canvasItemCenter(card), { x: 85, y: 66 });
  assert.deepEqual(canvasItemCenter({ ...note, type: "diamond" }), { x: 296, y: 136 });
  assert.deepEqual(canvasItemCenter({ ...note, type: "text" }), { x: 330, y: 98 });
});

test("builds stable curved paths for either horizontal direction", () => {
  const leftToRight = canvasConnectionPath(card, note);
  const rightToLeft = canvasConnectionPath(note, card);
  assert.match(leftToRight, /^M 85 66 C /);
  assert.match(leftToRight, / 315 126$/);
  assert.match(rightToLeft, /^M 315 126 C /);
  assert.match(rightToLeft, / 85 66$/);
});

test("deleting a node also removes every connection attached to it", () => {
  const other = { id: "card-c", type: "rectangle", x: 420, y: 20, text: "Other" };
  const secondLink = { ...link, id: "link-b-c", from: note.id, to: other.id };
  assert.deepEqual(removeCanvasItems([card, note, other, link, secondLink], card.id), [note, other, secondLink]);
  assert.deepEqual(removeCanvasItems([card, note, link], link.id), [card, note]);
});
