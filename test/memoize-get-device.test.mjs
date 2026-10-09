import { test } from "node:test";
import assert from "node:assert/strict";
import { memoizeGetDevice } from "../src/client.mjs";

// A stand-in for the SDK client: counts real resolutions and serves a mutable device list.
function fakeEufy({ serials = ["A", "B"], failFor = new Set() } = {}) {
  const eufy = {
    calls: 0,
    serials,
    async getDevice(sn) {
      eufy.calls++;
      if (failFor.has(sn)) throw new Error(`no device ${sn}`);
      return { sn, build: eufy.calls };
    },
    async getDevices() {
      return eufy.serials.map((sn) => ({ sn }));
    },
  };
  memoizeGetDevice(eufy);
  return eufy;
}

test("memoizeGetDevice: a second getDevice(sn) returns the same object", async () => {
  const eufy = fakeEufy();
  const a1 = await eufy.getDevice("A");
  const a2 = await eufy.getDevice("A");
  assert.equal(a1, a2);
  assert.equal(eufy.calls, 1);
});

test("memoizeGetDevice: a rejected resolution is not cached", async () => {
  const failFor = new Set(["A"]);
  const eufy = fakeEufy({ failFor });
  await assert.rejects(eufy.getDevice("A"), /no device A/);
  failFor.delete("A");
  const a = await eufy.getDevice("A");
  assert.equal(a.sn, "A");
  assert.equal(eufy.calls, 2); // retried for real, not served the cached rejection
});

test("memoizeGetDevice: forgetDevices() drops every cached device", async () => {
  const eufy = fakeEufy();
  const a1 = await eufy.getDevice("A");
  const b1 = await eufy.getDevice("B");
  eufy.forgetDevices();
  assert.notEqual(await eufy.getDevice("A"), a1);
  assert.notEqual(await eufy.getDevice("B"), b1);
  assert.equal(eufy.calls, 4);
});

test("memoizeGetDevice: a serial missing from a fresh getDevices() is dropped, the rest kept", async () => {
  const eufy = fakeEufy();
  const a1 = await eufy.getDevice("A");
  const b1 = await eufy.getDevice("B");
  eufy.serials = ["B"]; // A left the account
  const list = await eufy.getDevices();
  assert.deepEqual(
    list.map((d) => d.sn),
    ["B"],
  );
  assert.equal(await eufy.getDevice("B"), b1); // still cached
  assert.notEqual(await eufy.getDevice("A"), a1); // re-resolved, not the stale model
  assert.equal(eufy.calls, 3);
});
