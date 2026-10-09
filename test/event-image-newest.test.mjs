// /event-image serves the newest picture: the retained push thumbnail, or a HomeBase local cover persisted
// after it. On a local-storage account the cloud attaches a thumbnail to only some events, so the retained
// one goes stale while the on-detection refresh keeps writing newer covers (ha-eufy-sdk-bridge#97).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHttpHandler } from "../src/http-routes.mjs";
import { createState } from "../src/state.mjs";
import { loadConfig } from "../src/config.mjs";

const PUSH_A = Buffer.from("push-thumbnail-A");
const COVER_B = Buffer.from("local-cover-B");
const PUSH_C = Buffer.from("push-thumbnail-C");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "event-image-"));
  const t = { dir, file: path.join(dir, "last-event-CAM1.jpg"), stored: PUSH_A };
  const state = createState();
  state.flags.ready = true;
  const handler = createHttpHandler({
    ...loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" }),
    state,
    eventImageDir: dir,
    eventLog: () => {},
    autoHealEventImage: () => {},
    eufy: { getDevice: async () => ({ camera: () => ({ snapshotStored: async () => t.stored }) }) },
  });
  t.get = () =>
    new Promise((resolve) => {
      const chunks = [];
      const res = {
        writeHead() {},
        setHeader() {},
        end(body) {
          if (body) chunks.push(Buffer.from(body));
          resolve(Buffer.concat(chunks));
        },
      };
      handler({ url: "/event-image/CAM1", headers: { host: "x" }, method: "GET" }, res);
    });
  return t;
}

const later = () => new Promise((r) => setTimeout(r, 15)); // past mtime resolution
const settle = () => new Promise((r) => setTimeout(r, 15)); // let the best-effort persist land

test("a local cover written after the retained push thumbnail is served, and not overwritten", async () => {
  const t = setup();
  assert.deepEqual(await t.get(), PUSH_A); // first event: the push thumbnail
  await settle();
  await later();
  fs.writeFileSync(t.file, COVER_B); // the HomeBase refresh persists a later event's cover
  assert.deepEqual(await t.get(), COVER_B);
  await settle();
  assert.deepEqual(fs.readFileSync(t.file), COVER_B, "the cover stays on disk");
  assert.deepEqual(await t.get(), COVER_B, "and keeps being served on re-pulls");
});

test("a newer push thumbnail wins over an older local cover", async () => {
  const t = setup();
  fs.writeFileSync(t.file, COVER_B);
  await later();
  t.stored = PUSH_C; // a push with its own thumbnail arrives after the cover
  assert.deepEqual(await t.get(), PUSH_C);
  await settle();
  assert.deepEqual(fs.readFileSync(t.file), PUSH_C);
});
