import assert from "node:assert/strict";
import test from "node:test";
import previewAgent from "../electron/preview-agent.cjs";

const { formatNetwork, pickKeyframes, summarizeRequest } = previewAgent;

test("network summaries and keyframe picking on the main side", () => {
  const request = summarizeRequest({ url: "http://x/api", method: "GET", status: 404, start: 1, end: 1.25, type: "Fetch" });
  assert.deepEqual(request, { url: "http://x/api", method: "GET", status: 404, type: "Fetch", failed: false, error: null, ms: 250, size: null });
  assert.equal(formatNetwork([request], { failuresOnly: true }), "404 GET http://x/api 250ms");
  assert.equal(formatNetwork([], {}), "No requests recorded yet.");
  assert.equal(pickKeyframes(Array.from({ length: 100 }, (_, i) => i), 6).length, 6);
});
