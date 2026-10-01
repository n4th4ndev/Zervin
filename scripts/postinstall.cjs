// Repairs native pieces that npm installs incompletely on recent Node/macOS setups.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const electronDir = path.join(root, "node_modules", "electron");

function electronInstalled() {
  try {
    const binary = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8");
    return fs.existsSync(path.join(electronDir, "dist", binary));
  } catch {
    return false;
  }
}

function findCachedZip(directory, name, depth = 0) {
  if (depth > 3 || !fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return entryPath;
    if (entry.isDirectory()) {
      const found = findCachedZip(entryPath, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Electron's extract-zip step can exit early with status 0 on Node 26, leaving an empty dist folder.
function repairElectron() {
  if (!fs.existsSync(electronDir) || electronInstalled()) return;
  try { execFileSync(process.execPath, [path.join(electronDir, "install.js")], { stdio: "inherit" }); } catch { /* Fall back to the cached archive below. */ }
  if (electronInstalled() || process.platform !== "darwin") return;

  const { version } = require(path.join(electronDir, "package.json"));
  const zipName = `electron-v${version}-darwin-${process.arch}.zip`;
  const cacheRoot = process.env.electron_config_cache || path.join(os.homedir(), "Library", "Caches", "electron");
  const zipPath = findCachedZip(cacheRoot, zipName);
  if (!zipPath) {
    console.warn(`[postinstall] ${zipName} not found in ${cacheRoot}; Electron may not start.`);
    return;
  }

  const distDir = path.join(electronDir, "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  execFileSync("ditto", ["-x", "-k", zipPath, distDir]);
  const typeDefinitions = path.join(distDir, "electron.d.ts");
  if (fs.existsSync(typeDefinitions)) fs.renameSync(typeDefinitions, path.join(electronDir, "electron.d.ts"));
  fs.writeFileSync(path.join(electronDir, "path.txt"), "Electron.app/Contents/MacOS/Electron");
  console.log(`[postinstall] Extracted Electron ${version} from the local cache.`);
}

// node-pty ships its macOS spawn-helper without the executable bit, which makes pty.spawn fail with posix_spawnp.
function repairNodePty() {
  const prebuilds = path.join(root, "node_modules", "node-pty", "prebuilds");
  if (!fs.existsSync(prebuilds)) return;
  for (const platform of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, platform, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}

repairElectron();
repairNodePty();
