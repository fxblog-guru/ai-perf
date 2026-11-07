// Example player script for the ws engine against mock/game.mjs: what /perf-script writes for a
// realtime game. One virtual user is one player (design §6.2). The engine opens the session,
// counts drops and reconnects, and measures each request by its reply; the script only plays.
// Request names are the game's operations (PS-D4); each player logs in with its own account
// (PS-B7); a refused move fails the request (PS-B8).
export default async function player(vu) {
  await vu.request('login', { user: vu.user }, 'login');
  await vu.request('matchmake', {}, 'matchmaking');
  while (vu.running) {
    await vu.request('move', { x: Math.round(Math.random() * 100), y: Math.round(Math.random() * 100) }, 'move');
    await vu.think(0.1, 0.3);
  }
}
