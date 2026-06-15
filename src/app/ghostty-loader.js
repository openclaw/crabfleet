export async function loadGhosttyRuntime(module, wasmPath) {
  if (!module?.Ghostty) throw new Error("Ghostty module missing WASM loader");
  return { ...module, ghostty: await module.Ghostty.load(wasmPath) };
}
