// The manual "Refresh Last Event" (WS event.refresh) must answer before Home Assistant's 15s call timeout,
// even while the cover query or the stored-thumbnail follow is still running (ha-eufy-sdk#73). A refresh
// still running at the bound finishes in the background and nudges HA when its image lands.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWarmup } from "../src/warmup.mjs";

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-refresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const broadcasts = [];
  let release;
  const thumbnail = new Promise((r) => (release = r)); // the slow part: a thumbnail still downloading
  const warm = createWarmup({
    eventImageDir: dir,
    eventLog: () => {},
    broadcast: (msg) => broadcasts.push(msg),
    state: { faceNames: new Map() },
    eufy: {
      getDevice: async () => ({ camera: () => ({ snapshotStored: () => thumbnail }) }),
      getP2pSessions: () => new Map(),
    },
  });
  return { warm, broadcasts, release };
}

test("a slow refresh answers within the bound, then nudges HA once its image lands", async (t) => {
  const { warm, broadcasts, release } = setup(t);
  const started = Date.now();
  assert.equal(await warm.forceRefreshEventImage("SN1", { answerWithinMs: 20 }), false);
  assert.ok(Date.now() - started < 1000, "answered at the bound, not when the refresh finished");
  assert.equal(broadcasts.length, 0);

  release(Buffer.from("new-thumbnail"));
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(broadcasts, [{ event: "eventImageUpdated", deviceSn: "SN1" }]);
});

test("a refresh that finishes in time answers with its result", async (t) => {
  const { warm, release } = setup(t);
  release(Buffer.from("new-thumbnail"));
  assert.equal(await warm.forceRefreshEventImage("SN1", { answerWithinMs: 1000 }), true);
});
