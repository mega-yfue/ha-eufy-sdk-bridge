// The debug push trace names a push's fields so an unmapped push can be described from a log, and never
// prints the values, which can carry names, ids and URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushFieldSummary } from "../src/push-trace.mjs";

test("a push is summarised by its type, device and sorted field names", () => {
  const line = pushFieldSummary({
    eventType: 1,
    deviceSn: "T8113P0000000000",
    payload: { a: 1, s: "T8010P0000000000", i: "fetch-0001", f: "Synthetic Person" },
  });
  assert.equal(line, "push raw: eventType=1 sn=T8113P0000000000 fields=[a,f,i,s]");
});

test("the values are never printed", () => {
  const line = pushFieldSummary({
    eventType: 3102,
    eventName: "face",
    payload: { f: "Synthetic Person", pic_url: "https://example.invalid/x.jpg" },
  });
  assert.equal(line, "push raw: eventType=3102 (face) sn=? fields=[f,pic_url]");
  assert.ok(!line.includes("Synthetic Person") && !line.includes("example.invalid"));
});

test("a push without a payload still gives a line", () => {
  assert.equal(pushFieldSummary({}), "push raw: eventType=? sn=? fields=[]");
});
