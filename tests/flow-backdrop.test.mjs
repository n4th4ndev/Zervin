import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import Module from "node:module";
import { createRequire } from "node:module";

// Fake Electron: displays, windows with focus / full screen / always-on-top state.
const created = [];
class FakeWindow extends EventEmitter {
  constructor(options = {}) { super(); this.options = options; this.destroyed = false; this.focused = false; this.fullScreen = false; this.onTop = null; this.shown = false; created.push(this); }
  isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  isFocused() { return this.focused; } isFullScreen() { return this.fullScreen; } isMinimized() { return false; }
  getBounds() { return { x: 100, y: 100, width: 1200, height: 800 }; } setSimpleFullScreen(value) { this.simple = value; } setFullScreen(value) { this.fullScreen = value; }
  setAlwaysOnTop(flag, level, relative) { this.onTop = flag ? { level, relative } : null; }
  setIgnoreMouseEvents(value) { this.ignoresMouse = value; } setVisibleOnAllWorkspaces() {}
  loadURL(url) { this.url = url; this.emit("ready-to-show"); } showInactive() { this.shown = true; }
}
const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 } }, { id: 2, bounds: { x: 1512, y: 0, width: 2560, height: 1440 } }];
const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => displays, getDisplayMatching: () => displays[0] });
const originalLoad = Module._load;
Module._load = function (request, ...rest) { return request === "electron" ? { BrowserWindow: FakeWindow, screen } : originalLoad.call(this, request, ...rest); };
const { FlowBackdrop } = createRequire(import.meta.url)("../electron/flow-backdrop.cjs");

test("Flow Mode fills the window's screen and veils the other displays while focused", () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const main = new FakeWindow(); main.focused = true;
  const backdrop = new FlowBackdrop(main);
  backdrop.setEnabled(true);
  const veils = () => created.filter(item => item !== main && !item.destroyed);
  assert.equal(main.simple, true, "simple full screen on macOS");
  assert.deepEqual(veils().map(veil => [veil.options.x, veil.options.width, veil.shown, veil.ignoresMouse, veil.options.focusable]), [[1512, 2560, true, true, false]]);
  assert.equal(main.onTop ?? null, null, "the window is never pinned above other apps");

  main.focused = false; main.emit("blur");
  assert.equal(veils().length, 0);
  assert.equal(main.simple, true, "stays full screen while another app is used");
  main.focused = true; main.emit("focus");
  assert.equal(veils().length, 1);

  backdrop.setEnabled(false);
  assert.equal(veils().length, 0);
  assert.equal(main.simple, false, "leaving Flow Mode restores the window");
  main.emit("focus");
  assert.equal(veils().length, 0, "no veil once Flow Mode is off");
});
