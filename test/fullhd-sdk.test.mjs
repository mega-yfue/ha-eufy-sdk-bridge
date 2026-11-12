// Published SDK contract through its public camera caller. Created with Codex.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { EufyMega } from "@mega-yfue/eufy-sdk";
import { cameraViewOutputs } from "../src/camera-views.mjs";

for (const [model, name, views, outputs] of [
  ["T8E00", "Synthetic PoE Bullet PTZ Cam S4", [0, 1], ["1080p"]],
  ["T8P00", "Synthetic PoE Cam E40", [0], ["1080p"]],
  ["T8P10", "Synthetic PoE Cam E41", [0], []],
]) {
  test(`published SDK advertises and routes the supported output for ${model}`, async (t) => {
    const stationSn = "T8000P0000000000";
    const sn = "T8000P0000000001";
    const client = new EufyMega({
      email: "synthetic@example.invalid",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
    });
    // Seed sanitized cloud inventory; keep the SDK's real classification and media provider.
    client.registry.devices = [
      {
        sn: stationSn,
        model: "T8N00",
        name: "Synthetic NVR S4",
        category: "eufy_security",
        deviceClass: "station",
        api: "mega",
        realtime: "p2p",
        raw: { member: { admin_user_id: "synthetic-admin" } },
      },
      {
        sn,
        model,
        name,
        category: "eufy_security",
        deviceClass: "camera",
        api: "mega",
        realtime: "p2p",
        stationSn,
        channel: 3,
        params: {},
        raw: { parent_sn: stationSn, device_channel: 3, device_model: model, device_name: name },
      },
    ];
    t.mock.method(client.mega, "getDeviceParamList", async () => ({ params: [] }));
    t.mock.method(client.mega, "rtcIdentity", () => ({
      authToken: "synthetic",
      userId: "synthetic",
      gtoken: "synthetic",
    }));
    t.mock.method(client.mega, "portalShard", async () => "eu-pr");
    const packets = [];
    client.rtc.deps.createSession = () => {
      const session = new EventEmitter();
      session.connect = async () => session.emit("connected");
      session.sendCommand = (packet) => {
        packets.push(JSON.parse(packet.subarray(16).toString()));
        return true;
      };
      session.sendRaw = () => true;
      session.close = () => {};
      return session;
    };
    t.after(() => client.rtc.close());
    const camera = (await client.getDevice(sn)).camera();
    assert.deepEqual(camera.views(), views);
    assert.deepEqual(camera.outputResolutions?.() ?? [], outputs);
    for (const view of views) {
      const descriptor = cameraViewOutputs(sn, view, camera);
      if (!outputs.length) {
        assert.equal(descriptor.outputs, undefined);
        await assert.rejects(camera.live({ view, outputResolution: "1080p" }), /unsupported output resolution/);
        continue;
      }
      const source = descriptor.outputs[0];
      const selection = Object.fromEntries(new URL("http://example.invalid" + source.stream).searchParams);
      const consumer = await camera.live({
        view: Number(selection.view ?? 0),
        outputResolution: selection.outputResolution,
      });
      const start = packets.findLast((packet) => packet.cmd === 1003);
      assert.deepEqual(start.payload.stitch_resolution, { width: 1920, height: 1080 });
      assert.equal(start.payload.chn_list[0].sensor, view);
      assert.equal(start.payload.chn_list[0].chn, 3);
      consumer.stop();
    }
  });
}
