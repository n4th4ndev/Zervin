// Turns what the Preview tile shows into context Claude can use: page text, selection, console output.
export type PageSnapshot = { url: string; title: string; selection: string; text: string; headings: string[]; description?: string; forms?: number; links?: number };
export type ConsoleEntry = { level: "log" | "info" | "warning" | "error"; message: string; source?: string; line?: number; at: number };

// Runs inside the previewed page (through executeJavaScript) and returns a JSON-friendly snapshot.
export const snapshotScript = `(() => {
  const clip = (value, max) => (value || "").replace(/\\s+\\n/g, "\\n").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, max);
  const selection = String(window.getSelection ? window.getSelection() : "");
  const headings = Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 40).map(node => (node.tagName.toLowerCase() + " " + (node.textContent || "").trim()).slice(0, 160));
  const meta = document.querySelector('meta[name="description"]');
  return { url: location.href, title: document.title, selection: clip(selection, 4000), text: clip(document.body ? document.body.innerText : "", 12000), headings, description: meta ? meta.getAttribute("content") || "" : "", forms: document.forms.length, links: document.links.length };
})()`;

export function formatPageContext(page: PageSnapshot, options: { selectionOnly?: boolean; maxText?: number } = {}) {
  const lines = [`Page: ${page.title || "(untitled)"}`, `URL: ${page.url}`];
  if (page.description) lines.push(`Description: ${page.description}`);
  if (options.selectionOnly) {
    lines.push("", "Selected text:", "```", page.selection || "(nothing selected)", "```");
    return lines.join("\n");
  }
  if (page.selection) lines.push("", "Selected text:", "```", page.selection, "```");
  if (page.headings.length) lines.push("", "Headings:", ...page.headings.map(item => "- " + item));
  const text = page.text.slice(0, options.maxText ?? 6000);
  if (text) lines.push("", "Visible text:", "```", text + (page.text.length > text.length ? "\n…" : ""), "```");
  return lines.join("\n");
}

export function formatConsole(entries: ConsoleEntry[], options: { errorsOnly?: boolean; limit?: number } = {}) {
  const kept = (options.errorsOnly ? entries.filter(entry => entry.level === "error" || entry.level === "warning") : entries).slice(-(options.limit ?? 60));
  if (kept.length === 0) return options.errorsOnly ? "No console errors or warnings." : "The console is empty.";
  return kept.map(entry => `[${entry.level}] ${entry.message}${entry.source ? ` (${entry.source.split("/").pop()}${entry.line ? ":" + entry.line : ""})` : ""}`).join("\n");
}

export function consoleLevel(level: unknown): ConsoleEntry["level"] {
  if (level === 3 || level === "error") return "error";
  if (level === 2 || level === "warning") return "warning";
  if (level === 1 || level === "info") return "info";
  return "log";
}

// ----- Element picker, page snapshot, element location (scripts run inside the previewed page) -----

export type PickedElement = { url: string; selector: string; tag: string; text: string; html: string; rect: { x: number; y: number; width: number; height: number }; viewport: { width: number; height: number }; styles: Record<string, string>; component: string | null; source: string | null; attributes: Record<string, string> };

