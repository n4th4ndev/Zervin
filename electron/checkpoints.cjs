// Checkpoints of a project, taken before each agent turn, so its changes can be reviewed hunk by hunk and undone.
// Snapshots live in a "shadow" Git repository in the app data folder (one per project, keyed by its path) whose work
// tree is the project: the project's own repository, branches and index are never touched, and folders without Git
// work too. The project's .gitignore files are honored and heavy folders are excluded by default.
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const defaultExcludes = ["node_modules/", ".next/", "dist/", "build/", "out/", ".turbo/", ".cache/", "coverage/", "DerivedData/", "Pods/", ".gradle/", ".venv/", "venv/", "__pycache__/", "*.log", ".DS_Store"];
const identity = { GIT_AUTHOR_NAME: "Zevrin", GIT_AUTHOR_EMAIL: "checkpoints@zevrin.local", GIT_COMMITTER_NAME: "Zevrin", GIT_COMMITTER_EMAIL: "checkpoints@zevrin.local" };

function git(args, { gitDir, workTree, input, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", [...(gitDir ? ["--git-dir=" + gitDir] : []), ...(workTree ? ["--work-tree=" + workTree] : []), ...args], { cwd: workTree || undefined, env: { ...process.env, ...identity, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().split("\n").slice(-3).join("\n")));
      else resolve(String(stdout));
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

// Unified diff (git diff) → files with their hunks.
function parseUnifiedDiff(text) {
  const files = [];
  let file = null, hunk = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = { path: match ? match[2] : line.slice(11), status: "modified", binary: false, additions: 0, deletions: 0, header: [line], hunks: [] };
      files.push(file); hunk = null; continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith("new file mode")) file.status = "added";
      else if (line.startsWith("deleted file mode")) file.status = "deleted";
      else if (line.startsWith("Binary files")) file.binary = true;
      if (!line.startsWith("@@")) { if (line) file.header.push(line); continue; }
    }
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (range) {
      hunk = { header: line, oldStart: Number(range[1]), oldLines: range[2] === undefined ? 1 : Number(range[2]), newStart: Number(range[3]), newLines: range[4] === undefined ? 1 : Number(range[4]), context: range[5].trim(), lines: [] };
      file.hunks.push(hunk); continue;
    }
    if (hunk && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\"))) {
      hunk.lines.push(line);
      if (line.startsWith("+")) file.additions += 1; else if (line.startsWith("-")) file.deletions += 1;
    }
  }
  return files;
}

// A patch holding a single hunk of a file, for `git apply`.
function hunkPatch(file, index) {
  const hunk = file.hunks[index];
  if (!hunk) throw new Error("That change no longer exists; refresh the review.");
  return [...file.header, hunk.header, ...hunk.lines].join("\n") + "\n";
}

class CheckpointStore {
  constructor({ dataDir }) { this.dataDir = dataDir; this.ready = new Map(); this.locks = new Map(); }

  gitDirFor(root) { return path.join(this.dataDir, crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 16) + ".git"); }

  // One operation at a time per project: the shadow index is shared.
  serial(root, work) {
    const previous = this.locks.get(root) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.locks.set(root, next.catch(() => {}));
    return next;
  }

  async ensure(root) {
    const gitDir = this.gitDirFor(root);
    if (this.ready.get(root) === gitDir) return gitDir;
    if (!fs.existsSync(path.join(gitDir, "HEAD"))) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      await git(["init", "--quiet", "--bare", gitDir]);
      await git(["config", "core.bare", "false"], { gitDir });
      await git(["config", "core.autocrlf", "false"], { gitDir });
      await git(["config", "gc.auto", "0"], { gitDir });
      fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
      fs.writeFileSync(path.join(gitDir, "info", "exclude"), defaultExcludes.join("\n") + "\n");
      fs.writeFileSync(path.join(gitDir, "zevrin-root"), path.resolve(root) + "\n");
    }
    this.ready.set(root, gitDir);
    return gitDir;
  }

  // The tree of the project as it is now.
  async currentTree(root, gitDir) {
    await git(["add", "--all", "--ignore-errors", "."], { gitDir, workTree: root }).catch(async error => { if (!/ignored|warning/i.test(error.message)) throw error; });
    return (await git(["write-tree"], { gitDir, workTree: root })).trim();
  }

  create(root, label = "") {
    return this.serial(root, async () => {
      const gitDir = await this.ensure(root);
      const tree = await this.currentTree(root, gitDir);
      const commit = (await git(["commit-tree", tree, "-m", label ? String(label).slice(0, 200) : "checkpoint"], { gitDir })).trim();
      await git(["update-ref", "refs/checkpoints/" + Date.now() + "-" + commit.slice(0, 8), commit], { gitDir });
      return { id: commit, tree, at: Date.now() };
    });
  }

  async diffText(root, gitDir, id, file) {
    const tree = await this.currentTree(root, gitDir);
    return git(["diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", id, tree, ...(file ? ["--", file] : [])], { gitDir, workTree: root });
  }

  // Everything that changed in the project since the checkpoint.
  changes(root, id) {
    return this.serial(root, async () => {
      const gitDir = await this.ensure(root);
      const files = parseUnifiedDiff(await this.diffText(root, gitDir, id));
      return files.map(file => ({ path: file.path, status: file.status, binary: file.binary, additions: file.additions, deletions: file.deletions, hunks: file.hunks.map(hunk => ({ header: hunk.header, oldStart: hunk.oldStart, newStart: hunk.newStart, context: hunk.context, lines: hunk.lines })) }));
    });
  }

  // Puts one file back as it was at the checkpoint (restores it, or deletes it when the agent created it).
  async restoreFile(root, gitDir, id, file) {
    const target = path.resolve(root, file);
    if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("Invalid path.");
    const existed = (await git(["ls-tree", "--name-only", id, "--", file], { gitDir, workTree: root })).trim() !== "";
    if (!existed) { await fs.promises.rm(target, { force: true }); return; }
    const content = await new Promise((resolve, reject) => execFile("git", ["--git-dir=" + gitDir, "cat-file", "blob", `${id}:${file}`], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
  }

  revertFile(root, id, file) {
    return this.serial(root, async () => { const gitDir = await this.ensure(root); await this.restoreFile(root, gitDir, id, file); return true; });
  }

  // Undoes one hunk of a file in the project (the rest of the agent's changes stay).
  revertHunk(root, id, file, index) {
    return this.serial(root, async () => {
      const gitDir = await this.ensure(root);
      const [parsed] = parseUnifiedDiff(await this.diffText(root, gitDir, id, file));
      if (!parsed) throw new Error("This file has no changes any more.");
      if (parsed.status !== "modified" || parsed.hunks.length === 1) { await this.restoreFile(root, gitDir, id, file); return true; }
      await git(["apply", "--reverse", "--whitespace=nowarn", "-"], { gitDir, workTree: root, input: hunkPatch(parsed, index) });
      return true;
    });
  }

  // Puts the whole project back as it was at the checkpoint.
  restore(root, id) {
    return this.serial(root, async () => {
      const gitDir = await this.ensure(root);
      const files = parseUnifiedDiff(await this.diffText(root, gitDir, id));
      for (const file of files) await this.restoreFile(root, gitDir, id, file.path);
      return files.length;
    });
  }
}

module.exports = { CheckpointStore, parseUnifiedDiff, hunkPatch, defaultExcludes };
