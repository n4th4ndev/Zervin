// Drives the Preview tile's page through the Chrome DevTools Protocol (webContents.debugger): network log, screencast
// recording, and real mouse / keyboard input, so agents and users get what the page actually did.
const sessions = new Map();

function summarizeRequest(request) {
  return { url: request.url, method: request.method, status: request.status ?? null, type: request.type || null, failed: Boolean(request.failed), error: request.error || null, ms: request.end && request.start ? Math.round((request.end - request.start) * 1000) : null, size: request.size ?? null };
}

// Readable network summary; failures (network errors, HTTP >= 400) first when asked.
function formatNetwork(requests, { failuresOnly = false, limit = 60 } = {}) {
  const list = (failuresOnly ? requests.filter(item => item.failed || (item.status ?? 0) >= 400) : requests).slice(-limit);
  if (list.length === 0) return failuresOnly ? "No failed requests." : "No requests recorded yet.";
  return list.map(item => `${item.failed ? "FAILED" : item.status ?? "…"} ${item.method} ${item.url}${item.error ? ` (${item.error})` : ""}${item.ms !== null ? ` ${item.ms}ms` : ""}`).join("\n");
}

// Picks `count` frames spread over a recording, always keeping the first and the last.
function pickKeyframes(frames, count = 6) {
  if (frames.length <= count) return frames.slice();
  const picked = [];
  for (let index = 0; index < count; index += 1) picked.push(frames[Math.round(index * (frames.length - 1) / (count - 1))]);
  return picked;
}

class PreviewSession {
  constructor(contents) {
    this.contents = contents;
    this.requests = new Map();
    this.order = [];
    this.frames = null;
    this.attached = false;
    this.onMessage = (_event, method, params) => this.handle(method, params);
    this.onDetach = () => { this.attached = false; };
  }

  async attach() {
    if (this.attached) return;
    const dbg = this.contents.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    dbg.on("message", this.onMessage);
    dbg.on("detach", this.onDetach);
    this.attached = true;
    await dbg.sendCommand("Network.enable", {}).catch(() => {});
    await dbg.sendCommand("Page.enable", {}).catch(() => {});
  }

  send(method, params = {}) { return this.contents.debugger.sendCommand(method, params); }

  handle(method, params) {
    if (method === "Network.requestWillBeSent") {
      const request = { id: params.requestId, url: params.request.url, method: params.request.method, type: params.type, start: params.timestamp };
      if (!this.requests.has(params.requestId)) this.order.push(params.requestId);
      this.requests.set(params.requestId, request);
      if (this.order.length > 400) { const drop = this.order.shift(); this.requests.delete(drop); }
    } else if (method === "Network.responseReceived") {
      const request = this.requests.get(params.requestId); if (request) { request.status = params.response.status; request.type = params.type || request.type; }
    } else if (method === "Network.loadingFinished") {
      const request = this.requests.get(params.requestId); if (request) { request.end = params.timestamp; request.size = params.encodedDataLength; }
    } else if (method === "Network.loadingFailed") {
      const request = this.requests.get(params.requestId); if (request) { request.failed = !params.canceled; request.error = params.errorText; request.end = params.timestamp; }
    } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
      // A new page: keep the navigation request, forget the previous page's traffic.
      const keep = this.order.filter(id => this.requests.get(id)?.url === params.frame.url);
      this.order = keep; this.requests = new Map(keep.map(id => [id, this.requests.get(id)]));
    } else if (method === "Page.screencastFrame") {
      this.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      if (this.frames && this.frames.length < 600) this.frames.push({ data: params.data, t: params.metadata?.timestamp ?? Date.now() / 1000 });
    }
  }

  network() { return this.order.map(id => this.requests.get(id)).filter(Boolean).map(summarizeRequest); }

  async startRecording() {
    this.frames = [];
    this.recordingStartedAt = Date.now();
    this.requestsAtStart = this.order.length;
    await this.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 2 });
  }

  async stopRecording() {
    await this.send("Page.stopScreencast").catch(() => {});
    const frames = this.frames || [];
    this.frames = null;
    const network = this.network().slice(Math.max(0, (this.requestsAtStart ?? 0) - 0));
    return { frames, durationMs: Date.now() - (this.recordingStartedAt || Date.now()), network };
  }

  // Real input, dispatched by the browser like a user's.
  async input(event) {
    if (event.type === "click") {
      const base = { x: event.x, y: event.y, button: "left", clickCount: 1 };
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: event.x, y: event.y });
      await this.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
      await this.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
      return true;
    }
    if (event.type === "type") { await this.send("Input.insertText", { text: String(event.text || "") }); return true; }
    if (event.type === "key") {
      const keys = { Enter: [13, "\r"], Tab: [9, "\t"], Escape: [27, ""], Backspace: [8, ""], ArrowDown: [40, ""], ArrowUp: [38, ""], ArrowLeft: [37, ""], ArrowRight: [39, ""] };
      const [code, text] = keys[event.key] || [0, ""];
      if (!code) throw new Error("Unsupported key: " + event.key);
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: event.key, windowsVirtualKeyCode: code, text });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: event.key, windowsVirtualKeyCode: code });
      return true;
    }
    if (event.type === "scroll") { await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x ?? 200, y: event.y ?? 200, deltaX: event.deltaX ?? 0, deltaY: event.deltaY ?? 400 }); return true; }
    throw new Error("Unknown input.");
  }

  detach() {
    try { this.contents.debugger.off("message", this.onMessage); this.contents.debugger.off("detach", this.onDetach); if (this.contents.debugger.isAttached()) this.contents.debugger.detach(); } catch { /* already gone */ }
    this.attached = false;
  }
}

async function previewSession(contents) {
  let session = sessions.get(contents.id);
  if (!session) {
    session = new PreviewSession(contents);
    sessions.set(contents.id, session);
    contents.once("destroyed", () => { sessions.delete(contents.id); });
  }
  await session.attach();
  return session;
}

module.exports = { previewSession, formatNetwork, pickKeyframes, summarizeRequest };
