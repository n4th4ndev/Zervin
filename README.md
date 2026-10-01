<p align="center"><img src="build/icon.png" width="128" alt="Zevrin"></p>

<h1 align="center">Zevrin</h1>
<p align="center"><strong>The agent-native IDE.</strong><br>Coding agents, a real editor, a browser they can drive and your simulators, in one window.</p>

---

Zevrin is a desktop IDE for macOS built around coding agents. Claude and Codex work in native chats next to a Monaco editor, terminals, Git, a browser the agents can see and control, and the iOS / Android simulators of your Mac. Every agent turn is checkpointed, so you review its changes hunk by hunk and undo anything.

## Highlights

- **Native agent chats.** Claude (Claude Agent SDK) and Codex (Codex SDK) chats with streaming, tool cards, plans and to-dos, permission prompts, history, models and reasoning effort. They use your own `claude` and `codex` sign-ins and settings.
- **Checkpoints and review.** Each message snapshots the project first, in a shadow Git repository: your repository is never touched, and folders without Git work too. When a turn ends you get a summary ("3 files changed +42 −7"), a full-window review with **Keep / Undo** per hunk and per file, and **Restore to here** on every message.
- **⌘K in the editor.** Select code, type an instruction, and the edit appears in place: new lines in green, replaced lines struck through. Accept with ⌘⏎, reject with Esc.
- **Agents in parallel.** Open several Claude and Codex sessions, each optionally in its own Git worktree and branch. Tabs show who is working or waiting for you, and you merge, keep or discard a session's branch when you close it.
- **A browser for your agents.** The Preview tile sends context straight to an agent: element picking with selector, styles and component source, screenshots, screen recordings, console and network. Through MCP tools, agents can also navigate, click, type and inspect the page on their own.
- **Simulators in the IDE.** iOS simulators and Android emulators are found automatically, booted, and mirrored live at their real size. Tap, swipe and type on the mirror; switch dark / light mode; record the screen; send logs and screenshots to an agent.
- **A real editor.** Monaco (VS Code's editor) with every language, minimap, multi-cursor, find / replace, diffs, search in files and a fuzzy Command Center (⌘P).
- **Git built in.** Branches, fetch / pull / push, staging, per-file diffs, commits, history and worktrees. **✨ Generate** writes the commit message from your staged changes (Claude or Codex), in the style of your recent commits.
- **Workspace your way.** Docked layout (files left, code centre, agents right, terminals bottom) or free tiling. Several projects open at once, a Canvas for notes and diagrams, and Flow Mode (⌘.), which takes the whole screen and blurs your other displays.
- **MCP server.** A local MCP endpoint lets Claude Code, the CLI and any MCP client drive Zevrin: open files, preview pages, use the simulators, run terminal commands, show notifications.

## Requirements

- macOS (Apple silicon or Intel). The desktop shell also runs on Windows and Linux, without the simulator features.
- Node.js 20 or later.
- [Claude Code](https://claude.com/claude-code) (`claude`) and/or [Codex](https://github.com/openai/codex) (`codex`), installed and signed in, for the agent chats.
- Xcode for iOS simulators, and the Android SDK for emulators (optional).

## Getting started

```bash
npm install
npm run desktop:dev     # Electron + Next.js dev server with hot reload
```

| Command | What it does |
| --- | --- |
| `npm run desktop:dev` | Runs the app with hot reload. |
| `npm run build` then `npm run desktop` | Runs the app from a production build. |
| `npm run package` | Builds `Zevrin.app`, `.dmg` and `.zip` for Apple silicon and Intel in `dist/`. |
| `npm run package:win` | Builds the Windows installer (`.exe`, x64 and arm64). |
| `npm test` | Runs the test suites. |
| `npm run check` | Typecheck, tests and build. |

Installers for macOS (Apple silicon and Intel) and Windows are published on the [Releases](../../releases) page: pushing a tag such as `v0.1.0` builds and publishes them through GitHub Actions. The app is not code-signed: open it the first time with right-click → **Open**. It uses the `claude` and `codex` CLIs installed on your machine, which keeps it around 300 MB.

### macOS permissions

- **Screen Recording**: shows the simulator window live in the Devices tile. Without it, Zevrin uses a video stream or screenshots.
- **Accessibility**: lets taps and swipes on the mirror reach the simulator window.

## Architecture

| Path | Role |
| --- | --- |
| `app/` | The Next.js interface: `page.tsx` (shell, projects, settings), `workspace-view.tsx` (one project: tiles, Git, files, Command Center). |
| `app/agent-chat.tsx`, `app/chat-model.ts` | Claude chat and its tested state reducer. |
| `app/codex-chat.tsx`, `app/codex-model.ts` | Codex chat and its event model. |
| `app/agent-changes.tsx` | Changes card, Restore to here, and the review sheet. |
| `app/code-editor.tsx` | Monaco editor, diff editor and ⌘K inline edits. |
| `app/devices-tile.tsx`, `app/h264-stream.ts` | Simulators: live mirror (window capture, H.264 stream, screenshots) and controls. |
| `electron/main.cjs` | Electron main process: windows, menus, local server, terminals, IPC. |
| `electron/agent-bridge.cjs`, `electron/codex-bridge.cjs` | Claude and Codex sessions. |
| `electron/checkpoints.cjs` | Snapshots, diffs and hunk reverts in a shadow Git repository. |
| `electron/inline-edit.cjs` | One-shot, tool-less Claude requests for ⌘K. |
| `electron/mcp-server.cjs` | The Zevrin MCP server and its tools. |
| `electron/preview-agent.cjs` | Preview browser through the Chrome DevTools Protocol. |
| `electron/devices.cjs` | iOS simulators (`simctl`, `idb`) and Android emulators (`adb`). |
| `electron/preload.cjs`, `types/desktop.d.ts` | The bridge exposed to the interface as `window.zevrinDesktop`. |
| `tests/` | Node test runner suites. |

## License

[MIT](LICENSE) © 2026 n4th4n
