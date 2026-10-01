// Plain JavaScript so the packaged app can run `next start` without TypeScript installed.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import("next").NextConfig} */
const nextConfig = {
  // The dev overlay button sits on top of the activity rail's Settings button inside the desktop shell.
  devIndicators: false,
  reactStrictMode: true,
  // A self-contained server (.next/standalone) with only the files it needs: the packaged app ships that instead of
  // the whole next, react and monaco-editor packages.
  output: "standalone",
  // This folder is the project root, even when another package-lock.json exists higher up (e.g. in the home folder).
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
};

export default nextConfig;
