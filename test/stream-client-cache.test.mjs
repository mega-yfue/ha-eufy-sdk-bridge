// One stream client per camera, also when two requests ask for it at once. The cache used to be filled
// only after login() had resolved, so two first calls for the same camera each built and logged in a
// client of their own; the one cached first was overwritten and never disconnected. A client dropped or
// shut down while its login was still in flight was never disconnected either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { streamClientFor, dropStreamClient, closeStreamClients } from "../streams.mjs";

const cfg = {};

/** A fake EufyMega whose login the test settles by hand. */
function factory() {
  const made = [];
  const create = () => {
    const c = new EventEmitter();
    c.disconnects = 0;
    c.login = () => new Promise((resolve, reject) => Object.assign(c, { resolve, reject }));
    c.disconnect = async () => void c.disconnects++;
    made.push(c);
    return c;
  };
  return { made, create };
}

const tick = () => new Promise((r) => setImmediate(r));

test("two concurrent first calls share one client and one login", async (t) => {
  t.after(closeStreamClients);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  assert.equal(made.length, 1, "the second call must join the login already in flight");
  made[0].resolve({ status: "ok" });
  assert.equal(await a, made[0]);
  assert.equal(await b, made[0]);
  assert.equal(await streamClientFor("CAM1", cfg, create), made[0], "cached afterwards");
  assert.equal(made.length, 1);
});

test("a failed login is not cached, and its client is let go", async (t) => {
  t.after(closeStreamClients);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  made[0].resolve({ status: "captcha" });
  await assert.rejects(a, /could not hydrate session \(captcha\)/);
  await assert.rejects(b, /could not hydrate session/);
  assert.equal(made[0].disconnects, 1);

  const c = streamClientFor("CAM1", cfg, create); // the next attempt starts fresh
  await tick();
  assert.equal(made.length, 2);
  made[1].resolve({ status: "ok" });
  assert.equal(await c, made[1]);
});

test("a login that throws is not cached either", async (t) => {
  t.after(closeStreamClients);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  await tick();
  made[0].reject(new Error("network down"));
  await assert.rejects(a, /network down/);
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  assert.equal(made.length, 2);
  made[1].resolve({ status: "ok" });
  await b;
});

test("dropping a client while its login is still in flight disconnects it once the login settles", async (t) => {
  t.after(closeStreamClients);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  await tick();
  assert.equal(dropStreamClient("CAM1"), true);
  const b = streamClientFor("CAM1", cfg, create); // must not reuse the dropped one
  await tick();
  assert.equal(made.length, 2);
  made[0].resolve({ status: "ok" });
  made[1].resolve({ status: "ok" });
  await a;
  await tick();
  assert.equal(made[0].disconnects, 1, "the dropped client is disconnected, not leaked");
  assert.equal(await b, made[1]);
  assert.equal(made[1].disconnects, 0);
});

test("a stale failure does not evict the client that replaced it", async (t) => {
  t.after(closeStreamClients);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  await tick();
  dropStreamClient("CAM1");
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  made[1].resolve({ status: "ok" });
  await b;
  made[0].reject(new Error("late failure of the dropped login"));
  await assert.rejects(a);
  assert.equal(await streamClientFor("CAM1", cfg, create), made[1], "the replacement stays cached");
  assert.equal(made.length, 2);
});

test("closeStreamClients disconnects every client, including one still logging in", async () => {
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  const b = streamClientFor("CAM2", cfg, create);
  await tick();
  made[0].resolve({ status: "ok" });
  await a;
  const closing = closeStreamClients();
  made[1].resolve({ status: "ok" });
  await closing;
  await b;
  assert.deepEqual(
    made.map((c) => c.disconnects),
    [1, 1],
  );
  assert.equal(dropStreamClient("CAM1"), false, "cache is empty after close");
});

test("closeStreamClients does not hang on a login that never settles", async () => {
  const { create } = factory();
  void streamClientFor("CAM1", cfg, create).catch(() => {});
  await tick();
  const started = Date.now();
  await closeStreamClients(50);
  assert.ok(Date.now() - started < 1000, "shutdown waited on a hanging login");
});
