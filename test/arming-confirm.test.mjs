import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createArmingConfirm } from "../src/arming-confirm.mjs";

function harness() {
  const eufy = new EventEmitter();
  const sent = [];
  eufy.setProperty = async (sn, name, value) => void sent.push([sn, name, value]);
  const timers = [];
  const setTimer = (fn) => {
    const t = { fn, cleared: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => t && (t.cleared = true);
  const fire = async () => {
    const live = timers.filter((t) => !t.cleared);
    for (const t of live) t.cleared = true;
    for (const t of live) await t.fn();
    await new Promise((r) => setImmediate(r));
  };
  const logs = [];
  const confirm = createArmingConfirm({ eufy, log: (l) => logs.push(l), setTimer, clearTimer, retries: 2 });
  return { eufy, sent, fire, confirm, logs };
}

test("a confirmed mode write is not re-sent", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", 1);
  h.eufy.emit("armingModeChanged", { deviceSn: "ST1" });
  await h.fire();
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirm.pendingCount(), 0);
});

test("an unconfirmed mode write is re-sent until the station confirms it", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", 1);
  await h.fire();
  assert.deepEqual(h.sent, [["ST1", "armingMode", 1]]);
  h.eufy.emit("armingModeChanged", { deviceSn: "ST1" });
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.equal(h.confirm.pendingCount(), 0);
});

test("re-sends stop after the retry budget", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", 1);
  await h.fire();
  await h.fire();
  await h.fire();
  await h.fire();
  assert.equal(h.sent.length, 2);
  assert.equal(h.confirm.pendingCount(), 0);
  assert.match(h.logs.at(-1), /NOT confirmed/);
});

test("another station's confirmation does not count", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", 1);
  h.eufy.emit("armingModeChanged", { deviceSn: "ST2" });
  await h.fire();
  assert.deepEqual(h.sent, [["ST1", "armingMode", 1]]);
});

test("a newer write replaces the held one", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", 1);
  h.confirm.sending("ST1", "armingMode", 2);
  await h.fire();
  assert.deepEqual(h.sent, [["ST1", "armingMode", 2]]);
});

test("other properties and failed writes are not held", async () => {
  const h = harness();
  h.confirm.sending("ST1", "lightOn", true);
  h.confirm.sending("ST2", "armingMode", 1);
  h.confirm.failed("ST2", "armingMode");
  await h.fire();
  assert.deepEqual(h.sent, []);
});
