// Annex B H.264 byte stream (adb screenrecord, idb video-stream) → access units ready for WebCodecs' VideoDecoder.

export type AccessUnit = { data: Uint8Array; key: boolean };

const START = new Uint8Array([0, 0, 0, 1]);

function nalType(nal: Uint8Array) { return nal[0] & 0x1f; }
function isVcl(nal: Uint8Array) { const type = nalType(nal); return type === 1 || type === 5; }
// first_mb_in_slice is the first ue(v) of the slice header: it is 0 exactly when the first bit after the NAL header is 1.
function startsPicture(nal: Uint8Array) { return nal.length > 1 && (nal[1] & 0x80) !== 0; }

// avc1.PPCCLL from an SPS NAL (profile, constraint flags, level).
export function codecFromSps(sps: Uint8Array) {
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return "avc1." + hex(sps[1]) + hex(sps[2]) + hex(sps[3]);
}

export class H264Assembler {
  private buffer = new Uint8Array(0);
  private pending: Uint8Array[] = [];
  private pendingHasVcl = false;
  private pendingKey = false;
  sps: Uint8Array | null = null;

  constructor(private onUnit: (unit: AccessUnit) => void, private onSps?: (sps: Uint8Array) => void) {}

  // Adds bytes; complete NAL units are grouped into access units (one picture each).
  push(chunk: Uint8Array) {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer); joined.set(chunk, this.buffer.length);
    let start = -1;
    let index = 0;
    const nals: Uint8Array[] = [];
    while (index + 3 <= joined.length) {
      if (joined[index] === 0 && joined[index + 1] === 0 && joined[index + 2] === 1) {
        const codeStart = index > 0 && joined[index - 1] === 0 ? index - 1 : index;
        if (start >= 0) nals.push(joined.subarray(start, codeStart));
        start = index + 3;
        index += 3;
      } else index += 1;
    }
    // Keep the last (maybe incomplete) NAL unit with its start code for the next push.
    this.buffer = start >= 0 ? joined.slice(start - 3) : joined;
    for (const nal of nals) this.addNal(nal);
  }

  // The producer writes whole pictures: when no more bytes come for a moment, the tail is a complete NAL unit, so the
  // current picture is shown now instead of waiting for the next one (the screen may not change for a while).
  flush() {
    if (this.buffer.length > 3 && this.buffer[0] === 0 && this.buffer[1] === 0 && this.buffer[2] === 1) { this.addNal(this.buffer.slice(3)); this.buffer = new Uint8Array(0); }
    this.emit();
  }

  private addNal(nal: Uint8Array) {
    if (!nal.length) return;
    const type = nalType(nal);
    if (type === 7) { this.sps = nal.slice(); this.onSps?.(this.sps); }
    // A new picture begins at an access unit delimiter, parameter sets or SEI after a picture, or a slice with first_mb 0.
    if (this.pendingHasVcl && ((type >= 6 && type <= 9) || (isVcl(nal) && startsPicture(nal)))) this.emit();
    this.pending.push(nal);
    if (isVcl(nal)) { this.pendingHasVcl = true; if (type === 5) this.pendingKey = true; }
  }

  private emit() {
    if (!this.pendingHasVcl) return;
    const parts: Uint8Array[] = [];
    for (const nal of this.pending) parts.push(START, nal);
    this.onUnit({ data: concat(parts), key: this.pendingKey });
    this.pending = []; this.pendingHasVcl = false; this.pendingKey = false;
  }
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
