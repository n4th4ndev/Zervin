import assert from "node:assert/strict";
import test from "node:test";
import devices from "../electron/devices.cjs";

const { parseSimctlDevices, parseAndroidDevices, androidSdkRoots, DeviceManager, parseWmSize, escapeAdbText } = devices;

test("android screen size and text escaping for input injection", () => {
  assert.deepEqual(parseWmSize("Physical size: 1080x2400\n"), { width: 1080, height: 2400 });
  assert.deepEqual(parseWmSize("Physical size: 1080x2400\nOverride size: 720x1600\n"), { width: 720, height: 1600 });
  assert.equal(parseWmSize("garbage"), null);
  assert.equal(escapeAdbText("hello world & co"), "hello%sworld%s\\&%sco");
});

test("simctl devices are flattened, booted first, newest runtime next", () => {
  const json = { devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [{ udid: "A", name: "iPhone 15", state: "Shutdown", isAvailable: true }, { udid: "B", name: "iPad Air", state: "Shutdown", isAvailable: false }],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [{ udid: "C", name: "iPhone 16 Pro", state: "Booted", isAvailable: true }, { udid: "D", name: "iPhone 16", state: "Shutdown", isAvailable: true }],
    "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [{ udid: "E", name: "Apple Watch Ultra 2 (49mm)", state: "Shutdown", isAvailable: true }],
  } };
  const list = parseSimctlDevices(JSON.stringify(json));
  assert.deepEqual(list.map(item => item.id), ["C", "D", "A", "E"]);
  assert.equal(list[0].runtime, "iOS 18.2");
  assert.equal(list[0].state, "booted");
  assert.equal(list[3].kind, "watch");
  assert.deepEqual(parseSimctlDevices("junk"), []);
});

test("android AVDs are matched to running emulators through their names", () => {
  const list = parseAndroidDevices("INFO | Storing crashdata\nPixel_8_API_35\nPixel_Tablet_API_34\n", "List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_arm64\n", { "emulator-5554": "Pixel_8_API_35" });
  assert.deepEqual(list.map(item => [item.id, item.state, item.serial]), [["Pixel_8_API_35", "booted", "emulator-5554"], ["Pixel_Tablet_API_34", "shutdown", null]]);
  assert.equal(list[0].name, "Pixel 8 API 35");
  assert.equal(list[1].kind, "tablet");
  const unknown = parseAndroidDevices("", "emulator-5556\tdevice\n", {});
  assert.deepEqual(unknown.map(item => [item.id, item.state]), [["emulator-5556", "booted"]]);
});

test("android SDK roots and platform support reasons", async () => {
  assert.deepEqual(androidSdkRoots({ ANDROID_HOME: "/sdk" }, "/Users/me", "darwin"), ["/sdk", "/Users/me/Library/Android/sdk"]);
  const manager = new DeviceManager({ env: {}, home: "/nonexistent", platform: "linux" });
  const support = await manager.support();
  assert.equal(support.ios, false);
  assert.equal(support.android, false);
  assert.match(support.androidReason, /Android SDK not found/);
  await assert.rejects(manager.openUrl("ios", "x", null, "not a url"), /full URL/);
  assert.equal(await manager.simulatorAppPath(), null);
});
