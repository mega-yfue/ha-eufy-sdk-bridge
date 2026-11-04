import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createWarmup } from "../src/warmup.mjs";

/** createWarmup over a fake SDK that records every station DB query it is asked to make. */
function setup(localEventRefresh) {
  const asked = [];
  const ctx = {
    eventImageDir: os.tmpdir(),
    eventLog: () => {},
    broadcast: () => {},
    localEventRefresh,
    state: { faceNames: new Map() },
    eufy: {
      getP2pSessions: () => new Map([["HB1", {}]]),
      getStationFaces: async (sn) => {
        asked.push(`faces:${sn}`);
        return [];
      },
      getDevices: async () => {
        asked.push("getDevices");
        return [];
      },
    },
  };
  return { warm: createWarmup(ctx), asked };
}

test("EUFY_LOCAL_EVENT_REFRESH=0 makes the local-storage warm-ups and refreshes no-ops", async () => {
  const { warm, asked } = setup(false);
  await warm.warmFaceRoster();
  await warm.warmLastEventImages();
  warm.onDetectionRefresh("T8423X00000000");
  warm.autoHealEventImage("T8423X00000000");
  await new Promise((r) => setTimeout(r, 20)); // let any stray async settle
  assert.deepEqual(asked, [], "no HomeBase/local-storage P2P query should have been made");
  // The push-thumbnail path and explicit force stay available.
  assert.equal(typeof warm.refreshStoredSnapshotFor, "function");
  assert.equal(typeof warm.forceRefreshEventImage, "function");
});

test("default (flag on) still queries the station roster", async () => {
  const { warm, asked } = setup(true);
  await warm.warmFaceRoster();
  assert.deepEqual(asked, ["faces:HB1"]);
});
