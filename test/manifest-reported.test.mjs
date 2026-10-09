// The property manifest carries the SDK's `reported` flag, so a host can keep a read-only property the
// device never reports out of view instead of showing it as unknown for good (ha-eufy-sdk#64).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceView } from "../src/device-view.mjs";

function specsOf(properties) {
  const dev = { properties, describe: () => ({ details: [] }) };
  return createDeviceView({ eufy: {}, state: { streaming: new Set() } }).propertySpecs(dev);
}

test("the manifest passes through whether the device has reported each property", () => {
  const specs = specsOf([
    { name: "battery", type: "number", writable: false, reported: true },
    { name: "solarIntensity", type: "number", writable: false, reported: false },
  ]);
  assert.deepEqual(
    specs.map((p) => [p.name, p.reported]),
    [
      ["battery", true],
      ["solarIntensity", false],
    ],
  );
});

test("an SDK without the flag leaves it undefined, not false", () => {
  const [spec] = specsOf([{ name: "battery", type: "number", writable: false }]);
  assert.equal(spec.reported, undefined);
});
