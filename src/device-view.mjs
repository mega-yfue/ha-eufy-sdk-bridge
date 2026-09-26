import { unobservableMembers } from "@mega-yfue/eufy-sdk";
// The host-facing view of a device: identity + capabilities + live property values + a stream path for
// cameras. This is the shape the WS `devices.list` / `device.state` / `device.properties` commands and
// the go2rtc camera registration both read, so a camera is "a device describeDevice gave a `stream`",
// not `deviceClass === "camera"` (the SDK downgrades a camera behind a HomeBase to "other").

export function createDeviceView(ctx) {
  const { eufy } = ctx;
  // Which members of a bound capability are settable but never reported; injectable so a test can state it.
  const unobservable = ctx.unobservableMembers ?? unobservableMembers;
  const { streaming } = ctx.state;

  /**
   * Build the host-facing summary of one device: identity + capabilities + a stream path for a camera.
   *
   * `name` is the owner's device name (falling back to the product name when unnamed), `model` is the
   * T-code, `modelName` is the product. A host shows `name` as the device name and `model`/`modelName`
   * as its model — no cross-referencing the device list.
   */
  async function describeDevice(sn) {
    const dev = await eufy.getDevice(sn);
    const m = dev.describe();
    const isCamera = m.capabilities.includes("camera") || m.capabilities.includes("video");
    return {
      sn: m.sn,
      name: m.name, // owner's device name (e.g. "Dining room"), from device_name
      model: m.model || m.modelName, // T-code (e.g. "T8410"); product name as fallback
      modelName: m.modelName, // product display name (e.g. "Indoor Cam Pan & Tilt")
      codec: m.codec,
      capabilities: m.capabilities,
      state: propertyState(dev), // live property values ({ battery: 74, motion: false, … })
      stream: isCamera ? `/stream/${m.sn}` : undefined,
      streaming: isCamera ? streaming.has(m.sn) : undefined, // live P2P feed active right now?
      canReboot: m.codec === "station", // HomeBase-only; drives a Reboot button in HA
    };
  }

  /** Live property values as a flat `{ name: value }` map (reading schedules a background refresh). */
  function propertyState(dev) {
    const out = {};
    for (const [name, pv] of Object.entries(dev.getProperties())) out[name] = pv.value;
    return out;
  }

  /**
   * The device's property manifest — the host-relevant half of each PropertySpec, so a frontend can
   * build the right entity (writable bool → switch, enum → select, number → number, else sensor)
   * without knowing eufy wire ids. Wire-only fields (paramType, decode, aliases) are omitted.
   */
  function propertySpecs(dev) {
    const reported = (dev.properties ?? []).map((p) => ({
      name: p.name,
      type: p.type, // "bool" | "number" | "string" | "enum"
      unit: p.unit, // "%", "°C", "dBm", …
      kind: p.kind, // percent | celsius | dbm | seconds | …
      writable: p.writable, // a setter exists (device.set accepts it)
      enumValues: p.enumValues, // { raw: label } for enums
      description: p.description,
    }));
    // Write-only settings a device ACCEPTS but never reports back (a HomeBase's alarm volume). They are
    // not in `dev.properties` — that manifest is what the device reports — so a host would otherwise never
    // learn the control exists. The SDK states them in two halves: `unobservableMembers(dev.<cap>())` names
    // the members that are settable but never reported, and `dev.describe()` carries each one's setter as
    // an action whose first argument gives the kind and bounds. Joined here into one spec, marked
    // `writeOnly` so a frontend shows an optimistic control (the device won't confirm the value) and drives
    // it through the same `device.set` path.
    // A device can declare a write-only setting whose name a reported property already carries (a
    // doorbell reports `ringtoneVolume` AND accepts a write-only one). The reported spec wins — it has a
    // live value — so a write-only is added only when the name is new, or a host builds two entities
    // with the same unique id.
    const reportedNames = new Set(reported.map((p) => p.name));
    const writeOnly = [];
    for (const cap of dev.describe?.().details ?? []) {
      const surface = typeof dev[cap.accessor] === "function" ? dev[cap.accessor]() : undefined;
      if (!surface) continue;
      for (const name of unobservable(surface)) {
        if (reportedNames.has(name) || writeOnly.some((w) => w.name === name)) continue;
        const setter = cap.actions.find((a) => a.name === `set${name[0].toUpperCase()}${name.slice(1)}`);
        const arg = setter?.args?.[0];
        if (!arg) continue; // settable in name only: no described argument, nothing a host can build
        writeOnly.push({
          name,
          type: arg.values ? "enum" : arg.kind === "bool" ? "bool" : arg.kind === "text" ? "string" : "number",
          unit: arg.kind === "percent" ? "%" : undefined,
          kind: arg.kind,
          writable: true,
          writeOnly: true,
          min: arg.min,
          max: arg.max,
          enumValues: arg.values
            ? Object.fromEntries(arg.values.map((v) => [v, arg.labels?.[v] ?? String(v)]))
            : undefined,
          description: setter.description,
        });
      }
    }
    return [...reported, ...writeOnly];
  }

  async function deviceList() {
    const devices = await eufy.getDevices();
    return Promise.all(
      devices.map((d) =>
        describeDevice(d.sn).catch((e) => ({
          sn: d.sn,
          error: String(e?.message ?? e),
        })),
      ),
    );
  }

  return { describeDevice, propertyState, propertySpecs, deviceList };
}
