import assert from "node:assert/strict";
import test from "node:test";
import gitStatus from "../electron/git-status.cjs";

const { parseBranchLine, parseStatusOutput, parseBranchList, parseLogOutput, isValidBranchName } = gitStatus;

test("parses branch headers with upstream and ahead/behind counts", () => {
  assert.deepEqual(parseBranchLine("## main...origin/main [ahead 2, behind 1]"), { branch: "main", upstream: "origin/main", ahead: 2, behind: 1, unborn: false });
  assert.deepEqual(parseBranchLine("## feature/ui"), { branch: "feature/ui", upstream: null, ahead: 0, behind: 0, unborn: false });
  assert.deepEqual(parseBranchLine("## HEAD (no branch)"), { branch: "detached", upstream: null, ahead: 0, behind: 0, unborn: false });
  assert.deepEqual(parseBranchLine("## No commits yet on main"), { branch: "main", upstream: null, ahead: 0, behind: 0, unborn: true });
});

test("parses NUL separated status records including renames", () => {
  const output = ["## main...origin/main [ahead 1]", "M  app/page.tsx", " M README.md", "?? new file.txt", "R  old.txt", "new.txt", "AM both.ts", ""].join("\0");
  const status = parseStatusOutput(output);
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.ahead, 1);
  assert.deepEqual(status.changes, [
    { index: "M", worktree: " ", path: "app/page.tsx", from: null },
    { index: " ", worktree: "M", path: "README.md", from: null },
    { index: "?", worktree: "?", path: "new file.txt", from: null },
    { index: "R", worktree: " ", path: "old.txt", from: "new.txt" },
    { index: "A", worktree: "M", path: "both.ts", from: null },
  ]);
});

test("parses branch and log listings", () => {
  assert.deepEqual(parseBranchList("main\0*\0origin/main\nfeature/x\0 \0\n"), [
    { name: "main", current: true, upstream: "origin/main" },
    { name: "feature/x", current: false, upstream: null },
  ]);
  assert.deepEqual(parseLogOutput("abc123def\0abc123d\0Add canvas\0Nathan\u00002 hours ago\n\nbad line\n"), [
    { hash: "abc123def", short: "abc123d", subject: "Add canvas", author: "Nathan", date: "2 hours ago" },
  ]);
});

test("validates branch names before handing them to git", () => {
  for (const valid of ["main", "feature/canvas-2", "fix_bug", "release-1.0"]) assert.equal(isValidBranchName(valid), true, valid);
  for (const invalid of ["", " main", "-flag", "a b", "a..b", "a/", "/a", "a.lock", "a//b", "@", ".hidden", "a~1", "a^", "a:b", "a?b", "a*b", "a[b", "a\\b", "a@{b"]) {
    assert.equal(isValidBranchName(invalid), false, JSON.stringify(invalid));
  }
});
