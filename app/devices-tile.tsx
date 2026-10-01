"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceInfo, DeviceInput, DevicesList } from "../types/desktop";
import { Glyph } from "./workspace-view";
import { H264Assembler, codecFromSps } from "./h264-stream";

export type DevicesApi = { mirrored: () => DeviceInfo | null; devices: () => DeviceInfo[]; refresh: () => Promise<DevicesList | null> };
type Props = { desktop: boolean; visible: boolean; defaultUrl: string; onAskClaude: (payload: { text: string; images?: Array<{ name: string; mediaType: string; data: string }> }) => void; onToast: (title: string, body: string | undefined, tone: "info" | "success" | "warning") => void; apiRef?: import("react").MutableRefObject<DevicesApi | null> };

function cleanError(error: unknown, fallback: string) {
  return (error instanceof Error ? error.message : "").replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || fallback;
}

// iOS simulators and Android emulators: list, boot, stop, mirror the screen live, open URLs, install builds, send screenshots to Claude.
export function DevicesTile({ desktop, visible, defaultUrl, onAskClaude, onToast, apiRef }: Props) {
  const [list, setList] = useState<DevicesList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [mirrorId, setMirrorId] = useState<string | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [frameError, setFrameError] = useState("");
  const [url, setUrl] = useState("");
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null);
  const [measuredFps, setMeasuredFps] = useState(0);
  const [windowNote, setWindowNote] = useState("");
  const [needsPermission, setNeedsPermission] = useState(false);
  // "window": the device's own window as video; "stream": the screen as decoded H.264; "frames": screenshots.
  const [source, setSource] = useState<"window" | "stream" | "frames" | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [appearance, setAppearance] = useState<string | null>(null);
  const [recording, setRecording] = useState<{ id: string; startedAt: number } | null>(null);
  const [lastRecording, setLastRecording] = useState<{ file: string; seconds: number; device: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [logsMenu, setLogsMenu] = useState(false);
  // Size of what is shown (window video or frame), in CSS pixels at 1:1, and the room the stage gives it.
  const [media, setMedia] = useState<{ width: number; height: number } | null>(null);
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const autoMirrored = useRef(false);
  const [poke, setPoke] = useState(0);
  const [inputNote, setInputNote] = useState("");
  const pressRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const typedRef = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<DevicesList | null>(null);
  useEffect(() => { listRef.current = list; }, [list]);
  const mirrored = list?.devices.find(device => device.id === mirrorId && device.state === "booted") ?? null;

  const refresh = useCallback(async () => {
    const api = window.zevrinDesktop;
    if (!desktop || !api) return null;
    setLoading(true);
    try { const next = await api.devicesList(); setList(next); return next; }
    catch (error) { onToast("Devices", cleanError(error, "Could not list devices."), "warning"); return null; }
    finally { setLoading(false); }
  }, [desktop, onToast]);

  useEffect(() => { if (visible) refresh(); }, [visible, refresh]);
  // Booting devices change state on their own: poll while any is booting or the tile is mirroring.
  useEffect(() => {
    if (!visible || !desktop) return;
    const booting = list?.devices.some(device => device.state === "booting") ?? false;
    const timer = setInterval(refresh, booting ? 3000 : 15000);
    return () => clearInterval(timer);
  }, [visible, desktop, list, refresh]);

  useEffect(() => {
    if (apiRef) apiRef.current = { mirrored: () => listRef.current?.devices.find(device => device.id === mirrorId && device.state === "booted") ?? null, devices: () => listRef.current?.devices ?? [], refresh };
    return () => { if (apiRef) apiRef.current = null; };
  }, [apiRef, mirrorId, refresh]);

  // Discovery: the first time devices are listed, mirror the simulator that is already running.
  useEffect(() => {
    if (autoMirrored.current || mirrorId || !list) return;
    const booted = list.devices.find(device => device.state === "booted");
    if (booted) { autoMirrored.current = true; setMirrorId(booted.id); }
  }, [list, mirrorId]);

  // Live mirror: the device's own window (Simulator.app or the Android emulator) captured by macOS at full frame
  // rate, exactly as it looks on the Mac. Without the Screen Recording permission or a visible window, a stream of
  // device screenshots taken back to back keeps the tile usable.
  useEffect(() => {
    const api = window.zevrinDesktop;
    if (!visible || !api || !mirrored) { setFrame(null); setLiveStream(null); setMedia(null); return; }
    let stopped = false;
    let stream: MediaStream | null = null;
    let usingFrames = false;
    let count = 0;
    let windowStart = Date.now();
    setWindowNote(""); setMedia(null);
    const removeFrame = api.onDeviceFrame((platform, id, next) => {
      if (stopped || platform !== mirrored.platform || id !== mirrored.id) return;
      setFrame(`data:${next.mimeType};base64,${next.data}`); setFrameError("");
      count += 1;
      if (Date.now() - windowStart > 2000) { setMeasuredFps(Math.round(count * 1000 / (Date.now() - windowStart))); count = 0; windowStart = Date.now(); }
    });
    const removeError = api.onDeviceFrameError((platform, id, message) => { if (!stopped && platform === mirrored.platform && id === mirrored.id) setFrameError(cleanError(new Error(message), "The screen could not be captured.")); });
    let usingStream = false;
    let decoder: VideoDecoder | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let removeStream = () => {};
    // Screen size ratio: iOS pixels are 3× points (÷1.5 then ÷ the Retina ratio), Android pixels are shown as is.
    const pixelDivisor = mirrored.platform === "ios" ? 1.5 : 1;
    const countFrame = () => { count += 1; if (Date.now() - windowStart > 2000) { setMeasuredFps(Math.round(count * 1000 / (Date.now() - windowStart))); count = 0; windowStart = Date.now(); } };
    const startFrames = () => { usingFrames = true; setLiveStream(null); setSource("frames"); api.deviceMirrorStart(mirrored.platform, mirrored.id, mirrored.serial, 30).catch(error => setFrameError(cleanError(error, "The mirror could not start."))); };
    const appName = mirrored.platform === "ios" ? "the Simulator window" : "the emulator window";
    // H.264 straight from the device (adb screenrecord, idb video-stream), decoded by the GPU through WebCodecs.
    const startStream = async () => {
      if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") return false;
      const supported = await VideoDecoder.isConfigSupported({ codec: "avc1.42E01F" }).then(result => Boolean(result.supported)).catch(() => false);
      if (!supported || stopped) return false;
      let codec = "";
      let decoded = 0;
      let waitingForKey = true;
      let timestamp = 0;
      decoder = new VideoDecoder({
        output: picture => {
          const canvas = canvasRef.current;
          if (canvas && !stopped) {
            if (canvas.width !== picture.displayWidth || canvas.height !== picture.displayHeight) { canvas.width = picture.displayWidth; canvas.height = picture.displayHeight; measureMedia(picture.displayWidth / pixelDivisor, picture.displayHeight / pixelDivisor); }
            canvas.getContext("2d")?.drawImage(picture, 0, 0);
            decoded += 1;
            countFrame();
          }
          picture.close();
        },
        error: () => { if (!stopped && usingStream) { stopStream(); startFrames(); } },
      });
      const assembler = new H264Assembler(unit => {
        if (!decoder || decoder.state !== "configured") return;
        if (waitingForKey && !unit.key) return;
        waitingForKey = false;
        timestamp += 16667;
        try { decoder.decode(new EncodedVideoChunk({ type: unit.key ? "key" : "delta", timestamp, data: unit.data })); } catch { waitingForKey = true; }
      }, sps => {
        const next = codecFromSps(sps);
        if (next === codec || !decoder) return;
        codec = next; waitingForKey = true;
        decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
      });
      const removeData = api.onDeviceStreamData((platform, id, chunk) => {
        if (stopped || platform !== mirrored.platform || id !== mirrored.id) return;
        assembler.push(chunk);
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => assembler.flush(), 25);
      });
      const removeStreamError = api.onDeviceStreamError((platform, id) => { if (!stopped && platform === mirrored.platform && id === mirrored.id && usingStream) { stopStream(); startFrames(); } });
      removeStream = () => { removeData(); removeStreamError(); };
      usingStream = true;
      setLiveStream(null); setSource("stream");
      const started = await api.deviceStreamStart(mirrored.platform, mirrored.id, mirrored.serial).catch(() => false);
      if (!started) { stopStream(); return false; }
      // No picture after a few seconds (a stream the decoder cannot read): fall back to screenshots.
      setTimeout(() => { if (!stopped && usingStream && decoded === 0) { stopStream(); startFrames(); } }, 5000);
      return true;
    };
    const stopStream = () => {
      if (!usingStream) return;
      usingStream = false;
      removeStream();
      if (flushTimer) clearTimeout(flushTimer);
      try { decoder?.close(); } catch { /* already closed */ }
      decoder = null;
      api.deviceStreamStop(mirrored.platform, mirrored.id).catch(() => {});
    };
    (async () => {
      try {
        const source = await api.deviceWindowSource(mirrored.platform, mirrored.name, mirrored.id, mirrored.serial ?? null);
        if (stopped) return;
        if (source.id) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: source.id, maxWidth: 8192, maxHeight: 8192, maxFrameRate: 120 } } as unknown as MediaTrackConstraints });
          if (stopped) { stream.getTracks().forEach(track => track.stop()); return; }
          stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (!stopped) { setLiveStream(null); startFrames(); } });
          setLiveStream(stream); setSource("window"); setFrameError(""); setNeedsPermission(false);
          return;
        }
        setNeedsPermission(Boolean(source.permission && source.permission !== "granted" && source.permission !== "unsupported"));
        setWindowNote(source.permission && source.permission !== "granted" && source.permission !== "unsupported"
          ? `To show ${appName} itself, allow Zevrin in System Settings → Privacy & Security → Screen Recording, then reopen Zevrin.`
          : mirrored.platform === "android" ? "The emulator runs without a window (or inside Android Studio); showing screenshots instead." : "");
      } catch { stream = null; setNeedsPermission(true); setWindowNote(`To show ${appName} itself, allow Zevrin in System Settings → Privacy & Security → Screen Recording.`); }
      if (stopped) return;
      if (await startStream()) return;
      if (!stopped) startFrames();
    })();
    return () => { stopped = true; stopStream(); setSource(null); removeFrame(); removeError(); if (usingFrames) api.deviceMirrorStop(mirrored.platform, mirrored.id).catch(() => {}); stream?.getTracks().forEach(track => track.stop()); };
  }, [visible, mirrored?.id, mirrored?.platform, mirrored?.serial, mirrored?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (videoRef.current && liveStream) { videoRef.current.srcObject = liveStream; videoRef.current.play().catch(() => {}); } }, [liveStream]);

  // Current light / dark appearance of the mirrored device.
  useEffect(() => {
    const api = window.zevrinDesktop;
    setAppearance(null);
    if (!api || !mirrored) return;
    let cancelled = false;
    api.deviceAppearance(mirrored.platform, mirrored.id, mirrored.serial, null).then(mode => { if (!cancelled) setAppearance(mode); }).catch(() => {});
    return () => { cancelled = true; };
  }, [mirrored?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!logsMenu) return; const close = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest?.(".mirror-logs")) setLogsMenu(false); }; document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close); }, [logsMenu]);
  useEffect(() => { if (!recording) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [recording]);

  async function toggleAppearance() {
    const api = window.zevrinDesktop;
    if (!api || !mirrored) return;
    const next = appearance === "dark" ? "light" : "dark";
    try { setAppearance(await api.deviceAppearance(mirrored.platform, mirrored.id, mirrored.serial, next)); }
    catch (error) { setInputNote(cleanError(error, "The appearance could not be changed.")); }
  }

  async function toggleRecording() {
    const api = window.zevrinDesktop;
    if (!api || !mirrored) return;
    if (recording) {
      setRecording(null);
      try {
        const done = await api.deviceRecordStop(mirrored.platform, recording.id);
        setLastRecording({ ...done, device: mirrored.name });
        onToast("Recording saved", `${done.seconds} s of ${mirrored.name}.`, "success");
      } catch (error) { onToast("Devices", cleanError(error, "The recording could not be saved."), "warning"); }
      return;
    }
    try { const started = await api.deviceRecordStart(mirrored.platform, mirrored.id, mirrored.serial); setRecording({ id: mirrored.id, startedAt: started.startedAt }); setLastRecording(null); setNow(Date.now()); }
    catch (error) { onToast("Devices", cleanError(error, "The recording could not start."), "warning"); }
  }

  async function sendRecording() {
    if (!lastRecording || !mirrored) return;
    let images: Array<{ name: string; mediaType: string; data: string }> | undefined;
    try { const shot = await window.zevrinDesktop!.deviceScreenshot(mirrored.platform, mirrored.id, mirrored.serial); images = [{ name: "last-frame.png", mediaType: shot.mimeType, data: shot.data }]; } catch { images = undefined; }
    onAskClaude({ text: `Screen recording of ${lastRecording.device} (${lastRecording.seconds} s), saved as ${lastRecording.file}. The current screen is attached.\n`, images });
  }

  async function sendLogs(errorsOnly: boolean) {
    const api = window.zevrinDesktop;
    setLogsMenu(false);
    if (!api || !mirrored) return;
    try {
      const text = await api.deviceLogs(mirrored.platform, mirrored.id, mirrored.serial, { minutes: 2, errorsOnly, lines: 300 });
      if (!text.trim()) { onToast("Devices", errorsOnly ? "No errors in the last 2 minutes." : "No logs in the last 2 minutes.", "info"); return; }
      onAskClaude({ text: `${errorsOnly ? "Errors" : "Logs"} from ${mirrored.name} (${mirrored.runtime}), last 2 minutes:\n\n\`\`\`\n${text}\n\`\`\`\n` });
    } catch (error) { onToast("Devices", cleanError(error, "The logs could not be read."), "warning"); }
  }

  // Room available in the stage, to show the window at its real size and only shrink it when it does not fit.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => { const style = getComputedStyle(stage); setRoom({ width: stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), height: stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [mirrored?.id]);
  // Captures are in device pixels; one CSS pixel is devicePixelRatio of them, so this is the window's real size on screen.
  // Screenshots are in device pixels (3× on iPhones); dividing by 1.5 then by the Retina ratio gives the size in points.
  const measureMedia = (width: number, height: number) => { if (width && height) { const ratio = window.devicePixelRatio || 1; setMedia(current => current && Math.abs(current.width - width / ratio) < 1 && Math.abs(current.height - height / ratio) < 1 ? current : { width: width / ratio, height: height / ratio }); } };
  const shown = media ? (() => { const scale = room && room.width > 0 && room.height > 0 ? Math.min(1, room.width / media.width, room.height / media.height) : 1; return { width: Math.round(media.width * scale), height: Math.round(media.height * scale) }; })() : undefined;

  // Input on the mirror: click = tap, drag = swipe, keyboard = text and keys. Coordinates are fractions of the image.
  async function sendInput(input: DeviceInput) {
    const api = window.zevrinDesktop;
    if (!api || !mirrored) return;
    try {
      if (liveStream && (input.type === "tap" || input.type === "swipe")) await api.deviceWindowInput(mirrored.platform, mirrored.name, input);
      else await api.deviceInput(mirrored.platform, mirrored.id, mirrored.serial, input);
      setInputNote("");
    }
    catch (error) { setInputNote(cleanError(error, "The input could not be sent.")); }
  }
  function fraction(event: React.PointerEvent<HTMLElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
  }
  function onPointerDown(event: React.PointerEvent<HTMLElement>) { event.preventDefault(); stageRef.current?.focus(); const point = fraction(event); pressRef.current = { ...point, at: Date.now() }; event.currentTarget.setPointerCapture(event.pointerId); }
  function onPointerUp(event: React.PointerEvent<HTMLElement>) {
    const start = pressRef.current; pressRef.current = null;
    if (!start) return;
    const end = fraction(event);
    const box = event.currentTarget.getBoundingClientRect();
    const distance = Math.hypot((end.x - start.x) * box.width, (end.y - start.y) * box.height);
    if (distance < 8) sendInput({ type: "tap", x: start.x, y: start.y });
    else sendInput({ type: "swipe", x1: start.x, y1: start.y, x2: end.x, y2: end.y, duration: Math.min(1500, Math.max(120, Date.now() - start.at)) });
  }
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!mirrored) return;
    const keys: Record<string, string> = { Enter: "enter", Backspace: "delete", Tab: "tab", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Escape: "back" };
    if (keys[event.key]) { event.preventDefault(); flushTyped(); sendInput({ type: "key", key: keys[event.key] }); return; }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      typedRef.current += event.key;
      if (typeTimer.current) clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(flushTyped, 350);
    }
  }
  function flushTyped() { if (typeTimer.current) { clearTimeout(typeTimer.current); typeTimer.current = null; } const text = typedRef.current; typedRef.current = ""; if (text) sendInput({ type: "text", text }); }

  async function act(key: string, work: () => Promise<unknown>, success?: string) {
    const api = window.zevrinDesktop;
    if (!api || busy) return;
    setBusy(key);
    try { await work(); if (success) onToast("Devices", success, "success"); await refresh(); }
    catch (error) { onToast("Devices", cleanError(error, "The action failed."), "warning"); }
    finally { setBusy(null); }
  }

  function boot(device: DeviceInfo) {
    const api = window.zevrinDesktop!;
    act("boot:" + device.id, async () => { await api.deviceBoot(device.platform, device.id); setMirrorId(device.id); }, device.platform === "android" ? `${device.name} is starting (this can take a minute).` : `${device.name} booted.`);
  }

  async function sendScreenshot(device: DeviceInfo) {
    const api = window.zevrinDesktop;
    if (!api) return;
    try { const shot = await api.deviceScreenshot(device.platform, device.id, device.serial); onAskClaude({ text: `Screenshot of ${device.name} (${device.runtime}):\n`, images: [{ name: `${device.platform}-${device.id}.png`, mediaType: shot.mimeType, data: shot.data }] }); }
    catch (error) { onToast("Devices", cleanError(error, "The screen could not be captured."), "warning"); }
  }

  function openUrl(device: DeviceInfo) {
    const target = (url || defaultUrl).trim();
    if (!target) { onToast("Devices", "Enter a URL or deep link first.", "info"); return; }
    const final = device.platform === "android" ? target.replace(/\/\/(localhost|127\.0\.0\.1)/, "//10.0.2.2") : target;
    act("url:" + device.id, () => window.zevrinDesktop!.deviceOpenUrl(device.platform, device.id, device.serial, final), `Opened ${final} on ${device.name}.`);
  }

  if (!desktop) return <div className="devices-view"><div className="chat-empty"><div className="editor-logo">D</div><h2>Devices</h2><p>Open the Zevrin desktop app to launch iOS simulators and Android emulators from here.</p></div></div>;

  const ios = list?.devices.filter(device => device.platform === "ios") ?? [];
  const android = list?.devices.filter(device => device.platform === "android") ?? [];
  const glyphFor = (device: DeviceInfo) => device.kind === "tablet" ? "tablet" : device.kind === "watch" ? "watch" : "phone";

  const renderDevice = (device: DeviceInfo) => <div key={device.platform + device.id} className={"device-row state-" + device.state + (mirrorId === device.id ? " mirrored" : "")}>
    <span className="device-glyph"><Glyph name={glyphFor(device)} size={16}/><i className={"device-state-dot " + device.state} title={device.state}/></span>
    <button className="device-main" onClick={() => device.state === "booted" ? setMirrorId(mirrorId === device.id ? null : device.id) : boot(device)} title={device.state === "booted" ? (mirrorId === device.id ? "Stop mirroring" : "Mirror this screen in the tile") : "Boot this device"}>
      <strong>{device.name}</strong><small>{device.runtime}{device.serial ? ` · ${device.serial}` : ""}{device.state === "booting" ? " · starting…" : device.state === "booted" ? " · running" : ""}</small>
    </button>
    <span className="device-actions">
      {device.state === "booted" ? <>
        <button title="Bring the simulator window to the front" aria-label="Show window" onClick={() => window.zevrinDesktop!.deviceFocus(device.platform)}>↗</button>
        <button title="Open the URL below on this device" aria-label="Open URL" disabled={busy !== null} onClick={() => openUrl(device)}><Glyph name="globe" size={13}/></button>
        <button title={device.platform === "ios" ? "Install and launch an .app built for the simulator" : "Install an .apk"} aria-label="Install app" disabled={busy !== null} onClick={() => act("install:" + device.id, () => window.zevrinDesktop!.deviceInstall(device.platform, device.id, device.serial), "Installed.")}>⇩</button>
        <button className="device-ask" title="Send a screenshot to Claude" aria-label="Send a screenshot to Claude" onClick={() => sendScreenshot(device)}><Glyph name="chat" size={13}/></button>
        <button title="Shut down" aria-label="Shut down" disabled={busy !== null} onClick={() => act("stop:" + device.id, () => { if (mirrorId === device.id) setMirrorId(null); return window.zevrinDesktop!.deviceShutdown(device.platform, device.id, device.serial); }, `${device.name} shut down.`)}>■</button>
      </> : <button className="device-boot" disabled={busy !== null || device.state === "booting"} onClick={() => boot(device)}>{busy === "boot:" + device.id || device.state === "booting" ? "Starting…" : "Boot"}</button>}
    </span>
  </div>;

  return <div className="devices-view">
    <div className="devices-list">
      <div className="devices-head"><span>Devices</span><span className="chat-spacer"/><button className="chat-icon-button" title="Refresh" aria-label="Refresh devices" onClick={refresh} disabled={loading}>{loading ? "…" : "↻"}</button></div>
      <div className="devices-url"><Glyph name="globe" size={13}/><input aria-label="URL or deep link to open on a device" placeholder={defaultUrl || "http://localhost:3000 or myapp://…"} value={url} onChange={event => setUrl(event.target.value)}/></div>
      <div className="devices-section"><span className="rail-heading">iOS simulators<i>{ios.length}</i></span>
        {list && !list.support.ios && <div className="devices-note">{list.support.iosReason}</div>}
        {ios.map(renderDevice)}
        {list?.support.ios && ios.length === 0 && <div className="devices-note">No simulators. Add one in Xcode → Settings → Platforms.</div>}
      </div>
      <div className="devices-section"><span className="rail-heading">Android emulators<i>{android.length}</i></span>
        {list && !list.support.android && <div className="devices-note">{list.support.androidReason}</div>}
        {android.map(renderDevice)}
        {list?.support.android && android.length === 0 && <div className="devices-note">No AVDs. Create one in Android Studio → Device Manager.</div>}
      </div>
      {list?.errors.map(error => <div key={error} className="git-error">{error}</div>)}
      {!list && loading && <div className="devices-note">Looking for simulators…</div>}
    </div>
    <div className="devices-mirror">
      {mirrored ? <>
        <div className="mirror-bar"><span className="device-state-dot booted"/><span>{mirrored.name}</span><span className="chat-spacer"/>
          <span className={"mirror-fps" + (source === "window" || source === "stream" ? " live" : "")} title={source === "window" ? "The device window, captured live" : source === "stream" ? "The device screen as a live video stream" : "Device screenshots taken back to back"}>{source === "window" ? "● Live" : source === "stream" ? `● Live${measuredFps ? " · " + measuredFps + " fps" : ""}` : measuredFps ? `${measuredFps} fps` : "…"}</span>
          <button className="chat-icon-button" title="Send this screen to Claude" aria-label="Send this screen to Claude" onClick={() => sendScreenshot(mirrored)}><Glyph name="chat" size={14}/></button>
          <button className="chat-icon-button" title="Stop mirroring" aria-label="Stop mirroring" onClick={() => setMirrorId(null)}>×</button></div>
        <div ref={stageRef} className={"mirror-stage kind-" + mirrored.kind} tabIndex={0} onKeyDown={onKeyDown} onBlur={flushTyped} title="Click to tap, drag to swipe, type to enter text">{source === "stream" ? <canvas ref={canvasRef} className="mirror-video mirror-canvas" style={shown} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { pressRef.current = null; }}/> : liveStream ? <video ref={videoRef} className="mirror-video" style={shown} muted playsInline onLoadedMetadata={event => measureMedia(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} onResize={event => measureMedia(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { pressRef.current = null; }}/> : frame ? <img src={frame} alt={`${mirrored.name} screen`} style={shown} draggable={false} onLoad={event => measureMedia(event.currentTarget.naturalWidth / (mirrored.platform === "ios" ? 1.5 : 1), event.currentTarget.naturalHeight / (mirrored.platform === "ios" ? 1.5 : 1))} onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { pressRef.current = null; }}/> : <div className="devices-note">{frameError || "Capturing the screen…"}</div>}</div>
        <div className="mirror-controls">
          <button onClick={() => sendInput({ type: "key", key: "home" })} title="Home">⌂ Home</button>
          {mirrored.platform === "android" && <button onClick={() => sendInput({ type: "key", key: "back" })} title="Back">← Back</button>}
          <button onClick={() => sendInput({ type: "key", key: mirrored.platform === "android" ? "power" : "lock" })} title="Lock / power">⏻</button>
          <span className="mirror-sep"/>
          <button onClick={toggleAppearance} title={appearance === "dark" ? "Switch the device to light mode" : "Switch the device to dark mode"} aria-label="Toggle dark mode">{appearance === "dark" ? "☾ Dark" : "☀ Light"}</button>
          <button className={recording ? "mirror-rec on" : "mirror-rec"} onClick={toggleRecording} title={recording ? "Stop and save the recording" : "Record the screen as a video"}>{recording ? `■ ${Math.floor((now - recording.startedAt) / 60000)}:${String(Math.floor((now - recording.startedAt) / 1000) % 60).padStart(2, "0")}` : "● Rec"}</button>
          <span className="mirror-logs"><button onClick={() => setLogsMenu(open => !open)} title="Send the device logs to Claude" aria-expanded={logsMenu}>Logs ▾</button>
            {logsMenu && <span className="mirror-logs-menu" role="menu"><button role="menuitem" onClick={() => sendLogs(true)}>Errors → Claude</button><button role="menuitem" onClick={() => sendLogs(false)}>All logs (2 min) → Claude</button></span>}</span>
          <span className="mirror-hint">{inputNote || (mirrored.platform === "ios" && list?.support.idb === false ? "Tap and type work through macOS accessibility; install idb for precise swipes (brew install idb-companion, pip3 install fb-idb)." : "Click to tap · drag to swipe · type to enter text")}</span>
        </div>
        {frameError && frame && <div className="devices-note mirror-error">{frameError}</div>}
        {lastRecording && <div className="mirror-recording"><span>🎬 {lastRecording.seconds} s recorded</span><button onClick={sendRecording}>Send to Claude</button><button onClick={() => window.zevrinDesktop?.deviceRevealRecording(lastRecording.file)}>Show in Finder</button><button aria-label="Dismiss" onClick={() => setLastRecording(null)}>×</button></div>}
        {(source === "frames" || (source === "stream" && needsPermission)) && windowNote && <div className="devices-note mirror-window-note">{windowNote}{needsPermission && <button type="button" onClick={() => window.zevrinDesktop?.openScreenRecordingSettings()}>Open Screen Recording settings</button>}{source === "frames" && mirrored.platform === "ios" && list?.support.idb === false && <small>Or install idb for a smooth video stream without it: brew install facebook/fb/idb-companion &amp;&amp; pip3 install fb-idb</small>}</div>}
      </> : <div className="mirror-empty"><Glyph name="phone" size={30}/><strong>{list && list.devices.some(device => device.state === "booted") ? "Pick a running device to mirror its screen here" : "Boot a simulator to see it here"}</strong><small>The device window stays available on the Mac; this tile mirrors it, opens URLs, installs builds and sends screenshots to Claude.</small></div>}
    </div>
  </div>;
}
