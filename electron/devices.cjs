// iOS simulators (xcrun simctl) and Android emulators (emulator + adb) from inside the IDE.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30000, ...options }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).trim().slice(-1500) || `${command} failed`));
      else resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : String(stdout), stderr: String(stderr) });
    });
  });
}

// `xcrun simctl list devices --json` → flat device list, newest runtimes first.
function parseSimctlDevices(json) {
  let data;
  try { data = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  const devices = [];
  for (const [runtimeId, list] of Object.entries(data?.devices || {})) {
    const runtime = runtimeId.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "").replace(/-/g, " ").replace(/^(\w+) (\d+) (\d+)(?: (\d+))?$/, (_m, os, a, b, c) => `${os} ${a}.${b}${c ? "." + c : ""}`);
    for (const device of Array.isArray(list) ? list : []) {
      if (device.isAvailable === false && !/Booted/.test(device.state || "")) continue;
      devices.push({ platform: "ios", id: device.udid, name: device.name, runtime, state: device.state === "Booted" ? "booted" : device.state === "Shutdown" ? "shutdown" : String(device.state || "").toLowerCase() || "unknown", kind: /iPad/i.test(device.name) ? "tablet" : /Watch/i.test(device.name) ? "watch" : /TV/i.test(device.name) ? "tv" : "phone" });
    }
  }
  const version = runtime => (runtime.match(/(\d+)(?:\.(\d+))?/) || []).slice(1).map(Number).reduce((total, part, index) => total + (part || 0) / Math.pow(1000, index), 0);
  return devices.sort((a, b) => (a.state === "booted" ? -1 : 0) - (b.state === "booted" ? -1 : 0) || version(b.runtime) - version(a.runtime) || a.name.localeCompare(b.name));
}

// `emulator -list-avds` and `adb devices -l` → AVDs with their running state (emulator serial when booted).
function parseAndroidDevices(avdText, adbText, runningNames = {}) {
  const avds = String(avdText || "").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("INFO") && !line.startsWith("WARNING"));
  const serials = String(adbText || "").split("\n").map(line => line.trim()).filter(line => /^emulator-\d+\s+device/.test(line)).map(line => line.split(/\s+/)[0]);
  const nameOf = serial => runningNames[serial] || null;
  const devices = avds.map(avd => { const serial = serials.find(item => nameOf(item) === avd) || null; return { platform: "android", id: avd, name: avd.replace(/_/g, " "), runtime: "Android", state: serial ? "booted" : "shutdown", serial, kind: /tablet|tab/i.test(avd) ? "tablet" : /wear/i.test(avd) ? "watch" : /tv/i.test(avd) ? "tv" : "phone" }; });
  for (const serial of serials) if (!devices.some(device => device.serial === serial)) devices.push({ platform: "android", id: serial, name: nameOf(serial) || serial, runtime: "Android", state: "booted", serial, kind: "phone" });
  return devices.sort((a, b) => (a.state === "booted" ? -1 : 0) - (b.state === "booted" ? -1 : 0) || a.name.localeCompare(b.name));
}

// `adb shell wm size` → { width, height } in pixels.
function parseWmSize(text) {
  const match = String(text || "").match(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g);
  const last = match ? match[match.length - 1].match(/(\d+)x(\d+)/) : null;
  return last ? { width: Number(last[1]), height: Number(last[2]) } : null;
}

