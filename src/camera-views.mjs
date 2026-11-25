/** SDK-advertised optical views; SDKs without the inventory expose only the default view. */
export function cameraViews(camera) {
  return camera?.views?.() ?? [0];
}

/** The primary source retains its serial and paths; additional views have stable source identifiers. */
export function cameraView(sn, view = 0, outputResolution) {
  const params = new URLSearchParams();
  if (view !== 0) params.set("view", String(view));
  if (outputResolution) params.set("outputResolution", outputResolution);
  const query = params.size ? `?${params}` : "";
  const viewId = view === 0 ? sn : `${sn}_view_${view}`;
  return {
    view,
    ...(outputResolution ? { outputResolution } : {}),
    id: outputResolution ? `${viewId}_output_${outputResolution}` : viewId,
    stream: `/stream/${sn}${query}`,
    snapshot: `/snapshot/${sn}${query}`,
  };
}

/** Alternate output sizes come only from the bound SDK route, never a model-name heuristic. */
export function cameraViewOutputs(sn, view, camera) {
  const outputs = camera?.outputResolutions?.() ?? [];
  return {
    ...cameraView(sn, view),
    ...(outputs.length ? { outputs: outputs.map((resolution) => cameraView(sn, view, resolution)) } : {}),
  };
}

/** An omitted selector preserves native output; only the implemented Full-HD value is accepted. */
export function requestedOutputResolution(params) {
  const values = params.getAll("outputResolution");
  if (!values.length) return undefined;
  if (values.length !== 1 || values[0] !== "1080p")
    throw new RangeError("outputResolution must be specified once as 1080p");
  return values[0];
}

/** A non-negative safe-integer view selector, rejecting strings and other JSON values. */
export function validView(view) {
  return Number.isSafeInteger(view) && view >= 0;
}

/** One canonical integer query selector; omission preserves the SDK's default selection. */
export function requestedView(params) {
  const values = params.getAll("view");
  if (!values.length) return 0;
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0]) || !validView(Number(values[0]))) {
    throw new RangeError("view must be specified once as a non-negative safe integer");
  }
  return Number(values[0]);
}
