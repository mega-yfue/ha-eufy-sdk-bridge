import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createWarmup } from "../src/warmup.mjs";

/** A warmup over a fake SDK whose stations answer `getStationFaces` from `rosters` (an Error rejects). */
function setup(rosters) {
  const asked = [];
  const faceNames = new Map();
  const sessions = new Map([...Object.keys(rosters), "HB1#live:0"].map((key) => [key, {}]));
  const ctx = {
    eventImageDir: os.tmpdir(),
    eventLog: () => {},
    broadcast: () => {},
    state: { faceNames },
    eufy: {
      getP2pSessions: () => sessions,
      getStationFaces: async (sn) => {
        asked.push(sn);
        if (rosters[sn] instanceof Error) throw rosters[sn];
        return rosters[sn];
      },
    },
  };
  return { warm: createWarmup(ctx), faceNames, asked };
}

test("warmFaceRoster merges every station's roster and skips media sessions", async () => {
  const { warm, faceNames, asked } = setup({
    HB1: [
      { person_id: 5, name: "Alice" },
      { person_id: 7, name: "stranger3" },
    ],
    HB2: [{ person_id: 9, name: "Bob" }, { name: "no id" }],
  });
  await warm.warmFaceRoster();
  assert.deepEqual(asked, ["HB1", "HB2"]); // the `#live:` media session is never queried
  assert.deepEqual(Object.fromEntries(faceNames), {
    5: { name: "Alice", familiar: true },
    7: { name: "stranger3", familiar: false },
    9: { name: "Bob", familiar: true },
  });
});

test("warmFaceRoster keeps going when one station fails", async () => {
  const { warm, faceNames } = setup({ HB1: new Error("no P2P session"), HB2: [{ person_id: 9, name: "Bob" }] });
  await warm.warmFaceRoster();
  assert.deepEqual(Object.fromEntries(faceNames), { 9: { name: "Bob", familiar: true } });
});
