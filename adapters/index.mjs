// Registries for the adapter axes. Adding an engine or target is one line here plus its folder.
export const ENGINES = {
  fake: () => import('./engines/fake/adapter.mjs'),
  locust: () => import('./engines/locust/adapter.mjs'),
  k6: () => import('./engines/k6/adapter.mjs'),
  ws: () => import('./engines/ws/adapter.mjs'),
};

// Engines that can run an open model (profile.arrival_rps). Locust and the ws engine run closed
// loops of users; an arrival rate on them is refused rather than silently run as users.
export const OPEN_MODEL = new Set(['fake', 'k6']);

export const TARGETS = {
  local: () => import('./targets/local.mjs'),
  docker: () => import('./targets/docker.mjs'),
  ssh: () => import('./targets/ssh.mjs'),
  k8s: () => import('./targets/k8s.mjs'),
};
// Targets whose workers run on other machines: they talk to the controller over the network
// control channel (CONTRACTS §3b), not through shared files.
export const REMOTE = new Set(['ssh', 'k8s']);

export const METRICS = {
  none: () => import('./metrics/none.mjs'),
  'docker-stats': () => import('./metrics/docker-stats.mjs'),
  'host-process': () => import('./metrics/host-process.mjs'),
};