// Installs a hover highlight; the next click records the element in window.__zevrinPick ("done"/"cancelled").
export const pickerInstallScript = `(() => {
  if (window.__zevrinPicker) return "already";
  const box = document.createElement("div");
  const label = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #4c8dff;background:rgba(76,141,255,.12);border-radius:3px;transition:all .05s";
  label.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#1b1b1e;color:#fff;font:11px -apple-system,sans-serif;padding:3px 6px;border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,.4)";
  document.documentElement.append(box, label);
  const cssPath = el => {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    const test = el.getAttribute("data-testid") || el.getAttribute("data-test");
    if (test) return '[data-testid="' + test + '"]';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 5) {
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList).filter(name => !/^(css-|sc-|jsx-)|[0-9]{3,}/.test(name)).slice(0, 2);
      if (classes.length) part += "." + classes.map(name => CSS.escape(name)).join(".");
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(item => item.tagName === node.tagName) : [];
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      parts.unshift(part);
      if (node.parentElement && node.parentElement.id) { parts.unshift("#" + CSS.escape(node.parentElement.id)); break; }
      node = node.parentElement;
    }
    return parts.join(" > ");
  };
  const componentOf = el => {
    const key = Object.keys(el).find(name => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));
    let fiber = key ? el[key] : null, component = null, source = null;
    while (fiber && (!component || !source)) {
      if (!source && fiber._debugSource) source = fiber._debugSource.fileName.replace(/^.*?\\/(src|app|components|pages)\\//, "$1/") + ":" + fiber._debugSource.lineNumber;
      if (!component && typeof fiber.type === "function") component = fiber.type.displayName || fiber.type.name || null;
      fiber = fiber.return;
    }
    const vue = el.__vueParentComponent;
    if (!component && vue) { component = vue.type && (vue.type.name || vue.type.__name) || null; source = source || (vue.type && vue.type.__file) || null; }
    return { component, source };
  };
  const onMove = event => {
    const el = event.target;
    if (!el || el === box || el === label) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    label.textContent = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    Object.assign(label.style, { left: Math.max(4, r.left) + "px", top: Math.max(4, r.top - 24) + "px" });
  };
  const finish = (state, value) => { window.__zevrinPick = { state, value }; cleanup(); };
  const onClick = event => {
    event.preventDefault(); event.stopPropagation();
    const el = event.target;
    const r = el.getBoundingClientRect();
    const computed = getComputedStyle(el);
    const styles = {};
    for (const name of ["display", "position", "width", "height", "margin", "padding", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "border", "border-radius", "gap", "flex-direction", "justify-content", "align-items", "grid-template-columns", "z-index", "opacity"]) { const value = computed.getPropertyValue(name); if (value && value !== "normal" && value !== "none" && value !== "auto" && value !== "0px") styles[name] = value; }
    const attributes = {};
    for (const attr of Array.from(el.attributes).slice(0, 20)) if (attr.name !== "style") attributes[attr.name] = attr.value.slice(0, 200);
    const { component, source } = componentOf(el);
    finish("done", { url: location.href, selector: cssPath(el), tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 300), html: el.outerHTML.slice(0, 2500), rect: { x: r.left, y: r.top, width: r.width, height: r.height }, viewport: { width: innerWidth, height: innerHeight }, styles, component, source, attributes });
  };
  const onKey = event => { if (event.key === "Escape") { event.preventDefault(); finish("cancelled", null); } };
  const cleanup = () => { removeEventListener("mousemove", onMove, true); removeEventListener("click", onClick, true); removeEventListener("keydown", onKey, true); box.remove(); label.remove(); window.__zevrinPicker = false; };
  window.__zevrinPick = { state: "picking" };
  window.__zevrinPicker = true;
  addEventListener("mousemove", onMove, true);
  addEventListener("click", onClick, true);
  addEventListener("keydown", onKey, true);
  return "installed";
})()`;
export const pickerPollScript = `(() => window.__zevrinPick || { state: "none" })()`;
export const pickerCancelScript = `(() => { if (window.__zevrinPicker) { const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true }); dispatchEvent(event); } return true; })()`;

export function formatElementContext(element: PickedElement) {
  const lines = [`Element picked in the Preview (${element.url}):`, `- selector: \`${element.selector}\``, `- tag: <${element.tag}>${element.text ? ` · text: "${element.text.replace(/\s+/g, " ").slice(0, 160)}"` : ""}`];
  if (element.component || element.source) lines.push(`- component: ${element.component ?? "?"}${element.source ? ` (${element.source})` : ""}`);
  lines.push(`- box: ${Math.round(element.rect.width)}×${Math.round(element.rect.height)} at (${Math.round(element.rect.x)}, ${Math.round(element.rect.y)}) in a ${element.viewport.width}×${element.viewport.height} viewport`);
  const styles = Object.entries(element.styles);
  if (styles.length) lines.push("- styles: " + styles.map(([name, value]) => `${name}: ${value}`).join("; "));
  lines.push("", "```html", element.html, "```");
  return lines.join("\n");
}

