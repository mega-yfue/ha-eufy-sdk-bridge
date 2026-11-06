// A PTZ command for a camera that is streaming goes through the stream's own P2P session. The control
// client's session to a battery camera on 4G has usually dropped (idle) or the camera slept, and
// reconnecting it takes ~30 s — past Home Assistant's 15 s reply timeout, so the camera seemed not to turn
// ("device.action: timed out") while the live view showed it awake.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createWsServer } from "../src/ws-server.mjs";
import { createState } from "../src/state.mjs";

const sn = "CAM1";

/** A device whose ptz() and camera() record which session each call went through. */
function device(session, calls) {
  const ptz = {
    left: async () => void calls.push(`${session}:left`),
    preset: () => ({ goto: async (i) => void calls.push(`${session}:preset.goto(${i})`) }),
  };
  return {
    ptz: () => ptz,
    camera: () => ({ snapshot: async () => void calls.push(`${session}:snapshot`) }),
  };
}

function setup({ streaming = false, liveFails = false } = {}) {
  const calls = [];
  const state = createState();
  state.flags.ready = true;
  if (streaming) {
    const client = { getDevice: async () => (liveFails ? Promise.reject(new Error("gone")) : device("live", calls)) };
    state.activeStreams.set(sn, { lease: Promise.resolve(client) });
  }
  const ctx = {
    cfg: {},
    eufy: { getDevice: async () => device("control", calls), getDevices: async () => [{ sn }] },
    state,
    SCHEMA_VERSION: 1,
    DEBUG: false,
    dbg: () => {},
    authStatus: () => ({ state: "ok" }),
  };
  const server = http.createServer();
  Object.assign(ctx, createWsServer(ctx, server));
  const call = async (action, args = []) => {
    const sent = [];
    await ctx.handleMessage(
      { readyState: 1, OPEN: 1, send: (s) => sent.push(JSON.parse(s)) },
      Buffer.from(JSON.stringify({ id: 1, cmd: "device.action", sn, action, args })),
    );
    return sent[0];
  };
  return { calls, call, close: () => server.close() };
}

test("a PTZ command for a streaming camera goes through the live stream's session", async () => {
  const t = setup({ streaming: true });
  try {
    assert.equal((await t.call("left")).ok, true);
    assert.equal((await t.call("preset.goto", [2])).ok, true);
    assert.deepEqual(t.calls, ["live:left", "live:preset.goto(2)"]);
  } finally {
    t.close();
  }
});

test("without a live stream the control client takes the PTZ command", async () => {
  const t = setup();
  try {
    assert.equal((await t.call("left")).ok, true);
    assert.deepEqual(t.calls, ["control:left"]);
  } finally {
    t.close();
  }
});

test("a live session that failed meanwhile falls back to the control client", async () => {
  const t = setup({ streaming: true, liveFails: true });
  try {
    assert.equal((await t.call("left")).ok, true);
    assert.deepEqual(t.calls, ["control:left"]);
  } finally {
    t.close();
  }
});

test("actions on other surfaces stay on the control client while streaming", async () => {
  const t = setup({ streaming: true });
  try {
    assert.equal((await t.call("snapshot")).ok, true);
    assert.deepEqual(t.calls, ["control:snapshot"]);
  } finally {
    t.close();
  }
});
