import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";

const base = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" };

test("event pre-warm is OFF by default", () => {
  assert.equal(loadConfig(base).cfg.prewarm, false); // → client passes prewarmEvents: []
});

test("go2rtc is enabled by default and can be disabled with GO2RTC_ENABLE=0", () => {
  assert.equal(loadConfig(base).cfg.go2rtcEnable, true);
  assert.equal(loadConfig({ ...base, GO2RTC_ENABLE: "1" }).cfg.go2rtcEnable, true);
  assert.equal(loadConfig({ ...base, GO2RTC_ENABLE: "0" }).cfg.go2rtcEnable, false);
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

test("openudid is undefined by default and taken from BRIDGE_OPENUDID when set", () => {
  assert.equal(loadConfig(base).cfg.openudid, undefined); // → SDK derives from email
  assert.equal(loadConfig({ ...base, BRIDGE_OPENUDID: "abcd1234abcd1234" }).cfg.openudid, "abcd1234abcd1234");
  assert.equal(loadConfig({ ...base, BRIDGE_OPENUDID: "" }).cfg.openudid, undefined); // empty → default
});
