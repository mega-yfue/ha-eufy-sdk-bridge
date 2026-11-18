import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createArmingConfirm, armingWire } from "../src/arming-confirm.mjs";

const tick = () => new Promise((r) => setImmediate(r));

// `mode` is each station's readback (wire integer); a station starts disarmed (63).
function harness({ readMode } = {}) {
  const eufy = new EventEmitter();
  const sent = [];
  const mode = { ST1: 63, ST2: 63 };
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
    await tick();
  };
  const emit = async (sn) => {
    h.eufy.emit("armingModeChanged", { deviceSn: sn });
    await tick();
  };
  const logs = [];
  const confirm = createArmingConfirm({
    eufy,
    log: (l) => logs.push(l),
    setTimer,
    clearTimer,
    retries: 2,
    readMode: readMode ?? (async (sn) => mode[sn]),
  });
  const h = { eufy, sent, mode, fire, emit, confirm, logs };
  return h;
}

test("armingWire takes either vocabulary", () => {
  assert.equal(armingWire("home"), 1);
  assert.equal(armingWire(63), 63);
  assert.equal(armingWire("0"), 0);
  assert.equal(armingWire("nope"), undefined);
  assert.equal(armingWire(undefined), undefined);
});

test("a confirmed mode write is not re-sent", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", "home");
  h.mode.ST1 = 1;
  await h.emit("ST1");
  await h.fire();
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirm.pendingCount(), 0);
});

test("an unconfirmed mode write is re-sent until the station confirms it", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", 1);
  await h.fire();
  assert.deepEqual(h.sent, [["ST1", "armingMode", 1]]);
  h.mode.ST1 = 1;
  await h.emit("ST1");
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.equal(h.confirm.pendingCount(), 0);
});

test("a write the station applied without an event is confirmed by readback, not re-sent", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", 1);
  h.mode.ST1 = 1;
  await h.fire();
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirm.pendingCount(), 0);
  assert.match(h.logs.at(-1), /confirmed by readback/);
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
  h.mode.ST2 = 1;
  await h.emit("ST2");
  await h.fire();
  assert.deepEqual(h.sent, [["ST1", "armingMode", 1]]);
});

test("an armingModeChanged to a different mode is not taken as confirmation, and is left alone", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", "home");
  h.mode.ST1 = 0; // keypad / app / schedule moved it to away, not the requested home
  await h.emit("ST1");
  await h.fire();
  assert.deepEqual(h.sent, []); // no re-send over the out-of-band choice
  assert.equal(h.confirm.pendingCount(), 0);
  assert.match(h.logs.at(-1), /changed to 0 .*not the requested/);
});

test("an event whose readback has not converged yet still confirms the write", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", "home");
  await h.emit("ST1"); // readback still 63, the pre-write mode
  await h.fire();
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirm.pendingCount(), 0);
});

test("an out-of-band change between the write and the retry timer is not clobbered", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", "home");
  h.mode.ST1 = 0; // changed to away by someone else, and no event reached the bridge
  await h.fire();
  assert.deepEqual(h.sent, []);
  assert.equal(h.confirm.pendingCount(), 0);
  assert.match(h.logs.at(-1), /out of band/);
});

test("an out-of-band change after a re-send stops further re-sends", async () => {
  const h = harness();
  h.confirm.sending("ST1", "armingMode", 1);
  await h.fire();
  assert.equal(h.sent.length, 1);
  h.mode.ST1 = 0;
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.equal(h.confirm.pendingCount(), 0);
});

test("an unreadable mode keeps the old behaviour: re-send, confirm on the event", async () => {
  const h = harness({ readMode: async () => undefined });
  h.confirm.sending("ST1", "armingMode", 1);
  await h.fire();
  assert.deepEqual(h.sent, [["ST1", "armingMode", 1]]);
  await h.emit("ST1");
  assert.equal(h.confirm.pendingCount(), 0);
});

test("a newer write replaces the held one and keeps the pre-write baseline", async () => {
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
