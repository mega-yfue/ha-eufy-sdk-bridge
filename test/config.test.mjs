import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";

const base = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" };

test("event pre-warm is OFF by default", () => {
  assert.equal(loadConfig(base).cfg.prewarm, false); // → client passes prewarmEvents: []
  assert.equal(loadConfig(base).cfg.localEventRefresh, true); // default on
  assert.equal(loadConfig({ ...base, EUFY_LOCAL_EVENT_REFRESH: "0" }).cfg.localEventRefresh, false);
  assert.equal(loadConfig({ ...base, EUFY_LOCAL_EVENT_REFRESH: "off" }).cfg.localEventRefresh, false);
});

test("TRANSCODE_H264: empty by default, a comma- or space-separated list of serials otherwise", () => {
  assert.deepEqual(loadConfig(base).cfg.transcodeH264, []);
  assert.deepEqual(loadConfig({ ...base, TRANSCODE_H264: "T8170A, T8170B T8210C" }).cfg.transcodeH264, [
    "T8170A",
    "T8170B",
    "T8210C",
  ]);
});

test("TRANSCODE_WIDTH: 1280 by default, a custom width honoured, anything else keeps the camera's size", () => {
  assert.equal(loadConfig(base).cfg.transcodeWidth, 1280);
  assert.equal(loadConfig({ ...base, TRANSCODE_WIDTH: "1920" }).cfg.transcodeWidth, 1920);
  assert.equal(loadConfig({ ...base, TRANSCODE_WIDTH: "0" }).cfg.transcodeWidth, undefined);
  assert.equal(loadConfig({ ...base, TRANSCODE_WIDTH: "wide" }).cfg.transcodeWidth, undefined);
});

test("BRIDGE_PREWARM=1 turns pre-warm on (SDK default events)", () => {
  assert.equal(loadConfig({ ...base, BRIDGE_PREWARM: "1" }).cfg.prewarm, true);
  assert.equal(loadConfig({ ...base, BRIDGE_PREWARM: "true" }).cfg.prewarm, true);
  assert.equal(loadConfig({ ...base, BRIDGE_PREWARM: "0" }).cfg.prewarm, false);
});

test("FCM push store path is derived beside the session file", () => {
  assert.equal(loadConfig(base).cfg.pushSession, "data/.eufy-fcm.json"); // default session ./data/.eufy-session.json
  assert.equal(
    loadConfig({ ...base, EUFY_SESSION: "/app/data/.eufy-session.json" }).cfg.pushSession,
    "/app/data/.eufy-fcm.json",
  );
});

test("SOLIX_SCENE_POLL_MS: default 90s, and a custom value is honoured", () => {
  const solixEnv = { ...base, SOLIX_EMAIL: "s@a.z", SOLIX_PASSWORD: "sp" };
  assert.equal(loadConfig(solixEnv).cfg.solix.scenePollMs, 90_000); // default
  assert.equal(loadConfig({ ...solixEnv, SOLIX_SCENE_POLL_MS: "30000" }).cfg.solix.scenePollMs, 30_000);
  // A non-numeric / empty value falls back to the default rather than NaN.
  assert.equal(loadConfig({ ...solixEnv, SOLIX_SCENE_POLL_MS: "" }).cfg.solix.scenePollMs, 90_000);
});

test("SOLIX_RETRY_BASE_MS / SOLIX_RETRY_MAX_MS: defaults and custom values", () => {
  const solixEnv = { ...base, SOLIX_EMAIL: "s@a.z", SOLIX_PASSWORD: "sp" };
  const def = loadConfig(solixEnv).cfg.solix;
  assert.equal(def.retryBaseMs, 15 * 60 * 1000); // 15 min
  assert.equal(def.retryMaxMs, 60 * 60 * 1000); // 1 h
  const custom = loadConfig({ ...solixEnv, SOLIX_RETRY_BASE_MS: "60000", SOLIX_RETRY_MAX_MS: "300000" }).cfg.solix;
  assert.equal(custom.retryBaseMs, 60_000);
  assert.equal(custom.retryMaxMs, 300_000);
});

test("openudid is undefined by default and taken from BRIDGE_OPENUDID when set", () => {
  assert.equal(loadConfig(base).cfg.openudid, undefined); // → SDK derives from email
  assert.equal(loadConfig({ ...base, BRIDGE_OPENUDID: "abcd1234abcd1234" }).cfg.openudid, "abcd1234abcd1234");
  assert.equal(loadConfig({ ...base, BRIDGE_OPENUDID: "" }).cfg.openudid, undefined); // empty → default
});
