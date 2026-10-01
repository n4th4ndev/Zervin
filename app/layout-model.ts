// Free-form tile layout: a binary split tree where every leaf is a tile (Terminal, agent terminal, Code, Files, Preview, Canvas, Source Control).
export type TileType = "terminal" | "agent" | "vscode" | "editor" | "files" | "preview" | "canvas" | "git" | "devices";
export type AssistantId = "claude" | "gemini" | "codex" | "opencode";
export type SplitDirection = "columns" | "rows";
export type DropSide = "left" | "right" | "top" | "bottom" | "center";
export type TileNode = { kind: "tile"; id: string; type: TileType; assistant?: AssistantId; name?: string; session?: string; cwd?: string; branch?: string };
export type SplitNode = { kind: "split"; id: string; direction: SplitDirection; ratio: number; children: [LayoutNode, LayoutNode] };
export type LayoutNode = TileNode | SplitNode;

export const tileTypes: TileType[] = ["terminal", "agent", "vscode", "editor", "files", "preview", "canvas", "git", "devices"];
export const assistantIds: AssistantId[] = ["claude", "gemini", "codex", "opencode"];
// Terminals and agent chats may appear several times; the other tiles are singletons.
export const singletonTiles: TileType[] = ["vscode", "editor", "files", "preview", "canvas", "git", "devices"];

export function newLayoutId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function tile(type: TileType, options: { assistant?: AssistantId; name?: string; session?: string; cwd?: string; branch?: string } = {}): TileNode {
  return { kind: "tile", id: newLayoutId(), type, ...(options.assistant ? { assistant: options.assistant } : {}), ...(options.name ? { name: options.name } : {}), ...(options.session ? { session: options.session } : {}), ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.branch ? { branch: options.branch } : {}) };
}

export function split(direction: SplitDirection, first: LayoutNode, second: LayoutNode, ratio = 0.5): SplitNode {
  return { kind: "split", id: newLayoutId(), direction, ratio: clampRatio(ratio), children: [first, second] };
}

export function clampRatio(ratio: number) {
  return Math.max(0.15, Math.min(0.85, Number.isFinite(ratio) ? ratio : 0.5));
}

export function isLayoutNode(value: unknown, depth = 0): value is LayoutNode {
  if (!value || typeof value !== "object" || depth > 16) return false;
  const node = value as { kind?: unknown; id?: unknown; type?: unknown; assistant?: unknown; name?: unknown; session?: unknown; cwd?: unknown; branch?: unknown; direction?: unknown; ratio?: unknown; children?: unknown };
  if (typeof node.id !== "string" || node.id.length === 0 || node.id.length > 120) return false;
  if (node.kind === "tile") {
    return tileTypes.includes(node.type as TileType) && (node.assistant === undefined || ((node.type === "terminal" || node.type === "agent" || node.type === "vscode") && assistantIds.includes(node.assistant as AssistantId))) && (node.name === undefined || (typeof node.name === "string" && node.name.length <= 80)) && (node.session === undefined || (typeof node.session === "string" && node.session.length <= 120)) && (node.cwd === undefined || (typeof node.cwd === "string" && node.cwd.length <= 1000 && /^(\/|[A-Za-z]:[\\/])/.test(node.cwd))) && (node.branch === undefined || (typeof node.branch === "string" && node.branch.length <= 200));
  }
  return node.kind === "split" && (node.direction === "columns" || node.direction === "rows") && typeof node.ratio === "number" && Number.isFinite(node.ratio) &&
    Array.isArray(node.children) && node.children.length === 2 && isLayoutNode(node.children[0], depth + 1) && isLayoutNode(node.children[1], depth + 1);
}

// Drops invalid nodes and repairs ratios; returns null when nothing usable remains.
export function normalizeLayout(value: unknown): LayoutNode | null {
  if (!isLayoutNode(value)) return null;
  const seen = new Set<string>();
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    if (node.kind === "tile") return node;
    const first = walk(node.children[0]);
    const second = walk(node.children[1]);
    if (!first) return second;
    if (!second) return first;
    return { ...node, ratio: clampRatio(node.ratio), children: [first, second] };
  };
  return walk(value);
}

export function tiles(node: LayoutNode | null): TileNode[] {
  if (!node) return [];
  return node.kind === "tile" ? [node] : [...tiles(node.children[0]), ...tiles(node.children[1])];
}

export function findTile(node: LayoutNode | null, predicate: (tile: TileNode) => boolean): TileNode | null {
  return tiles(node).find(predicate) ?? null;
}

export function findNode(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.kind === "tile") return null;
  return findNode(node.children[0], id) ?? findNode(node.children[1], id);
}

export function hasTile(node: LayoutNode | null, type: TileType) {
  return findTile(node, item => item.type === type && !item.assistant) !== null;
}

