export type CanvasItem = {
  id: string;
  type: "note" | "rectangle" | "diamond" | "connector" | "text";
  x: number;
  y: number;
  text: string;
  from?: string;
  to?: string;
};

const canvasItemTypes: CanvasItem["type"][] = ["note", "rectangle", "diamond", "connector", "text"];

export function isCanvasItem(value: unknown): value is CanvasItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CanvasItem>;
  const hasConnection = item.from !== undefined || item.to !== undefined;
  return typeof item.id === "string" && canvasItemTypes.includes(item.type as CanvasItem["type"]) &&
    Number.isFinite(item.x) && Number.isFinite(item.y) && typeof item.text === "string" &&
    item.text.length <= 2000 &&
    (!hasConnection || (item.type === "connector" && typeof item.from === "string" &&
      typeof item.to === "string" && item.from !== item.to));
}

export function loadCanvasItems(value: unknown): CanvasItem[] {
  const items = Array.isArray(value) ? value.filter(isCanvasItem) : [];
  const nodeIds = new Set(items.filter(item => item.type !== "connector").map(item => item.id));
  return items.filter(item => item.type !== "connector" || (!item.from && !item.to) ||
    (!!item.from && !!item.to && nodeIds.has(item.from) && nodeIds.has(item.to)));
}

export function canvasItemCenter(item: CanvasItem) {
  const width = item.type === "diamond" ? 112 : item.type === "text" ? 180 : 150;
  const height = item.type === "diamond" ? 112 : item.type === "text" ? 36 : 92;
  return { x: item.x + width / 2, y: item.y + height / 2 };
}

export function canvasConnectionPath(source: CanvasItem, target: CanvasItem) {
  const start = canvasItemCenter(source);
  const end = canvasItemCenter(target);
  const deltaX = end.x - start.x;
  const bend = deltaX === 0 ? 36 : Math.sign(deltaX) * Math.max(36, Math.abs(deltaX) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

export function removeCanvasItems(items: CanvasItem[], id: string) {
  return items.filter(item => item.id !== id && item.from !== id && item.to !== id);
}
