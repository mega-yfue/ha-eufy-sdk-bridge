import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceView } from "../src/device-view.mjs";

// The SDK states a write-only setting in two halves: `unobservableMembers(dev.siren())` names it, and the
// device manifest carries its setter with a described argument. The fake device below carries both.
function fakeDevice() {
  const siren = { alarmVolume: undefined };
  return {
    sn: "T8030TEST",
    siren: () => siren,
    describe: () => ({
      sn: "T8030TEST",
      name: "Base",
      model: "T8030",
      modelName: "HomeBase 3",
      codec: "station",
      capabilities: ["siren"],
      details: [
        {
          capability: "siren",
          accessor: "siren",
          reads: [{ accessor: "hubAlarmTone", property: "hubAlarmTone", type: "enum", writable: true }],
          actions: [
            {
              name: "setAlarmVolume",
              form: "momentary",
              args: [{ name: "alarmVolume", kind: "percent", min: 0, max: 100 }],
              description: "HomeBase alarm volume",
            },
          ],
          undescribedActions: [],
          events: [],
        },
      ],
    }),
    getProperties: () => ({ promptVolume: { value: 26 } }),
    properties: [{ name: "hubAlarmTone", type: "enum", writable: true, enumValues: { 0: "Tone1" } }],
  };
}

const view = (names) =>
  createDeviceView({ eufy: {}, state: { streaming: new Map() }, unobservableMembers: () => names });

test("propertySpecs appends the write-only settings the SDK states, marked writeOnly + writable, with bounds", () => {
  const specs = view(["alarmVolume"]).propertySpecs(fakeDevice());
  const tone = specs.find((s) => s.name === "hubAlarmTone");
  const vol = specs.find((s) => s.name === "alarmVolume");
  assert.ok(tone, "reported property is still present");
  assert.ok(vol, "write-only setting is exposed");
  assert.equal(vol.writeOnly, true);
  assert.equal(vol.writable, true);
  assert.equal(vol.type, "number");
  assert.equal(vol.unit, "%");
  assert.equal(vol.min, 0);
  assert.equal(vol.max, 100);
  assert.equal(vol.kind, "percent");
  assert.equal(vol.description, "HomeBase alarm volume");
  // A reported property carries no writeOnly flag.
  assert.equal(tone.writeOnly, undefined);
});

test("a write-only setting whose name a reported property already carries is dropped", () => {
  const dev = fakeDevice();
  dev.properties.push({ name: "alarmVolume", type: "number", writable: true, kind: "percent", unit: "%" });
  const specs = view(["alarmVolume"]).propertySpecs(dev);
  const av = specs.filter((s) => s.name === "alarmVolume");
  assert.equal(av.length, 1, "only one alarmVolume spec");
  assert.equal(av[0].writeOnly, undefined, "the reported one wins");
});

test("a member named unobservable but whose setter has no described argument is not offered", () => {
  const dev = fakeDevice();
  const specs = view(["alarmVolume", "mystery"]).propertySpecs(dev);
  assert.equal(
    specs.some((s) => s.name === "mystery"),
    false,
  );
});

test("a device with no capability manifest exposes only its reported properties", () => {
  const dev = {
    sn: "X",
    getProperties: () => ({}),
    properties: [{ name: "battery", type: "number", writable: false }],
  };
  const specs = view([]).propertySpecs(dev);
  assert.deepEqual(
    specs.map((s) => s.name),
    ["battery"],
  );
});
