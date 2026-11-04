// LOG_TIMESTAMPS: every console line starts with the local time of day, once even if installed twice.
import { test } from "node:test";
import assert from "node:assert/strict";

import { installConsoleTimestamps, timeOfDay } from "../src/log-time.mjs";

test("timeOfDay pads hours, minutes, seconds and milliseconds", () => {
  assert.equal(timeOfDay(new Date(2026, 9, 17, 7, 5, 3, 9)), "07:05:03.009");
});

test("console lines get one time prefix, even when installed twice", () => {
  const lines = [];
  const target = { log: (...a) => lines.push(a), info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const now = () => new Date(2026, 9, 17, 21, 55, 51, 120);
  installConsoleTimestamps(target, now);
  installConsoleTimestamps(target, now);
  target.log("[bridge] ready", 3);
  assert.deepEqual(lines, [["21:55:51.120", "[bridge] ready", 3]]);
});
