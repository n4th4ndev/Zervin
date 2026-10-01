// Flow Mode: Zevrin takes the whole screen it is on (macOS "simple" full screen: the menu bar and the Dock go away,
// no new Space), and every other display gets a blurred veil so other apps fade out there too. The veils ignore the
// mouse: clicking another app activates it, Zevrin loses the focus and the veils go away until Zevrin is focused.
const { BrowserWindow, screen } = require("electron");

const veilPage = "data:text/html," + encodeURIComponent("<!doctype html><html><body style=\"margin:0;height:100vh;background:rgba(6,6,10,.42)\"></body></html>");

class FlowBackdrop {
  constructor(window) {
    this.window = window;
    this.enabled = false;
    this.veils = [];
    this.onFocus = () => { if (this.enabled) this.show(); };
    this.onBlur = () => this.hide();
    this.onFullScreen = () => { if (this.enabled && this.window.isFocused()) { this.hide(); this.show(); } };
    window.on("focus", this.onFocus);
    window.on("blur", this.onBlur);
    window.on("enter-full-screen", this.onFullScreen);
    window.on("leave-full-screen", this.onFullScreen);
    window.on("minimize", this.onBlur);
    window.on("closed", () => { this.hide(); this.filled = false; });
    this.onDisplays = () => { if (this.veils.length) { this.hide(); this.show(); } };
    screen.on("display-added", this.onDisplays);
    screen.on("display-removed", this.onDisplays);
    screen.on("display-metrics-changed", this.onDisplays);
    window.on("closed", () => { screen.removeListener("display-added", this.onDisplays); screen.removeListener("display-removed", this.onDisplays); screen.removeListener("display-metrics-changed", this.onDisplays); });
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled) this.enterFullScreen(); else this.leaveFullScreen();
    if (this.enabled && this.window.isFocused()) this.show(); else this.hide();
  }

  // Simple full screen on macOS (instant, same Space); regular full screen elsewhere. Native full screen is left alone.
  enterFullScreen() {
    if (this.window.isDestroyed() || this.window.isFullScreen() || this.filled) return;
    if (process.platform === "darwin") this.window.setSimpleFullScreen(true); else this.window.setFullScreen(true);
    this.filled = true;
  }

  leaveFullScreen() {
    if (!this.filled || this.window.isDestroyed()) { this.filled = false; return; }
    if (process.platform === "darwin") this.window.setSimpleFullScreen(false); else this.window.setFullScreen(false);
    this.filled = false;
  }

  show() {
    if (this.veils.length || this.window.isDestroyed() || this.window.isMinimized()) return;
    const mac = process.platform === "darwin";
    // Zevrin itself covers its own display; the veils go on the others.
    const own = screen.getDisplayMatching(this.window.getBounds());
    for (const display of screen.getAllDisplays()) {
      if (own && display.id === own.id) continue;
      const { x, y, width, height } = display.bounds;
      const veil = new BrowserWindow({
        x, y, width, height,
        frame: false, transparent: true, hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false,
        fullscreenable: false, focusable: false, skipTaskbar: true, show: false, enableLargerThanScreen: true,
        backgroundColor: "#00000000",
        ...(mac ? { vibrancy: "fullscreen-ui", visualEffectState: "active", roundedCorners: false } : {}),
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      veil.setIgnoreMouseEvents(true);
      veil.setAlwaysOnTop(true, "floating");
      if (mac) veil.setVisibleOnAllWorkspaces(false);
      this.veils.push(veil);
      veil.once("ready-to-show", () => { if (!veil.isDestroyed() && this.veils.includes(veil)) veil.showInactive(); });
      veil.loadURL(veilPage);
    }
  }

  hide() {
    const veils = this.veils;
    this.veils = [];
    for (const veil of veils) if (!veil.isDestroyed()) veil.destroy();
  }
}

module.exports = { FlowBackdrop };
