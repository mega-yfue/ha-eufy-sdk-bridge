import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWarmup } from "../src/warmup.mjs";

/**
 * A warmup whose camera serves `images` from `snapshotStored()` in turn (the last one repeats), with the
 * given bytes already persisted as the device's "Last event". Counts the camera lookups.
 */
function setup(t, images, persisted) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-image-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (persisted) fs.writeFileSync(path.join(dir, "last-event-SN1.jpg"), persisted);
  let lookups = 0;
  let served = 0;
  const camera = {
    snapshotStored: async () => images[Math.min(served++, images.length - 1)],
  };
  const warm = createWarmup({
    eventImageDir: dir,
    eventLog: () => {},
    broadcast: () => {},
    state: { faceNames: new Map() },
    eufy: {
      getDevice: async () => {
        lookups += 1;
        return { camera: () => camera };
      },
      getP2pSessions: () => new Map(),
    },
  });
  return { warm, dir, lookups: () => lookups, served: () => served };
}

const flush = () => new Promise((r) => setImmediate(r));

test("a detection keeps polling past the previous event's image until its own lands", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Buffer.from("previous");
  const next = Buffer.from("next");
  const { warm, dir, served } = setup(t, [previous, next], previous);

  const changed = warm.refreshStoredSnapshotFor("SN1", { waitForNew: true });
  await flush();
  t.mock.timers.tick(2500);

  assert.equal(await changed, true);
  assert.equal(served(), 2);
  assert.deepEqual(fs.readFileSync(path.join(dir, "last-event-SN1.jpg")), next);
});

test("a detection inside the local-cover window still follows its own thumbnail", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { warm, lookups } = setup(t, [Buffer.from("image")], Buffer.from("image"));

  warm.onDetectionRefresh("SN1");
  await flush();
  warm.onDetectionRefresh("SN1"); // the first detection's local-cover loop is still waiting
  await flush();

  assert.equal(lookups(), 2);
});
