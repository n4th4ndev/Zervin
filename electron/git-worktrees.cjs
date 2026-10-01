function parseGitWorktrees(output, currentPath) {
  const worktrees = [];
  let entry = {};

  const push = () => {
    if (!entry.path) return;
    worktrees.push({
      path: entry.path,
      branch: entry.branch || null,
      detached: entry.detached === true,
      bare: entry.bare === true,
      locked: entry.locked === true,
      prunable: entry.prunable === true,
      current: entry.path === currentPath,
    });
    entry = {};
  };

  for (const line of String(output).split(/\r?\n/)) {
    if (!line) { push(); continue; }
    if (line.startsWith("worktree ")) entry.path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) entry.branch = line.slice("branch refs/heads/".length);
    else if (line === "detached") entry.detached = true;
    else if (line === "bare") entry.bare = true;
    else if (line === "locked" || line.startsWith("locked ")) entry.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) entry.prunable = true;
  }
  push();
  return worktrees;
}

const lines = text => String(text || "").split("\n").filter(Boolean).length;

// Summary of an agent's worktree against the project's current branch. `git(cwd, args)` runs git and resolves stdout.
async function worktreeSummary(git, cwd, worktreePath, branch) {
  const dirty = lines(await git(worktreePath, ["status", "--porcelain"]).catch(() => ""));
  const ahead = Number(String(await git(cwd, ["rev-list", "--count", `HEAD..${branch}`]).catch(() => "0")).trim()) || 0;
  const stat = String(await git(cwd, ["diff", "--shortstat", `HEAD...${branch}`]).catch(() => "")).trim();
  const target = String(await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD")).trim();
  return { dirty, ahead, stat, target };
}

// Ends an agent's worktree: "merge" its branch into the current branch then remove it, "remove" the folder and keep
// the branch, or "discard" both.
async function finishWorktree(git, cwd, worktreePath, branch, mode) {
  if (!["merge", "remove", "discard"].includes(mode)) throw new Error("Unknown action.");
  const dirty = lines(await git(worktreePath, ["status", "--porcelain"]).catch(() => ""));
  if (mode !== "discard" && dirty > 0) throw new Error(`The worktree has ${dirty} uncommitted file${dirty === 1 ? "" : "s"}. Ask the agent to commit, or discard.`);
  if (mode === "merge") {
    if (lines(await git(cwd, ["status", "--porcelain", "--untracked-files=no"])) > 0) throw new Error("The project has uncommitted changes. Commit or stash them before merging.");
    try { await git(cwd, ["merge", "--no-ff", "--no-edit", branch]); }
    catch (error) { await git(cwd, ["merge", "--abort"]).catch(() => {}); throw new Error("The merge has conflicts and was cancelled. Resolve it in a terminal: git merge " + branch + ". " + String(error.message || "").split("\n")[0]); }
  }
  await git(cwd, ["worktree", "remove", ...(mode === "discard" ? ["--force"] : []), "--", worktreePath]);
  await git(cwd, ["worktree", "prune"]);
  if (mode === "merge") await git(cwd, ["branch", "-d", branch]).catch(() => {});
  if (mode === "discard") await git(cwd, ["branch", "-D", branch]).catch(() => {});
  return true;
}

// Parses `git diff --name-status` / `git status --porcelain` into { status, path } (renames keep the new path).
function parseNameStatus(text) {
  return String(text || "").split("\n").filter(Boolean).map(line => { const parts = line.split("\t"); return { status: parts[0].trim().charAt(0), path: parts[parts.length - 1] }; });
}
function parsePorcelain(text) {
  return String(text || "").split("\n").filter(Boolean).map(line => { const code = line.slice(0, 2); const file = line.slice(3).split(" -> ").pop(); return { status: code.includes("?") ? "A" : code.includes("D") ? "D" : code.includes("A") ? "A" : "M", path: file.replace(/^"|"$/g, "") }; });
}

// What an agent's branch changed since it forked from the current branch, plus what is still uncommitted in its worktree.
async function branchChanges(git, cwd, branch, worktreePath) {
  const committed = parseNameStatus(await git(cwd, ["diff", "--name-status", `HEAD...${branch}`]).catch(() => "")).map(item => ({ ...item, uncommitted: false }));
  const pending = worktreePath ? parsePorcelain(await git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "")).map(item => ({ ...item, uncommitted: true })) : [];
  return [...committed, ...pending];
}

// Both sides of one file: the fork point against the branch, or the branch against the worktree's working copy.
async function branchFile(git, cwd, branch, file, worktreePath, uncommitted, readFile) {
  const show = async (dir, ref) => { try { return await git(dir, ["show", `${ref}:${file}`]); } catch { return ""; } };
  if (uncommitted && worktreePath) return { original: await show(worktreePath, "HEAD"), modified: await readFile(worktreePath, file).catch(() => "") };
  const base = String(await git(cwd, ["merge-base", "HEAD", branch]).catch(() => "")).trim() || "HEAD";
  return { original: await show(cwd, base), modified: await show(cwd, branch) };
}

module.exports = { parseGitWorktrees, worktreeSummary, finishWorktree, parseNameStatus, parsePorcelain, branchChanges, branchFile };