// Bottom-up map: children are transformed first, so an update that wraps a node in a new split is not revisited.
export function mapLayout(node: LayoutNode, update: (node: LayoutNode) => LayoutNode): LayoutNode {
  const mapped: LayoutNode = node.kind === "tile" ? node : { ...node, children: [mapLayout(node.children[0], update), mapLayout(node.children[1], update)] };
  return update(mapped);
}

export function removeNode(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.id === id) return null;
  if (node.kind === "tile") return node;
  const first = removeNode(node.children[0], id);
  const second = removeNode(node.children[1], id);
  if (!first) return second;
  if (!second) return first;
  if (first === node.children[0] && second === node.children[1]) return node;
  return { ...node, children: [first, second] };
}

export function updateRatio(node: LayoutNode, id: string, ratio: number): LayoutNode {
  return mapLayout(node, item => item.kind === "split" && item.id === id ? { ...item, ratio: clampRatio(ratio) } : item);
}

export function updateTile(node: LayoutNode, id: string, changes: Partial<Omit<TileNode, "kind" | "id">>): LayoutNode {
  return mapLayout(node, item => item.kind === "tile" && item.id === id ? { ...item, ...changes } : item);
}

// Places `incoming` next to the node `targetId` on the given side. "center" replaces the target.
export function insertBeside(node: LayoutNode | null, targetId: string | null, incoming: LayoutNode, side: DropSide, ratio = 0.5): LayoutNode {
  if (!node) return incoming;
  if (targetId === null) {
    if (side === "center") return incoming;
    return side === "left" ? split("columns", incoming, node, ratio) : side === "right" ? split("columns", node, incoming, 1 - ratio)
      : side === "top" ? split("rows", incoming, node, ratio) : split("rows", node, incoming, 1 - ratio);
  }
  return mapLayout(node, item => {
    if (item.id !== targetId) return item;
    if (side === "center") return incoming;
    return side === "left" ? split("columns", incoming, item, ratio) : side === "right" ? split("columns", item, incoming, 1 - ratio)
      : side === "top" ? split("rows", incoming, item, ratio) : split("rows", item, incoming, 1 - ratio);
  });
}

// Moves the node `id` next to `targetId`. Dropping a tile onto the center of another tile swaps them.
export function moveNode(node: LayoutNode | null, id: string, targetId: string, side: DropSide): LayoutNode | null {
  if (!node || id === targetId) return node;
  const moving = findNode(node, id);
  const target = findNode(node, targetId);
  if (!moving || !target) return node;
  if (findNode(moving, targetId)) return node; // Cannot drop a split into one of its own children.
  if (side === "center") {
    if (moving.kind !== "tile" || target.kind !== "tile") return node;
    return mapLayout(node, item => item.id === id ? target : item.id === targetId ? moving : item);
  }
  const without = removeNode(node, id);
  if (!without) return moving;
  return insertBeside(without, targetId, moving, side);
}

// Appends a tile at the workspace edge (used by sidebar clicks when there is no drop target).
export function appendTile(node: LayoutNode | null, incoming: TileNode, side: DropSide = "right", ratio = 0.5): LayoutNode {
  return insertBeside(node, null, incoming, side === "center" ? "right" : side, ratio);
}

export function defaultLayout(): LayoutNode {
  return split("columns", tile("terminal"), split("columns", tile("files"), tile("editor"), 0.28), 0.42);
}

export const layoutPresets: Record<string, () => LayoutNode> = {
  "agent-code": () => split("columns", tile("vscode"), tile("editor"), 0.5),
  "code-preview": () => split("columns", split("columns", tile("files"), tile("editor"), 0.26), tile("preview"), 0.55),
  "canvas-code": () => split("columns", tile("canvas"), tile("editor"), 0.5),
  grid: () => split("rows", split("columns", tile("terminal"), tile("editor")), split("columns", tile("preview"), tile("canvas"))),
  fibonacci: () => split("columns", tile("terminal"), split("rows", tile("editor"), split("columns", tile("preview"), tile("canvas"), 0.62), 0.62), 0.382),
  focus: () => split("columns", tile("files"), tile("editor"), 0.22),
  default: defaultLayout,
};

export function dropSideFor(x: number, y: number, width: number, height: number): DropSide {
  if (width <= 0 || height <= 0) return "center";
  const relativeX = x / width;
  const relativeY = y / height;
  if (relativeX > 0.3 && relativeX < 0.7 && relativeY > 0.3 && relativeY < 0.7) return "center";
  const distances: Array<[DropSide, number]> = [["left", relativeX], ["right", 1 - relativeX], ["top", relativeY], ["bottom", 1 - relativeY]];
  return distances.sort((a, b) => a[1] - b[1])[0][0];
}

// Rewrites every tile of a layout (keeping ids and the split tree).
export function mapTiles(node: LayoutNode, change: (tile: TileNode) => TileNode): LayoutNode {
  if (node.kind === "tile") { const next = change(node); return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as TileNode; }
  return { ...node, children: [mapTiles(node.children[0], change), mapTiles(node.children[1], change)] };
}
