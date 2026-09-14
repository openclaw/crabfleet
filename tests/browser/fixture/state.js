export function deferred() {
  return Promise.withResolvers();
}

export const state = {
  media: false,
  clients: [],
  sockets: [],
  players: [],
  decoders: [],
  requests: [],
  intervals: new Set(),
  exportedFiles: 0,
  nextReady: null,
  nextBitmap: null,
  frames: new Map(),
};

export function request(kind, host, path = "") {
  const pending = deferred();
  state.requests.push({ kind, host, path, ...pending, settled: false });
  return pending.promise;
}
