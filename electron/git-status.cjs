// Parsers for `git status --porcelain=v1 --branch -z`, `git for-each-ref`, and `git log` output.

function parseBranchLine(line) {
  const text = line.startsWith("## ") ? line.slice(3) : line;
  const unborn = text.match(/^(?:No commits yet on|Initial commit on) (.+)$/);
  if (unborn) return { branch: unborn[1], upstream: null, ahead: 0, behind: 0, unborn: true };
  const [, head, upstream, counts = ""] = text.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/) || [, text];
  return {
    branch: head === "HEAD (no branch)" ? "detached" : head,
    upstream: upstream || null,
    ahead: Number(counts.match(/ahead (\d+)/)?.[1] || 0),
    behind: Number(counts.match(/behind (\d+)/)?.[1] || 0),
    unborn: false,
  };
}

function parseStatusOutput(output) {
  const records = String(output).split("\0");
  const status = { isRepo: true, ...parseBranchLine(records[0] || "## HEAD (no branch)"), changes: [] };
  for (let index = 1; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 3) continue;
    const change = { index: record[0], worktree: record[1], path: record.slice(3), from: null };
    if (change.index === "R" || change.index === "C") { change.from = records[index + 1] || null; index += 1; }
    status.changes.push(change);
  }
  return status;
}

// Output format: %(refname:short)%00%(HEAD)%00%(upstream:short) per line.
function parseBranchList(output) {
  return String(output).split(/\r?\n/).filter(Boolean).map(line => {
    const [name, head, upstream] = line.split("\0");
    return { name, current: head === "*", upstream: upstream || null };
  });
}

// Output format: %H%00%h%00%s%00%an%00%cr per line.
function parseLogOutput(output) {
  return String(output).split(/\r?\n/).filter(Boolean).map(line => {
    const [hash, short, subject, author, date] = line.split("\0");
    return { hash, short, subject: subject || "", author: author || "", date: date || "" };
  }).filter(commit => commit.hash && commit.short);
}

function isValidBranchName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 200 && name === name.trim() && !name.startsWith("-") &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) && !name.includes("..") && !name.includes("@{") && !name.endsWith("/") && !name.endsWith(".lock") &&
    !name.startsWith("/") && !name.includes("//") && name !== "@" && !name.split("/").some(part => part.startsWith(".") || part.endsWith("."));
}

module.exports = { parseBranchLine, parseStatusOutput, parseBranchList, parseLogOutput, isValidBranchName };
