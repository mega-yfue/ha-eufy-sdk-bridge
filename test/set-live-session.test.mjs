// A write (device.set) to a camera that is streaming goes through the stream's own P2P session, as a PTZ
// command does. The control client's session to a battery camera has usually dropped or the camera slept,
// and a camera's spotlight lights for the client that streams: written through the control client while
// another session streamed, a SoloCam S340 (T8170) answered nothing and its spotlight stayed dark.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";

const sn = "CAM1";

/** A client whose setProperty records which session each write went through. */
function client(session, calls, { fails = false } = {}) {
  return {
    getDevice: async () => ({}),
    getDevices: async () => [{ sn }],
    setProperty: async (s, name, value) => {
      if (fails) throw new Error("session gone");
      calls.push(`${session}:${name}=${JSON.stringify(value)}`);
    },
  };
}

function setup({ streaming = false, liveFails = false } = {}) {
  const calls = [];
  const state = createState();
  state.flags.ready = true;
  if (streaming) {
    const lease = liveFails ? Promise.reject(new Error("login failed")) : Promise.resolve(client("live", calls));
    lease.catch(() => {}); // the bridge handles a failed lease; keep the test runner quiet about it
    state.activeStreams.set(sn, { lease });
  }
  const ctx = {
    cfg: {},
    eufy: client("control", calls),
    state,
    SCHEMA_VERSION: 1,
    DEBUG: false,
    dbg: () => {},
    authStatus: () => ({ state: "ok" }),
  };
  const server = http.createServer();
  Object.assign(ctx, createWsServer(ctx, server));
  const set = async (name, value) => {
    const sent = [];
    await ctx.handleMessage(
      { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) },
      Buffer.from(JSON.stringify({ id: 1, cmd: "device.set", sn, name, value })),
    );
    return sent[0];
  };
  return { calls, set, close: () => server.close() };
}

test("a write to a streaming camera goes through the live stream's session", async () => {
  const t = setup({ streaming: true });
  try {
    assert.equal((await t.set("light", true)).ok, true);
    assert.equal((await t.set("brightness", 60)).ok, true);
    assert.deepEqual(t.calls, ["live:light=true", "live:brightness=60"]);
  } finally {
    t.close();
  }
});

test("without a live stream the control client takes the write", async () => {
  const t = setup();
  try {
    assert.equal((await t.set("light", true)).ok, true);
    assert.deepEqual(t.calls, ["control:light=true"]);
  } finally {
    t.close();
  }
});

test("a live session whose login failed falls back to the control client", async () => {
  const t = setup({ streaming: true, liveFails: true });
  try {
    assert.equal((await t.set("light", false)).ok, true);
    assert.deepEqual(t.calls, ["control:light=false"]);
  } finally {
    t.close();
  }
});
