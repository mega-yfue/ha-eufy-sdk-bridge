import { test } from "node:test";
import assert from "node:assert/strict";
import { rosterEntry, firstJsonObject, createFaces } from "../src/faces.mjs";

test("rosterEntry: a named person is familiar, a stranger<n> placeholder is not", () => {
  assert.deepEqual(rosterEntry({ person_id: 5, name: "Alice", relation: "family" }), [
    5,
    { name: "Alice", familiar: true },
  ]);
  assert.deepEqual(rosterEntry({ person_id: 7, name: "stranger12" }), [7, { name: "stranger12", familiar: false }]);
  assert.deepEqual(rosterEntry({ person_id: "9", name: "Bob" }), [9, { name: "Bob", familiar: true }]);
});

test("rosterEntry: a row without a usable id or name ⇒ undefined", () => {
  assert.equal(rosterEntry({ name: "Alice" }), undefined);
  assert.equal(rosterEntry({ person_id: 5 }), undefined);
  assert.equal(rosterEntry(undefined), undefined);
});

test("firstJsonObject: skips leading junk + trailing padding", () => {
  assert.deepEqual(firstJsonObject('garbage {"data":[1,2]} trailing{'), { data: [1, 2] });
});

test("firstJsonObject: balances nested braces and braces inside strings", () => {
  assert.deepEqual(firstJsonObject('{"a":"}","b":{"c":1}}xxx'), { a: "}", b: { c: 1 } });
});

test("firstJsonObject: no object / malformed ⇒ undefined", () => {
  assert.equal(firstJsonObject("no braces"), undefined);
  assert.equal(firstJsonObject('{"a":}'), undefined);
});

test("enrichPersonName: resolves a known person, leaves others", () => {
  const ctx = { state: { faceNames: new Map([[5, { name: "Alice", familiar: true }]]) } };
  const { enrichPersonName } = createFaces(ctx);

  assert.deepEqual(enrichPersonName("personDetected", { person_id: 5 }), {
    person_id: 5,
    person_name: "Alice",
    recognized: true,
  });
  // unknown positive id ⇒ recognized:false, no name
  assert.deepEqual(enrichPersonName("personDetected", { person_id: 99 }), { person_id: 99, recognized: false });
  // person_id <= 0 ⇒ a person but no face match
  assert.deepEqual(enrichPersonName("personDetected", { person_id: -1 }), { person_id: -1, recognized: false });
  // a non-personDetected event is passed through untouched
  const motion = { deviceSn: "CAM1" };
  assert.equal(enrichPersonName("motion", motion), motion);
});
