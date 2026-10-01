// Workspace file search used by the Command Center. Walks the project tree, skipping dependency and build folders.
const fs = require("node:fs/promises");
const path = require("node:path");

const ignoredDirectories = new Set([".git", "node_modules", ".next", "dist", "build", "out", "coverage", ".turbo", ".cache", ".DS_Store", "__pycache__", ".venv", "venv", "target", ".idea", ".vscode"]);

// Scores how well `query` matches a relative file path. Higher is better; 0 means no match.
function scoreFileMatch(query, relativePath) {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const haystack = relativePath.toLowerCase();
  const name = path.posix.basename(haystack);
  if (name === needle) return 1000;
  if (name.startsWith(needle)) return 800 - name.length;
  if (name.includes(needle)) return 600 - name.length;
  if (haystack.includes(needle)) return 400 - haystack.length;
  // Subsequence match: every query character appears in order.
  let position = 0;
  let score = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, position);
    if (found === -1) return 0;
    score += found === position ? 3 : 1;
    position = found + 1;
  }
  return Math.max(1, 200 + score - haystack.length);
}

async function walkWorkspace(root, { maxEntries = 25000 } = {}) {
  const files = [];
  const queue = [""];
  let visited = 0;
  while (queue.length > 0 && visited < maxEntries) {
    const relative = queue.shift();
    let entries;
    try { entries = await fs.readdir(path.join(root, relative), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (visited >= maxEntries) break;
      visited += 1;
      if (ignoredDirectories.has(entry.name)) continue;
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  return { files, truncated: visited >= maxEntries };
}

async function searchWorkspaceFiles(root, query, { limit = 40, maxEntries } = {}) {
  const { files } = await walkWorkspace(root, { maxEntries });
  return files
    .map(file => ({ path: file, score: scoreFileMatch(query, file) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(item => ({ path: item.path, name: path.posix.basename(item.path) }));
}

const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf", ".zip", ".gz", ".tar", ".tgz", ".bz2", ".7z", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".mov", ".webm", ".wasm", ".node", ".dylib", ".so", ".dll", ".exe", ".class", ".jar", ".lock", ".map"]);

// Full-text search across the workspace: literal, case-insensitive by default, results grouped in file order.
async function searchWorkspaceText(root, query, { limit = 300, maxEntries, caseSensitive = false, maxFileSize = 1024 * 1024 } = {}) {
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return { matches: [], truncated: false, filesSearched: 0 };
  const { files, truncated } = await walkWorkspace(root, { maxEntries });
  const matches = [];
  let filesSearched = 0;
  for (const file of files) {
    if (binaryExtensions.has(path.posix.extname(file).toLowerCase())) continue;
    let contents;
    try {
      const stat = await fs.stat(path.join(root, file));
      if (!stat.isFile() || stat.size > maxFileSize) continue;
      contents = await fs.readFile(path.join(root, file), "utf8");
    } catch { continue; }
    if (contents.includes("\u0000")) continue;
    filesSearched += 1;
    const haystack = caseSensitive ? contents : contents.toLowerCase();
    if (!haystack.includes(needle)) continue;
    const lines = contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = caseSensitive ? lines[index] : lines[index].toLowerCase();
      let column = line.indexOf(needle);
      while (column >= 0) {
        matches.push({ path: file, line: index + 1, column: column + 1, text: lines[index].trim().slice(0, 240), preview: lines[index].slice(Math.max(0, column - 40), column + needle.length + 60) });
        if (matches.length >= limit) return { matches, truncated: true, filesSearched };
        column = line.indexOf(needle, column + Math.max(1, needle.length));
      }
    }
  }
  return { matches, truncated, filesSearched };
}

module.exports = { ignoredDirectories, scoreFileMatch, walkWorkspace, searchWorkspaceFiles, searchWorkspaceText };
