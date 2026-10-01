// Hands text and images from any tile (the browser, the editor, Git) to a Claude chat tile's composer.
export type ComposePayload = { text: string; images?: Array<{ name: string; mediaType: string; data: string }> };

type Listener = (payload: ComposePayload) => void;
const listeners = new Map<string, Listener>();
const queued = new Map<string, ComposePayload[]>();

export function postCompose(tileId: string, payload: ComposePayload) {
  const listener = listeners.get(tileId);
  if (listener) { listener(payload); return true; }
  queued.set(tileId, [...(queued.get(tileId) ?? []), payload]);
  return false;
}

export function subscribeCompose(tileId: string, listener: Listener) {
  listeners.set(tileId, listener);
  const pending = queued.get(tileId);
  if (pending) { queued.delete(tileId); pending.forEach(listener); }
  return () => { if (listeners.get(tileId) === listener) listeners.delete(tileId); };
}
