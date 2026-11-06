// A stream client whose P2P session died must not be reused. streams.mjs caches one client per camera
// and never expires it, so a wedged session turns into a permanent "P2P unreachable" for that camera —
// observed for hours while the eufy app held a live view of the SAME camera, and cured only by a bridge
// restart (which empties the cache). The route must therefore drop the client whenever an open fails.
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { dropStreamClient } from "../streams.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

/** A handler whose stream client always fails to open, recording the drops the route asks for. */
function setup() {
  const config = loadConfig({
    EUFY_EMAIL: "x@y.z",
    EUFY_PASSWORD: "pw",
    STREAM_OPEN_ATTEMPTS: "1",
    STREAM_PLACEHOLDER: "0",
  });
  const state = createState();
  state.flags.ready = true;
  const dropped = [];
  const ctx = {
    ...config,
    state,
    eventLog: () => {},
    broadcast: () => {},
    noteStreamOpened: () => {},
    noteStreamFailure: () => {},
    streamBackoffMs: () => 0,
    dropStreamClient: (sn) => void dropped.push(sn),
    streamClientFor: async () => ({
      getDevice: async () => ({
        camera: () => ({
          openReadable: async () => {
            throw new Error("P2P connect timeout");
          },
        }),
      }),
    }),
  };
  return { handler: createHttpHandler(ctx), dropped };
}

async function pull(handler) {
  const out = { chunks: [] };
  const res = {
    writeHead(code) {
      out.code = code;
    },
    write(c) {
      out.chunks.push(Buffer.from(c));
      return true;
    },
    end(body) {
      if (body) out.chunks.push(Buffer.from(body));
    },
    on() {},
    once() {},
    emit() {},
    removeListener() {},
    off() {},
    destroy() {},
  };
  await handler({ url: "/stream/CAM1", headers: { host: "localhost" }, on() {} }, res);
  return out;
}

test("a failed open drops the cached client instead of keeping it", async () => {
  const { handler, dropped } = setup();
  const out = await pull(handler);
  assert.equal(out.code, 502);
  assert.deepEqual(dropped, ["CAM1"]); // the next attempt must start from a fresh session
});

test("dropStreamClient is harmless for a camera that has no client", () => {
  assert.equal(dropStreamClient("NEVER-OPENED"), false);
});
