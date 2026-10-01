// After `next build`: the standalone server needs the static assets (and public/) next to it.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const standalone = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.log("[prepare-standalone] no standalone build, nothing to do");
  process.exit(0);
}
const copy = (from, to) => { if (fs.existsSync(from)) { fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true }); } };
copy(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"));
copy(path.join(root, "public"), path.join(standalone, "public"));
console.log("[prepare-standalone] static assets copied");
