// /stream and the stream-client cache together. A request whose client was dropped while it still waited for
// the login must neither open media on that client nor arm the failure backoff — the camera never failed. And
// a request that fails on an older client must not evict the newer one another request is already using.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";
import { streamClientFor, dropStreamClient } from "../streams.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0"; // no real HTTP at :1984 from the consumer probe
const { createHttpHandler } = await import("../src/http-routes.mjs");

const tick = () => new Promise((r) => setImmediate(r));

/** Fake stream clients whose login and openReadable the test settles by hand. */
function factory() {
  const made = [];
  const create = () => {
    const c = new EventEmitter();
    c.opens = [];
    c.disconnects = 0;
    c.login = () => new Promise((resolve) => (c.loggedIn = resolve));
    c.disconnect = async () => void c.disconnects++;
    c.getDevice = async () => ({
      camera: () => ({
        openReadable: () => new Promise((resolve, reject) => c.opens.push({ resolve, reject })),
      }),
    });
    made.push(c);
    return c;
  };
  return { made, create };
}

function setup(create) {
  const config = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" });
  const state = createState();
  state.flags.ready = true;
  const failures = [];
  const ctx = {
    ...config,
    state,
    eventLog: () => {},
    broadcast: () => {},
    noteStreamOpened: () => {},
    noteStreamFailure: (sn) => void failures.push(sn),
    streamBackoffMs: () => 0,
    streamClientFor: (sn, cfg) => streamClientFor(sn, cfg, create),
    dropStreamClient,
  };
  return { handler: createHttpHandler(ctx), failures };
}

function pull(handler) {
  const out = {};
  const res = {
    writeHead(code) {
      out.code = code;
    },
    write: () => true,
    end() {},
    on() {},
    once() {},
    emit() {},
    removeListener() {},
    off() {},
    destroy() {},
  };
  out.done = handler({ url: "/stream/CAM1", headers: { host: "localhost" }, on() {} }, res);
  return out;
}

test("a request whose client is dropped during login answers 503 without opening media or backing off", async (t) => {
  t.after(() => dropStreamClient("CAM1"));
  const { made, create } = factory();
  const { handler, failures } = setup(create);
  const req = pull(handler);
  await tick();
  dropStreamClient("CAM1"); // e.g. another request on this camera just failed
  await req.done;
  assert.equal(req.code, 503);
  made[0].loggedIn({ status: "ok" }); // the old login still succeeds afterwards
  await tick();
  assert.equal(made[0].opens.length, 0, "no media was opened on the dropped client");
  assert.equal(made[0].disconnects, 1, "and it was let go");
  assert.deepEqual(failures, [], "the camera did not fail, so no backoff");
});

test("a failure on an older client does not evict the newer one", async (t) => {
  t.after(() => dropStreamClient("CAM1"));
  const { made, create } = factory();
  const { handler, failures } = setup(create);

  const first = pull(handler); // gets client 0 and starts opening
  await tick();
  made[0].loggedIn({ status: "ok" });
  await tick();
  assert.equal(made[0].opens.length, 1);

  dropStreamClient("CAM1"); // client 0 is retired while `first` is still opening on it
  const second = pull(handler); // builds client 1
  await tick();
  made[1].loggedIn({ status: "ok" });
  await tick();

  made[0].opens[0].reject(new Error("P2P connect timeout")); // the old open fails late
  await first.done;
  assert.equal(first.code, 502);
  assert.deepEqual(failures, ["CAM1"], "a real open failure still arms the backoff");
  assert.equal(made[1].disconnects, 0, "the newer client was not dropped");
  assert.equal(await streamClientFor("CAM1", {}, create), made[1], "and is still the cached one");

  made[1].opens[0].reject(new Error("done")); // let the second request finish
  await second.done;
});
