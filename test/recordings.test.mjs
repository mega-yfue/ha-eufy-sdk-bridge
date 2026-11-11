// A HomeBase 3 camera's stored recordings over HTTP: the list read from the station's table, and one
// served by name as an mp4.
import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { recordingOf } from "../src/recordings.mjs";
import { row, setup, get, files } from "./helpers/recordings-fixture.mjs";

test("recordingOf: names a row's recording by its stamp, starting at the stamp in the row's zone", () => {
  const rec = recordingOf(row("CAM1", "20260101120041", { start_time: "2026-01-01 12:00:44" }));
  assert.equal(rec.name, "20260101120041");
  assert.equal(rec.start.toISOString(), "2026-01-01T18:00:41.000Z");
  assert.equal(rec.end.toISOString(), "2026-01-01T18:00:59.000Z");
  assert.equal(rec.cipherId, 0);
  assert.equal(recordingOf(row("CAM1", "20260101120041", { cipher_id: 0x1234500a })).cipherId, 0x0a);
});

test("recordingOf: skips a row that stored no video", () => {
  assert.equal(recordingOf(row("CAM1", "20260101120041", { storage_path: "", frame_num: 0 })), undefined);
  assert.equal(recordingOf(row("CAM1", "20260101120041", { frame_num: 0 })), undefined);
});

test("/recordings: lists one camera's recordings from the station's table, newest first", async () => {
  const rows = [row("CAM1", "20260101120000"), row("CAM2", "20260101121000"), row("CAM1", "20260101130000")];
  const { handler, calls } = setup({ rows });
  const out = await get(handler, "/recordings/CAM1");
  assert.equal(out.code, 200);
  const { recordings } = JSON.parse(out.body);
  assert.deepEqual(
    recordings.map((r) => [r.name, r.cipherId, r.start, r.frames, r.trigger]),
    [
      ["20260101130000", 0, "2026-01-01T19:00:00.000Z", 300, 4],
      ["20260101120000", 0, "2026-01-01T18:00:00.000Z", 300, 4],
    ],
  );
  assert.equal(calls.locked, 1); // the table read shares the station's DB stream, so it takes the lock
});

test("/recording: downloads a recording by name and serves the mp4, leaving no file behind", async () => {
  const { handler, calls, dir } = setup();
  const out = await get(handler, "/recording/CAM1/20260101120000.mp4");
  assert.equal(out.code, 200);
  assert.equal(out.headers["content-type"], "video/mp4");
  assert.equal(out.body.toString(), "MP4:CAM1:20260101120000");
  assert.deepEqual(calls.download, [{ sn: "CAM1", recording: "20260101120000", cipherId: 0 }]);
  assert.deepEqual(files(dir), []);
});

test("/recording: 400 for a name that is not a stamp, 404 for one the station does not hold", async () => {
  const { handler, calls } = setup({
    download: () => {
      throw Object.assign(new Error("the station holds no recording"), { reason: "no-data" });
    },
  });
  assert.equal((await get(handler, "/recording/CAM1/latest.mp4")).code, 400);
  assert.equal(calls.download.length, 0);
  const out = await get(handler, "/recording/CAM1/20200101000000");
  assert.equal(out.code, 404);
  assert.equal(JSON.parse(out.body).reason, "no-data");
});

test("/recording: two requests for the same recording each get the whole mp4", async () => {
  let muxes = 0;
  const { handler, dir } = setup({
    muxClip: async (clip, out) => {
      const wait = 5 * ++muxes; // each ffmpeg run takes a different while, so the requests overlap
      await fs.promises.writeFile(out, Buffer.concat([Buffer.from("MP4:"), clip.video]));
      await new Promise((r) => setTimeout(r, wait));
    },
  });
  const outs = await Promise.all([1, 2, 3].map(() => get(handler, "/recording/CAM1/20260101120000.mp4")));
  assert.deepEqual(
    outs.map((o) => [o.code, String(o.body)]),
    [1, 2, 3].map(() => [200, "MP4:CAM1:20260101120000"]),
  );
  assert.deepEqual(files(dir), []);
});
