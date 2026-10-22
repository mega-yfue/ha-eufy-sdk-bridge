// "Take screenshot" stores a fresh still as the camera's last screen and announces it - only when asked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { takeScreenshot } from "../src/screenshot.mjs";

function ctxWith(cam) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-"));
  const sent = [];
  return {
    dir,
    sent,
    ctx: {
      eventImageDir: dir,
      eventLog: () => {},
      broadcast: (m) => sent.push(m),
      eufy: { getDevice: async () => ({ camera: () => cam }) },
    },
  };
}

test("a screenshot is kept as last-live-<sn>.jpg and broadcast as lastScreenUpdated", async () => {
  const { ctx, dir, sent } = ctxWith({ snapshotLive: async () => ({ jpeg: Buffer.from("FRESH") }) });
  assert.deepEqual(await takeScreenshot(ctx, "CAM1"), { bytes: 5 });
  assert.equal(fs.readFileSync(path.join(dir, "last-live-CAM1.jpg"), "utf8"), "FRESH");
  assert.deepEqual(sent, [{ event: "lastScreenUpdated", deviceSn: "CAM1" }]);
});

test("no picture from the camera keeps the old last screen and announces nothing", async () => {
  const { ctx, dir, sent } = ctxWith({ snapshotLive: async () => ({ jpeg: undefined }) });
  fs.writeFileSync(path.join(dir, "last-live-CAM1.jpg"), "OLD");
  await assert.rejects(takeScreenshot(ctx, "CAM1"), /no picture/);
  assert.equal(fs.readFileSync(path.join(dir, "last-live-CAM1.jpg"), "utf8"), "OLD");
  assert.deepEqual(sent, []);
});

test("a device without a camera is refused", async () => {
  const { ctx } = ctxWith(undefined);
  await assert.rejects(takeScreenshot(ctx, "HUB1"), /no camera/);
});