// Interactive elements of the page with short refs (e1, e2…) the agent can click or type into.
export const snapshotRefsScript = `(() => {
  document.querySelectorAll("[data-bb-ref]").forEach(node => node.removeAttribute("data-bb-ref"));
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const label = el => (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const items = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [contenteditable="true"], [onclick]')).filter(visible).slice(0, 200);
  const lines = items.map((el, index) => {
    const ref = "e" + (index + 1);
    el.setAttribute("data-bb-ref", ref);
    const tag = el.tagName.toLowerCase();
    const kind = tag === "input" ? "input[" + (el.type || "text") + "]" : el.getAttribute("role") || tag;
    const state = [el.disabled ? "disabled" : "", el.checked ? "checked" : "", tag === "input" && el.value ? 'value="' + String(el.value).slice(0, 40) + '"' : "", tag === "a" ? "→ " + (el.getAttribute("href") || "").slice(0, 80) : ""].filter(Boolean).join(" ");
    return ref + " " + kind + ' "' + label(el) + '"' + (state ? " " + state : "");
  });
  const headings = Array.from(document.querySelectorAll("h1, h2, h3")).filter(visible).slice(0, 20).map(el => el.tagName.toLowerCase() + " " + el.innerText.trim().slice(0, 80));
  return { url: location.href, title: document.title, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }, headings, elements: lines };
})()`;

export type LocateTarget = { ref?: string; selector?: string; text?: string };

// Finds an element by ref, CSS selector or visible text, scrolls it into view and returns its centre (viewport px).
export function locateScript(target: LocateTarget) {
  return `(() => {
  const target = ${JSON.stringify(target)};
  let el = null;
  if (target.ref) el = document.querySelector('[data-bb-ref="' + target.ref.replace(/[^a-z0-9]/gi, "") + '"]');
  if (!el && target.selector) { try { el = document.querySelector(target.selector); } catch { return { error: "Invalid selector." }; } }
  if (!el && target.text) {
    const needle = target.text.toLowerCase();
    const candidates = Array.from(document.querySelectorAll('a, button, input, select, textarea, label, summary, [role], [onclick], li, span, div, p, h1, h2, h3, h4'));
    const matches = candidates.filter(item => { const text = (item.innerText || item.value || item.getAttribute("aria-label") || item.getAttribute("placeholder") || "").toLowerCase(); return text.includes(needle); });
    matches.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    el = matches.find(item => item.matches('a, button, input, select, textarea, summary, [role], [onclick]')) || matches[0] || null;
  }
  if (!el) return { error: "No element matches." };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, tag: el.tagName.toLowerCase(), label: (el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80) };
})()`;
}

export function waitForScript(target: { text?: string; selector?: string }) {
  return `(() => { const t = ${JSON.stringify(target)}; if (t.selector) { try { return !!document.querySelector(t.selector); } catch { return false; } } return !!(t.text && document.body && document.body.innerText.toLowerCase().includes(t.text.toLowerCase())); })()`;
}

export function formatSnapshot(snapshot: { url: string; title: string; scroll: { y: number; height: number; viewport: number }; headings: string[]; elements: string[] }) {
  return [`Page: ${snapshot.title || "(untitled)"}`, `URL: ${snapshot.url}`, `Scroll: ${snapshot.scroll.y} / ${Math.max(0, snapshot.scroll.height - snapshot.scroll.viewport)}`, snapshot.headings.length ? "Headings:\n" + snapshot.headings.map(item => "  " + item).join("\n") : "", "Interactive elements (use the ref with preview_click / preview_type):", ...snapshot.elements.map(item => "  " + item)].filter(Boolean).join("\n");
}

export function pickKeyframes<T>(frames: T[], count = 6): T[] {
  if (frames.length <= count) return frames.slice();
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) picked.push(frames[Math.round(index * (frames.length - 1) / (count - 1))]);
  return picked;
}

export type NetworkLine = { url: string; method: string; status: number | null; failed: boolean; error: string | null; ms: number | null };
export function formatNetwork(requests: NetworkLine[], options: { failuresOnly?: boolean; limit?: number } = {}) {
  const list = (options.failuresOnly ? requests.filter(item => item.failed || (item.status ?? 0) >= 400) : requests).slice(-(options.limit ?? 60));
  if (list.length === 0) return options.failuresOnly ? "No failed requests." : "No requests recorded yet.";
  return list.map(item => `${item.failed ? "FAILED" : item.status ?? "…"} ${item.method} ${item.url}${item.error ? ` (${item.error})` : ""}${item.ms !== null ? ` ${item.ms}ms` : ""}`).join("\n");
}
