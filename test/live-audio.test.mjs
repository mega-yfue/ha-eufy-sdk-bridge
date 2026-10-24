// openAdts() decides whether /audio has anything to serve BEFORE the response starts. go2rtc dials a
// stream's sources one after another and its ADTS reader blocks until it sees a header, so an /audio that
// stayed open without bytes would hold every viewer's DESCRIBE — video too — on a camera whose microphone
// is off or whose audio is not ADTS-framed aac-lc. A rejection becomes a fast 404 instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { openAdts, isNoLiveAudio } from "../src/live-audio.mjs";

/** A stand-in for a live() consumer: emits what the test tells it to, and counts stop() calls. */
function fakeHandle() {
  const h = new EventEmitter();
  h.stops = 0;
  h.stop = () => void h.stops++;
  return h;
}

const aac = (hex) => ({ codec: "aac-lc", data: Buffer.from(hex, "hex") });

/** Everything the Readable delivers until it ends. */
async function drain(readable) {
  const chunks = [];
  for await (const c of readable) chunks.push(c);
  return Buffer.concat(chunks).toString("hex");
}

test("resolves on the first aac-lc frame and serves every aac-lc frame in order, starting with it", async () => {
  const h = fakeHandle();
  const opening = openAdts(h);
  h.emit("audio", aac("fff1aa"));
  const out = await opening;
  h.emit("audio", { codec: "g711a", data: Buffer.from("00", "hex") }); // mid-stream: skipped, not fatal
  h.emit("audio", aac("fff1bb"));
  h.emit("stop");
  assert.equal(await drain(out), "fff1aafff1bb");
});

test("another codec is refused before the response starts", async () => {
  const h = fakeHandle();
  const opening = openAdts(h);
  h.emit("audio", { codec: "aac-eld", data: Buffer.from("01", "hex") });
  await assert.rejects(opening, (e) => isNoLiveAudio(e) && /aac-eld/.test(e.message));
  assert.equal(h.stops, 1, "the consumer is released");
});

test("video without audio is a camera with no microphone feed: refused after quietMs", async () => {
  const h = fakeHandle();
  const opening = openAdts(h, { quietMs: 20, timeoutMs: 5000 });
  h.emit("video", {});
  h.emit("video", {});
  await assert.rejects(opening, (e) => isNoLiveAudio(e) && /no audio within 20 ms/.test(e.message));
  assert.equal(h.stops, 1);
});

test("nothing at all within timeoutMs is refused too", async () => {
  const h = fakeHandle();
  await assert.rejects(openAdts(h, { quietMs: 5000, timeoutMs: 20 }), isNoLiveAudio);
  assert.equal(h.stops, 1);
});

test("a stream that stops before any audio is refused; one that stops later ends the Readable", async () => {
  const early = fakeHandle();
  const opening = openAdts(early);
  early.emit("stop");
  await assert.rejects(opening, isNoLiveAudio);

  const late = fakeHandle();
  const open = openAdts(late);
  late.emit("audio", aac("fff1"));
  const out = await open;
  late.emit("stop");
  assert.equal(await drain(out), "fff1");
});

test("an error before any audio is a real failure, not 'no audio'", async () => {
  const h = fakeHandle();
  const opening = openAdts(h);
  h.emit("error", new Error("P2P session lost"));
  await assert.rejects(opening, (e) => !isNoLiveAudio(e) && e.message === "P2P session lost");
  assert.equal(h.stops, 1);
});

test("destroying the Readable stops the consumer, which releases the shared pull", async () => {
  const h = fakeHandle();
  const opening = openAdts(h);
  h.emit("audio", aac("fff1"));
  const out = await opening;
  out.destroy();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.stops, 1);
});
