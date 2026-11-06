import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { prewarmEventsFor, PREWARM_EVENTS } from "../src/client.mjs";

const base = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" };

test("event pre-warm is OFF by default", () => {
  assert.equal(loadConfig(base).cfg.prewarm, false); // → client passes prewarmEvents: []
  assert.equal(loadConfig(base).cfg.localEventRefresh, true); // default on
  assert.equal(loadConfig({ ...base, EUFY_LOCAL_EVENT_REFRESH: "0" }).cfg.localEventRefresh, false);
  assert.equal(loadConfig({ ...base, EUFY_LOCAL_EVENT_REFRESH: "off" }).cfg.localEventRefresh, false);
});

test("BRIDGE_PREWARM=1 turns pre-warm on", () => {
  assert.equal(loadConfig({ ...base, BRIDGE_PREWARM: "1" }).cfg.prewarm, true);
  assert.equal(loadConfig({ ...base, BRIDGE_PREWARM: "true" }).cfg.prewarm, true);
  assert.equal(loadConfig({ ...base, BRIDGE_PREWARM: "0" }).cfg.prewarm, false);
  assert.equal(loadConfig(base).cfg.personFromRecord, false); // default off
  assert.equal(loadConfig({ ...base, EUFY_PERSON_FROM_RECORD: "1" }).cfg.personFromRecord, true);
});

test("pre-warm on names the four high-intent events; off names none (#145)", () => {
  // The SDK turns an undefined `prewarmEvents` into an empty set, so the bridge must list the events itself.
  assert.deepEqual(prewarmEventsFor(true), ["doorbellPress", "personDetected", "petDetection", "packageDelivered"]);
  assert.deepEqual(prewarmEventsFor(true), [...PREWARM_EVENTS]);
  assert.deepEqual(prewarmEventsFor(false), []);
  assert.notEqual(prewarmEventsFor(true), prewarmEventsFor(true)); // a fresh array per client, never the frozen list
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

test("go2rtc ports: 1984/8554/8555 by default, GO2RTC_*_PORT moves each", () => {
  const def = loadConfig(base).cfg;
  assert.deepEqual([def.go2rtcApiPort, def.go2rtcRtspPort, def.go2rtcWebrtcPort], [1984, 8554, 8555]);
  const moved = loadConfig({
    ...base,
    GO2RTC_API_PORT: "11984",
    GO2RTC_RTSP_PORT: "18554",
    GO2RTC_WEBRTC_PORT: "18555",
  }).cfg;
  assert.deepEqual([moved.go2rtcApiPort, moved.go2rtcRtspPort, moved.go2rtcWebrtcPort], [11984, 18554, 18555]);
  // Not a port → the default, never NaN in the YAML or the URL.
  assert.equal(loadConfig({ ...base, GO2RTC_RTSP_PORT: "" }).cfg.go2rtcRtspPort, 8554);
  assert.equal(loadConfig({ ...base, GO2RTC_RTSP_PORT: "rtsp" }).cfg.go2rtcRtspPort, 8554);
});

test("openudid is undefined by default and taken from BRIDGE_OPENUDID when set", () => {
  assert.equal(loadConfig(base).cfg.openudid, undefined); // → SDK derives from email
  assert.equal(loadConfig({ ...base, BRIDGE_OPENUDID: "abcd1234abcd1234" }).cfg.openudid, "abcd1234abcd1234");
  assert.equal(loadConfig({ ...base, BRIDGE_OPENUDID: "" }).cfg.openudid, undefined); // empty → default
});
