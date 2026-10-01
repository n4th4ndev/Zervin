import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../app/h264-stream.ts", import.meta.url), "utf8");
const ts = (await import("typescript")).default;
const { H264Assembler, codecFromSps } = await import("data:text/javascript;base64," + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64"));

const sps = [0x67, 0x64, 0x00, 0x1f, 0xac];
const pps = [0x68, 0xee, 0x3c];
const idr = [0x65, 0x88, 0x84, 0x21];
const slice = n => [0x41, 0x9a, n, 0x11];
const code4 = [0, 0, 0, 1], code3 = [0, 0, 1];

test("the codec string comes from the SPS profile and level", () => {
  assert.equal(codecFromSps(new Uint8Array(sps)), "avc1.64001f");
});

test("a byte stream split anywhere becomes one access unit per picture, key frames flagged", () => {
  const stream = new Uint8Array([...code4, ...sps, ...code4, ...pps, ...code4, ...idr, ...code3, ...slice(1), ...code4, ...slice(2), ...code4, ...slice(3)]);
  for (const size of [1, 3, 7, 64]) {
    const units = [];
    let seenSps = null;
    const assembler = new H264Assembler(unit => units.push(unit), value => { seenSps = value; });
    for (let offset = 0; offset < stream.length; offset += size) assembler.push(stream.subarray(offset, offset + size));
    assert.equal(units.length, 2, "size " + size);
    assembler.flush();
    assert.equal(units.length, 4);
    assert.deepEqual(units.map(unit => unit.key), [true, false, false, false]);
    assert.deepEqual([...units[0].data], [...code4, ...sps, ...code4, ...pps, ...code4, ...idr]);
    assert.deepEqual([...units[3].data], [...code4, ...slice(3)]);
    assert.equal(codecFromSps(seenSps), "avc1.64001f");
  }
});
