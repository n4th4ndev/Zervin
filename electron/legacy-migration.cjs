// One-time migration of what earlier builds stored under their previous internal name: the app data folder and the
// Claude Code CLI entry of the MCP server. It runs at startup, does nothing once migrated, and can be deleted when every
// install has been opened once.
const fs = require("node:fs");
const path = require("node:path");

const previousName = "blueberry";
const previousDataFolders = [previousName + "back", "Blue" + "berry"];

// Moves the previous data folder (settings, recent projects, page storage, sign-ins) to the Zevrin folder.
function migrateDataFolder(app) {
  const appData = app.getPath("appData");
  const current = path.join(appData, "Zevrin");
  if (fs.existsSync(current)) return;
  const previous = previousDataFolders.map(name => path.join(appData, name)).find(folder => fs.existsSync(folder));
  if (!previous) return;
  try { fs.renameSync(previous, current); }
  catch { app.setPath("userData", previous); }
}

module.exports = { migrateDataFolder, previousMcpServerName: previousName };