// `adb shell input text` needs spaces as %s and shell metacharacters escaped.
function escapeAdbText(text) {
  return String(text).replace(/[\\'"`$&|;<>()!]/g, char => "\\" + char).replace(/ /g, "%s");
}

const androidKeys = { home: "KEYCODE_HOME", back: "KEYCODE_BACK", enter: "KEYCODE_ENTER", delete: "KEYCODE_DEL", tab: "KEYCODE_TAB", space: "KEYCODE_SPACE", up: "KEYCODE_DPAD_UP", down: "KEYCODE_DPAD_DOWN", left: "KEYCODE_DPAD_LEFT", right: "KEYCODE_DPAD_RIGHT", power: "KEYCODE_POWER", volumeUp: "KEYCODE_VOLUME_UP", volumeDown: "KEYCODE_VOLUME_DOWN" };
const idbButtons = { home: "HOME", lock: "LOCK", siri: "SIRI", power: "LOCK" };
const macKeyCodes = { enter: 36, delete: 51, tab: 48, space: 49, up: 126, down: 125, left: 123, right: 124 };

function androidSdkRoots(env = process.env, home = os.homedir(), platform = process.platform) {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, env.ANDROID_SDK];
  if (platform === "darwin") candidates.push(path.join(home, "Library/Android/sdk"));
  if (platform === "linux") candidates.push(path.join(home, "Android/Sdk"));
  if (platform === "win32") candidates.push(path.join(env.LOCALAPPDATA || path.join(home, "AppData/Local"), "Android/Sdk"));
  return [...new Set(candidates.filter(Boolean))];
}

class DeviceManager {
  constructor({ env = process.env, home = os.homedir(), platform = process.platform, log = () => {} } = {}) {
    this.env = env; this.home = home; this.platform = platform; this.log = log;
    this.launching = new Map();
  }

  sdkRoot() { return androidSdkRoots(this.env, this.home, this.platform).find(root => fs.existsSync(root)) || null; }
  adbPath() { const root = this.sdkRoot(); const binary = root && path.join(root, "platform-tools", this.platform === "win32" ? "adb.exe" : "adb"); return binary && fs.existsSync(binary) ? binary : null; }
  emulatorPath() { const root = this.sdkRoot(); const binary = root && path.join(root, "emulator", this.platform === "win32" ? "emulator.exe" : "emulator"); return binary && fs.existsSync(binary) ? binary : null; }
  xcrunAvailable() { return this.platform === "darwin" && fs.existsSync("/usr/bin/xcrun"); }

  async support() {
    let ios = false, iosReason = this.platform === "darwin" ? "Xcode (or its Command Line Tools with a simulator runtime) is not installed." : "iOS simulators need macOS with Xcode.";
    if (this.xcrunAvailable()) { try { await run("xcrun", ["simctl", "help"], { env: this.env }); ios = true; iosReason = ""; } catch (error) { iosReason = "xcrun simctl is not usable: " + error.message.split("\n")[0]; } }
    const androidReason = !this.sdkRoot() ? "Android SDK not found (set ANDROID_HOME or install Android Studio)." : !this.emulatorPath() ? "The Android emulator package is not installed in the SDK." : "";
    return { ios, iosReason, android: Boolean(this.emulatorPath()), androidReason, adb: Boolean(this.adbPath()), sdkRoot: this.sdkRoot(), idb: Boolean(this.idbPath()) };
  }

  async list() {
    const support = await this.support();
    const devices = [];
    let errors = [];
    if (support.ios) {
      try { const { stdout } = await run("xcrun", ["simctl", "list", "devices", "--json"], { env: this.env }); devices.push(...parseSimctlDevices(stdout)); }
      catch (error) { errors.push("iOS: " + error.message); }
    }
    if (support.android) {
      try {
        const [{ stdout: avds }, adb] = await Promise.all([run(this.emulatorPath(), ["-list-avds"], { env: this.env }), this.adbPath() ? run(this.adbPath(), ["devices", "-l"], { env: this.env }).catch(() => ({ stdout: "" })) : { stdout: "" }]);
        const serials = String(adb.stdout).split("\n").map(line => line.trim()).filter(line => /^emulator-\d+\s+device/.test(line)).map(line => line.split(/\s+/)[0]);
        const names = {};
        await Promise.all(serials.map(async serial => { try { const { stdout } = await run(this.adbPath(), ["-s", serial, "emu", "avd", "name"], { env: this.env, timeout: 5000 }); names[serial] = String(stdout).split("\n").map(line => line.trim()).filter(line => line && line !== "OK")[0] || null; } catch { names[serial] = null; } }));
        devices.push(...parseAndroidDevices(avds, adb.stdout, names).map(device => ({ ...device, state: device.state === "shutdown" && this.launching.has(device.id) ? "booting" : device.state })));
      } catch (error) { errors.push("Android: " + error.message); }
    }
    return { support, devices, errors };
  }

  async boot(platform, id) {
    if (platform === "ios") {
      try { await run("xcrun", ["simctl", "boot", id], { env: this.env }); } catch (error) { if (!/current state: Booted|Unable to boot device in current state/.test(error.message)) throw error; }
      // The device is booted; its window is a bonus (the tile mirrors the screen either way).
      await this.openSimulatorApp(id).catch(error => this.log("[devices] " + error.message));
      return true;
    }
    if (platform === "android") {
      const emulator = this.emulatorPath();
      if (!emulator) throw new Error("The Android emulator is not installed.");
      if (this.launching.has(id)) return true;
      const { spawn } = require("node:child_process");
      const child = spawn(emulator, ["-avd", id, "-netdelay", "none", "-netspeed", "full"], { env: this.env, detached: true, stdio: "ignore" });
      child.unref();
      this.launching.set(id, Date.now());
      child.on("exit", () => this.launching.delete(id));
      setTimeout(() => this.launching.delete(id), 120000);
      return true;
    }
    throw new Error("Unknown platform.");
  }

  async shutdown(platform, id, serial) {
    if (platform === "ios") { await run("xcrun", ["simctl", "shutdown", id], { env: this.env }); return true; }
    if (platform === "android") { const adb = this.adbPath(); if (!adb || !serial) throw new Error("adb or the running emulator was not found."); await run(adb, ["-s", serial, "emu", "kill"], { env: this.env }); this.launching.delete(id); return true; }
    throw new Error("Unknown platform.");
  }

  // Simulator.app lives inside Xcode, so `open -a Simulator` fails: resolve it through the selected developer directory.
  async simulatorAppPath() {
    const candidates = [];
    try { const { stdout } = await run("xcode-select", ["-p"], { env: this.env }); const developer = String(stdout).trim(); if (developer) candidates.push(path.join(developer, "Applications", "Simulator.app")); } catch { /* no Xcode */ }
    candidates.push("/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app", "/Applications/Xcode-beta.app/Contents/Developer/Applications/Simulator.app");
    try { for (const entry of fs.readdirSync("/Applications")) if (/^Xcode.*\.app$/.test(entry)) candidates.push(path.join("/Applications", entry, "Contents/Developer/Applications/Simulator.app")); } catch { /* ignore */ }
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (found) return found;
    // Spotlight knows where every copy of Simulator.app is, wherever Xcode was installed.
    try { const { stdout } = await run("mdfind", ["kMDItemCFBundleIdentifier == 'com.apple.iphonesimulator'"], { env: this.env, timeout: 8000 }); const hit = String(stdout).split("\n").map(line => line.trim()).find(line => line.endsWith(".app") && fs.existsSync(line)); if (hit) return hit; } catch { /* Spotlight unavailable */ }
    return null;
  }

  async openSimulatorApp(udid) {
    const app = await this.simulatorAppPath();
    const args = app ? ["-a", app] : ["-b", "com.apple.iphonesimulator"];
    try { await run("open", [...args, ...(udid ? ["--args", "-CurrentDeviceUDID", udid] : [])], { env: this.env }); }
    catch (error) { try { await run("open", args, { env: this.env }); } catch { throw new Error("Simulator.app was not found. Install Xcode and run `xcode-select -s /Applications/Xcode.app` (" + error.message.split("\n")[0] + ")."); } }
    return true;
  }

  async focus(platform) {
    if (this.platform !== "darwin") return false;
    if (platform === "ios") { await this.openSimulatorApp(null).catch(() => {}); return true; }
    await run("open", ["-a", "qemu-system-aarch64"], { env: this.env }).catch(() => {});
    return true;
  }

  // PNG bytes of the device screen.
  async screenshot(platform, id, serial, type = "png") {
    if (platform === "ios") {
      // One file per capture: parallel captures (mirror + "send to Claude") must not delete each other's file.
      this.captureCount = (this.captureCount || 0) + 1;
      const file = path.join(os.tmpdir(), `zevrin-sim-${id}-${process.pid}-${this.captureCount}.${type === "jpeg" ? "jpg" : "png"}`);
      await run("xcrun", ["simctl", "io", id, "screenshot", `--type=${type === "jpeg" ? "jpeg" : "png"}`, file], { env: this.env });
      try { return await fs.promises.readFile(file); } finally { fs.promises.unlink(file).catch(() => {}); }
    }
    if (platform === "android") { const adb = this.adbPath(); if (!adb || !serial) throw new Error("adb or the running emulator was not found."); const { stdout } = await run(adb, ["-s", serial, "exec-out", "screencap", "-p"], { env: this.env, encoding: "buffer" }); return Buffer.from(stdout); }
    throw new Error("Unknown platform.");
  }

  // ----- Touch, keyboard and buttons -----

  idbPath() {
    const candidates = [this.env.ZEVRIN_IDB, "/opt/homebrew/bin/idb", "/usr/local/bin/idb", path.join(this.home, ".local/bin/idb"), path.join(this.home, "Library/Python/3.12/bin/idb"), path.join(this.home, "Library/Python/3.11/bin/idb"), path.join(this.home, "Library/Python/3.13/bin/idb")].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate)) || null;
  }

  // Screen geometry: Android in pixels (what `input` expects), iOS in points (what idb expects) when idb is there.
  async screenInfo(platform, id, serial) {
    const key = platform + ":" + id;
    this.screens = this.screens || new Map();
    if (this.screens.has(key)) return this.screens.get(key);
    let info = null;
    if (platform === "android") { const adb = this.adbPath(); if (adb && serial) { const { stdout } = await run(adb, ["-s", serial, "shell", "wm", "size"], { env: this.env }); info = parseWmSize(stdout); } }
    else if (platform === "ios" && this.idbPath()) {
      try { const { stdout } = await run(this.idbPath(), ["describe", "--udid", id, "--json"], { env: this.env, timeout: 20000 }); const data = JSON.parse(String(stdout)); const screen = data.screen_dimensions || {}; if (screen.width_points && screen.height_points) info = { width: screen.width_points, height: screen.height_points, points: true }; } catch { info = null; }
    }
    if (info) this.screens.set(key, info);
    return info;
  }

  // Sends one input. Coordinates are fractions of the screen (0..1) so the tile never needs the device size.
  async input(platform, id, serial, event) {
    const type = event && event.type;
    if (platform === "android") {
      const adb = this.adbPath();
      if (!adb || !serial) throw new Error("adb or the running emulator was not found.");
      const shell = args => run(adb, ["-s", serial, "shell", "input", ...args], { env: this.env });
      const size = await this.screenInfo(platform, id, serial);
      if (!size && (type === "tap" || type === "swipe")) throw new Error("The emulator screen size could not be read.");
      const px = (x, y) => [Math.round(x * size.width), Math.round(y * size.height)];
      if (type === "tap") { const [x, y] = px(event.x, event.y); await shell(["tap", String(x), String(y)]); return true; }
      if (type === "swipe") { const [x1, y1] = px(event.x1, event.y1); const [x2, y2] = px(event.x2, event.y2); await shell(["swipe", String(x1), String(y1), String(x2), String(y2), String(Math.max(50, Math.min(3000, event.duration || 250)))]); return true; }
      if (type === "text") { if (!event.text) return true; await shell(["text", escapeAdbText(event.text)]); return true; }
      if (type === "key") { const code = androidKeys[event.key]; if (!code) throw new Error("Unknown key."); await shell(["keyevent", code]); return true; }
      throw new Error("Unknown input.");
    }
    if (platform === "ios") {
      const idb = this.idbPath();
      if (idb) {
        const size = await this.screenInfo(platform, id, serial);
        if (!size && (type === "tap" || type === "swipe")) throw new Error("idb could not describe the simulator screen.");
        const pt = (x, y) => [Math.round(x * size.width), Math.round(y * size.height)];
        const ui = args => run(idb, ["ui", ...args, "--udid", id], { env: this.env, timeout: 20000 });
        if (type === "tap") { const [x, y] = pt(event.x, event.y); await ui(["tap", String(x), String(y)]); return true; }
        if (type === "swipe") { const [x1, y1] = pt(event.x1, event.y1); const [x2, y2] = pt(event.x2, event.y2); await ui(["swipe", String(x1), String(y1), String(x2), String(y2), "--duration", String(Math.max(0.05, Math.min(3, (event.duration || 250) / 1000)))]); return true; }
        if (type === "text") { if (!event.text) return true; await ui(["text", event.text]); return true; }
        if (type === "key") { if (idbButtons[event.key]) { await ui(["button", idbButtons[event.key]]); return true; } const code = { enter: 40, delete: 42, tab: 43, space: 44, up: 82, down: 81, left: 80, right: 79 }[event.key]; if (!code) throw new Error("Unknown key."); await ui(["key", String(code)]); return true; }
        throw new Error("Unknown input.");
      }
      // Without idb: drive the Simulator window itself through macOS accessibility (needs Accessibility permission for Zevrin).
      return this.inputThroughSimulatorWindow(id, event);
    }
    throw new Error("Unknown platform.");
  }

  // Mirror loop: screenshots as fast as the tools deliver them (capped at maxFps). Each simctl / adb capture spends
  // most of its time starting up, so several run at once and only frames newer than the last one shown are sent.
  startMirror(key, platform, id, serial, maxFps, onFrame, onError) {
    this.stopMirror(key);
    const state = { stopped: false };
    this.mirrors = this.mirrors || new Map();
    this.mirrors.set(key, state);
    const workers = platform === "ios" ? 3 : 2;
    const interval = 1000 / Math.max(1, maxFps);
    let lastShown = 0;
    let nextSlot = Date.now();
    let failures = 0;
    const worker = async () => {
      while (!state.stopped) {
        // Workers take turns so captures are spread evenly over time.
        const slot = Math.max(Date.now(), nextSlot); nextSlot = slot + interval;
        if (slot > Date.now()) await new Promise(resolve => setTimeout(resolve, slot - Date.now()));
        if (state.stopped) break;
        const started = Date.now();
        try {
          const buffer = await this.screenshot(platform, id, serial, platform === "ios" ? "jpeg" : "png");
          if (state.stopped) break;
          if (started > lastShown) { lastShown = started; onFrame({ mimeType: platform === "ios" ? "image/jpeg" : "image/png", data: buffer.toString("base64"), at: Date.now(), ms: Date.now() - started }); }
          failures = 0;
        } catch (error) { failures += 1; if (failures === 3) onError(error.message); await new Promise(resolve => setTimeout(resolve, Math.min(2000, 200 * failures))); }
      }
    };
    for (let index = 0; index < workers; index += 1) worker();
    return true;
  }

  // Live H.264 stream of the screen: `adb exec-out screenrecord` on Android, `idb video-stream` on iOS when idb is
  // installed. Returns false when no streaming tool is available. screenrecord stops after a few minutes, so it is
  // restarted; the renderer decodes the stream with WebCodecs.
  startStream(key, platform, id, serial, onData, onError) {
    this.stopStream(key);
    let command, args;
    if (platform === "android") { const adb = this.adbPath(); if (!adb || !serial) return false; command = adb; args = ["-s", serial, "exec-out", "screenrecord", "--output-format=h264", "--bit-rate", "12000000", "-"]; }
    else if (platform === "ios") { const idb = this.idbPath(); if (!idb) return false; command = idb; args = ["video-stream", "--udid", id, "--format", "h264", "--fps", "60"]; }
    else return false;
    const state = { stopped: false, child: null };
    this.streams = this.streams || new Map();
    this.streams.set(key, state);
    let quickExits = 0;
    const launch = () => {
      if (state.stopped) return;
      const started = Date.now();
      let stderr = "";
      const child = spawn(command, args, { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
      state.child = child;
      child.stdout.on("data", chunk => { if (!state.stopped) onData(chunk); });
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1500); });
      child.on("error", error => { stderr = error.message; });
      child.on("close", () => {
        if (state.stopped) return;
        quickExits = Date.now() - started < 3000 ? quickExits + 1 : 0;
        if (quickExits >= 3) { this.streams.delete(key); onError(stderr.trim() || "The video stream stopped."); return; }
        setTimeout(launch, 200);
      });
    };
    launch();
    return true;
  }

  stopStream(key) { const state = this.streams?.get(key); if (state) { state.stopped = true; try { state.child?.kill("SIGINT"); } catch { /* gone */ } this.streams.delete(key); } return true; }

  stopMirror(key) { const state = this.mirrors?.get(key); if (state) { state.stopped = true; this.mirrors.delete(key); } return true; }

  // Taps and swipes on the device's own window (what the live window capture shows), given as fractions of the whole
  // window. Real mouse events are posted with CoreGraphics, so drags work without extra tools. Needs Accessibility.
  async windowInput(platform, name, event) {
    if (this.platform !== "darwin") throw new Error("Device window input needs macOS.");
    const osascript = (script, language) => run("osascript", [...(language ? ["-l", language] : []), "-e", script], { env: this.env, timeout: 15000 }).catch(error => { throw new Error(/not allowed assistive access|1002|-25211|-1719/.test(error.message) ? "Allow Zevrin in System Settings → Privacy & Security → Accessibility to control the device window." : error.message); });
    const safe = String(name || "").replace(/["\\]/g, "");
    const processClause = platform === "android" ? 'first process whose name starts with "qemu-system"' : 'process "Simulator"';
    const match = platform === "android" ? 'name of w starts with "Android Emulator"' : `name of w contains "${safe}"`;
    const { stdout } = await osascript(`tell application "System Events"\nset p to ${processClause}\nset frontmost of p to true\nset target to window 1 of p\nrepeat with w in windows of p\nif ${match} then set target to w\nend repeat\nperform action "AXRaise" of target\nreturn (position of target as list) & (size of target as list)\nend tell`);
    const [left, top, width, height] = String(stdout).split(",").map(part => Number(part.trim()));
    if ([left, top, width, height].some(Number.isNaN)) throw new Error(platform === "android" ? "The emulator window was not found." : "The Simulator window was not found.");
    const at = (fx, fy) => [Math.round(left + fx * width), Math.round(top + fy * height)];
    const points = [];
    if (event.type === "tap") { const [x, y] = at(event.x, event.y); points.push([1, x, y, 0], [2, x, y, 0.05]); }
    else if (event.type === "swipe") {
      const [x1, y1] = at(event.x1, event.y1); const [x2, y2] = at(event.x2, event.y2);
      const steps = 16; const pause = Math.max(0.005, (event.duration || 250) / 1000 / steps);
      points.push([1, x1, y1, 0]);
      for (let step = 1; step <= steps; step += 1) points.push([6, Math.round(x1 + (x2 - x1) * step / steps), Math.round(y1 + (y2 - y1) * step / steps), pause]);
      points.push([2, x2, y2, 0.02]);
    } else throw new Error("Unknown input.");
    await new Promise(resolve => setTimeout(resolve, 60));
    const script = `ObjC.import("CoreGraphics");\nfunction post(t,x,y){var e=$.CGEventCreateMouseEvent(null,t,{x:x,y:y},0);$.CGEventPost(0,e);}\n` + points.map(([type, x, y, wait]) => `${wait ? `delay(${wait.toFixed(3)});` : ""}post(${type},${x},${y});`).join("\n");
    await osascript(script, "JavaScript");
    return true;
  }

  async inputThroughSimulatorWindow(udid, event) {
    if (this.platform !== "darwin") throw new Error("Simulator input needs macOS.");
    const type = event && event.type;
    const osascript = script => run("osascript", ["-e", script], { env: this.env, timeout: 15000 }).catch(error => { throw new Error(/not allowed assistive access|1002|-25211/.test(error.message) ? "Allow Zevrin in System Settings → Privacy & Security → Accessibility to control the Simulator, or install idb (brew install idb-companion; pip3 install fb-idb) for precise input." : error.message); });
    await this.openSimulatorApp(udid);
    const bounds = async () => {
      const { stdout } = await osascript('tell application "System Events" to tell process "Simulator"\nset w to window 1\nreturn (position of w as list) & (size of w as list)\nend tell');
      const numbers = String(stdout).split(",").map(part => Number(part.trim()));
      if (numbers.length < 4 || numbers.some(Number.isNaN)) throw new Error("The Simulator window was not found.");
      const [left, top, width, height] = numbers;
      const titleBar = 28;
      return { left, top: top + titleBar, width, height: height - titleBar };
    };
    const at = (fx, fy, box) => [Math.round(box.left + fx * box.width), Math.round(box.top + fy * box.height)];
    if (type === "tap") { const box = await bounds(); const [x, y] = at(event.x, event.y, box); await osascript(`tell application "System Events" to click at {${x}, ${y}}`); return true; }
    if (type === "swipe") {
      const box = await bounds(); const [x1, y1] = at(event.x1, event.y1, box); const [x2, y2] = at(event.x2, event.y2, box);
      // A drag with System Events: press at the start, move in steps, release at the end.
      const steps = 8; const parts = [];
      for (let step = 0; step <= steps; step += 1) { const x = Math.round(x1 + (x2 - x1) * step / steps); const y = Math.round(y1 + (y2 - y1) * step / steps); parts.push(step === 0 ? `mouse down at {${x}, ${y}}` : step === steps ? `mouse up at {${x}, ${y}}` : `mouse move to {${x}, ${y}}`); }
      // System Events has no drag primitive; try Simulator's own keyboard-free path first, else fall back to two clicks.
      try { await run("cliclick", [`dd:${x1},${y1}`, `dm:${x2},${y2}`, `du:${x2},${y2}`], { env: this.env }); return true; } catch { /* cliclick is optional */ }
      await osascript(`tell application "System Events" to click at {${x1}, ${y1}}`);
      throw new Error("Swipes need cliclick (brew install cliclick) or idb; a tap was sent instead.");
    }
    if (type === "text") { if (!event.text) return true; await osascript(`tell application "System Events" to keystroke ${JSON.stringify(event.text)}`); return true; }
    if (type === "key") {
      if (event.key === "home") { await osascript('tell application "System Events" to keystroke "h" using {command down, shift down}'); return true; }
      if (event.key === "lock" || event.key === "power") { await osascript('tell application "System Events" to keystroke "l" using {command down}'); return true; }
      const code = macKeyCodes[event.key]; if (!code) throw new Error("Unknown key.");
      await osascript(`tell application "System Events" to key code ${code}`); return true;
    }
    throw new Error("Unknown input.");
  }

  // ----- Developer tools: logs, appearance, screen recording -----

  // Recent device logs, newest last; errors only when asked, and filtered by text (an app name, a tag).
  async logs(platform, id, serial, { minutes = 2, errorsOnly = false, filter = "", lines = 300 } = {}) {
    let text = "";
    if (platform === "ios") {
      const args = ["simctl", "spawn", id, "log", "show", "--last", `${Math.max(1, Math.min(30, minutes))}m`, "--style", "compact"];
      if (errorsOnly) args.push("--predicate", "messageType == error OR messageType == fault");
      text = String((await run("xcrun", args, { env: this.env, timeout: 60000 })).stdout);
    } else if (platform === "android") {
      const adb = this.adbPath(); if (!adb || !serial) throw new Error("adb or the running emulator was not found.");
      text = String((await run(adb, ["-s", serial, "logcat", "-d", "-v", "time", "-t", String(Math.max(50, Math.min(5000, lines * 4))), ...(errorsOnly ? ["*:E"] : [])], { env: this.env, timeout: 30000 })).stdout);
    } else throw new Error("Unknown platform.");
    const wanted = String(filter || "").toLowerCase();
    const kept = text.split("\n").filter(line => line.trim() && !/^(Timestamp|Filtering the log data|-+ beginning of)/.test(line) && (!wanted || line.toLowerCase().includes(wanted)));
    return kept.slice(-Math.max(20, Math.min(2000, lines))).join("\n");
  }

  async appearance(platform, id, serial, mode) {
    if (platform === "ios") {
      if (mode === "dark" || mode === "light") await run("xcrun", ["simctl", "ui", id, "appearance", mode], { env: this.env });
      return String((await run("xcrun", ["simctl", "ui", id, "appearance"], { env: this.env })).stdout).trim() || "light";
    }
    if (platform === "android") {
      const adb = this.adbPath(); if (!adb || !serial) throw new Error("adb or the running emulator was not found.");
      if (mode === "dark" || mode === "light") await run(adb, ["-s", serial, "shell", "cmd", "uimode", "night", mode === "dark" ? "yes" : "no"], { env: this.env });
      const out = String((await run(adb, ["-s", serial, "shell", "cmd", "uimode", "night"], { env: this.env })).stdout);
      return /yes/i.test(out) ? "dark" : "light";
    }
    throw new Error("Unknown platform.");
  }

  // Screen recording to an .mp4: simctl recordVideo on iOS, screenrecord pulled with adb on Android.
  async startRecording(platform, id, serial, folder) {
    this.recordings = this.recordings || new Map();
    const key = platform + ":" + id;
    if (this.recordings.has(key)) throw new Error("This device is already recording.");
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(folder, `${platform}-${stamp}.mp4`);
    let child;
    if (platform === "ios") child = spawn("xcrun", ["simctl", "io", id, "recordVideo", "--codec=h264", "--force", file], { env: this.env, stdio: "ignore" });
    else if (platform === "android") {
      const adb = this.adbPath(); if (!adb || !serial) throw new Error("adb or the running emulator was not found.");
      child = spawn(adb, ["-s", serial, "shell", "screenrecord", "--bit-rate", "8000000", "/sdcard/zevrin-recording.mp4"], { env: this.env, stdio: "ignore" });
    } else throw new Error("Unknown platform.");
    const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
    this.recordings.set(key, { child, exited, file, serial, startedAt: Date.now() });
    return { file, startedAt: Date.now() };
  }

  async stopRecording(platform, id) {
    const key = platform + ":" + id;
    const recording = this.recordings?.get(key);
    if (!recording) throw new Error("This device is not recording.");
    this.recordings.delete(key);
    const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));
    if (platform === "android") {
      const adb = this.adbPath();
      await run(adb, ["-s", recording.serial, "shell", "pkill", "-INT", "screenrecord"], { env: this.env }).catch(() => {});
      await Promise.race([recording.exited, timeout(5000)]);
      await timeout(600);
      await run(adb, ["-s", recording.serial, "pull", "/sdcard/zevrin-recording.mp4", recording.file], { env: this.env, timeout: 120000 });
      run(adb, ["-s", recording.serial, "shell", "rm", "-f", "/sdcard/zevrin-recording.mp4"], { env: this.env }).catch(() => {});
    } else {
      // simctl finishes writing the movie on SIGINT.
      recording.child.kill("SIGINT");
      await Promise.race([recording.exited, timeout(10000)]);
    }
    if (!fs.existsSync(recording.file)) throw new Error("The recording could not be saved.");
    return { file: recording.file, seconds: Math.round((Date.now() - recording.startedAt) / 1000) };
  }

  stopAllStreams() { for (const key of [...(this.streams?.keys() || [])]) this.stopStream(key); }

  stopAllRecordings() { for (const recording of this.recordings?.values() || []) { try { recording.child.kill("SIGINT"); } catch { /* already gone */ } } this.recordings?.clear(); }

  async openUrl(platform, id, serial, url) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw new Error("Enter a full URL (http://…, myapp://…).");
    if (platform === "ios") { await run("xcrun", ["simctl", "openurl", id, url], { env: this.env }); return true; }
    if (platform === "android") { const adb = this.adbPath(); if (!adb || !serial) throw new Error("adb or the running emulator was not found."); await run(adb, ["-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url], { env: this.env }); return true; }
    throw new Error("Unknown platform.");
  }

  // Installs and launches a built app: .app bundle on iOS (bundle id read from Info.plist), .apk on Android.
  async install(platform, id, serial, filePath) {
    if (platform === "ios") {
      await run("xcrun", ["simctl", "install", id, filePath], { env: this.env });
      try { const { stdout } = await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(filePath, "Info.plist")], { env: this.env }); const bundle = String(stdout).trim(); if (bundle) await run("xcrun", ["simctl", "launch", id, bundle], { env: this.env }); return bundle; } catch { return null; }
    }
    if (platform === "android") { const adb = this.adbPath(); if (!adb || !serial) throw new Error("adb or the running emulator was not found."); await run(adb, ["-s", serial, "install", "-r", filePath], { env: this.env, timeout: 180000 }); return null; }
    throw new Error("Unknown platform.");
  }
}

module.exports = { DeviceManager, parseSimctlDevices, parseAndroidDevices, androidSdkRoots, parseWmSize, escapeAdbText };
