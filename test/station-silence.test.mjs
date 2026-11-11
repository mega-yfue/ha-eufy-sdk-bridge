// The guard that recovers a station which stops answering the direct history read: reopen the session
// after `threshold` silent reads, exit for a restart after as many again, and never count a station that
// has not answered since boot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStationSilenceGuard } from "../src/station-silence.mjs";

function harness(threshold = 3) {
  const calls = [];
  const guard = createStationSilenceGuard({
    threshold,
    recycle: async (sn) => calls.push(`recycle ${sn}`),
    restart: () => calls.push("restart"),
  });
  const silent = (sn = "HB1") => guard.noteRead(sn, { answered: false, answeredBefore: true });
  const answered = (sn = "HB1") => guard.noteRead(sn, { answered: true, answeredBefore: true });
  return { guard, calls, silent, answered };
}

test("a station that has never answered is left alone", async () => {
  const { guard, calls } = harness();
  for (let i = 0; i < 10; i++) await guard.noteRead("HB1", { answered: false, answeredBefore: false });
  assert.deepEqual(calls, []);
});

test("silent reads below the threshold do nothing", async () => {
  const { calls, silent } = harness();
  await silent();
  await silent();
  assert.deepEqual(calls, []);
});

test("reaching the threshold reopens the station's connection once", async () => {
  const { calls, silent } = harness();
  for (let i = 0; i < 3; i++) await silent();
  assert.deepEqual(calls, ["recycle HB1"]);
});

test("an answer resets the count", async () => {
  const { calls, silent, answered } = harness();
  await silent();
  await silent();
  await answered();
  await silent();
  await silent();
  assert.deepEqual(calls, []);
});

test("still silent after the reopen: exit for a restart", async () => {
  const { calls, silent } = harness();
  for (let i = 0; i < 6; i++) await silent();
  assert.deepEqual(calls, ["recycle HB1", "restart"]);
});

test("an answer after the reopen means the next stall reopens again rather than restarting", async () => {
  const { calls, silent, answered } = harness();
  for (let i = 0; i < 3; i++) await silent();
  await answered();
  for (let i = 0; i < 3; i++) await silent();
  assert.deepEqual(calls, ["recycle HB1", "recycle HB1"]);
});

test("stations are tracked separately", async () => {
  const { calls, silent } = harness();
  await silent("HB1");
  await silent("HB2");
  await silent("HB1");
  await silent("HB2");
  assert.deepEqual(calls, []);
  await silent("HB1");
  assert.deepEqual(calls, ["recycle HB1"]);
});

test("a failing reopen is logged, not thrown, and still counts as the reopen", async () => {
  const calls = [];
  const guard = createStationSilenceGuard({
    recycle: async () => {
      calls.push("recycle");
      throw new Error("connect timeout");
    },
    restart: () => calls.push("restart"),
    log: (m) => calls.push(m.includes("connect timeout") ? "logged" : "log"),
  });
  const silent = () => guard.noteRead("HB1", { answered: false, answeredBefore: true });
  for (let i = 0; i < 6; i++) await silent();
  assert.ok(calls.includes("logged"));
  assert.equal(calls.filter((c) => c === "recycle").length, 1);
  assert.equal(calls.at(-1), "restart");
});

test("threshold 0 turns the guard off", async () => {
  const { calls, silent } = harness(0);
  for (let i = 0; i < 10; i++) await silent();
  assert.deepEqual(calls, []);
});

test("a read that names no station is not counted", async () => {
  const { guard, calls } = harness();
  for (let i = 0; i < 6; i++) await guard.noteRead(undefined, { answered: false, answeredBefore: true });
  assert.deepEqual(calls, []);
});
