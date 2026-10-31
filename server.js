'use strict';
/**
 * Rhythm Plus duel server (protocol reverse-engineered from the userscript v26.0).
 *
 * Client -> server: UPDATE_LOCATION, CREATE_ROOM, JOIN_ROOM, UPDATE_STATS
 * Server -> client: ROOM_CREATED, JOIN_SUCCESS, OPPONENT_JOINED, OPPONENT_LOCATION,
 *                   START_COUNTDOWN, OPPONENT_STATS, ERROR
 *
 * The userscript never asks for a duel to start, so the server decides: when both
 * players in a room are on the same in-game URL, it sends START_COUNTDOWN to both.
 */
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3742;
const MAX_ROOMS = 500;
const MAX_MSGS_PER_SEC = 40;
const HEARTBEAT_MS = 30000;
// Pages whose path matches this are treated as "in a song" (the userscript uses /play and /game too).
const GAME_PATH_RE = new RegExp(process.env.GAME_URL_REGEX || '/(game|play)', 'i');
const NON_GAME_PATH_RE = /result|select/i;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();
let playerCount = 0;

// ---------- helpers ----------
const clamp = (v, d, min, max) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
};
const cleanName = (v, fallback) => {
  const s = typeof v === 'string' ? v.trim().slice(0, 24) : '';
  return s || fallback;
};
const freshStats = () => ({ score: 0, combo: 0, accuracy: 100, finished: false, paused: false });

function send(p, obj) {
  if (p && p.ws.readyState === WebSocket.OPEN) {
    try { p.ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}
function parseUrl(u) {
  try { return new URL(u); } catch (e) { return null; }
}
/** Page identity without the #hash, so two players on the same song compare equal. */
function urlKey(u) {
  const p = parseUrl(u);
  return p ? p.origin + p.pathname + p.search : '';
}
function isGameUrl(u) {
  const p = parseUrl(u);
  return !!p && GAME_PATH_RE.test(p.pathname) && !NON_GAME_PATH_RE.test(p.pathname);
}
function makeCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
const opponentOf = (room, p) => (room.host === p ? room.guest : room.host);

// ---------- duel state machine ----------
function evaluate(room) {
  const { host, guest } = room;
  if (!host || !guest) return;
  const hk = urlKey(host.location);
  const gk = urlKey(guest.location);

  if (room.phase === 'duel') {
    const bothDone = host.stats.finished && guest.stats.finished;
    const bothAway = hk !== room.startUrl && gk !== room.startUrl;
    if (bothDone || bothAway) room.phase = 'idle';
    return;
  }

  // After a duel, wait until someone leaves the song page before allowing the next start.
  if (!room.armed && (hk !== room.startUrl || gk !== room.startUrl)) room.armed = true;

  if (room.armed && hk && hk === gk && isGameUrl(host.location)) {
    room.phase = 'duel';
    room.armed = false;
    room.startUrl = hk;
    host.stats = freshStats();
    guest.stats = freshStats();
    send(host, { type: 'START_COUNTDOWN' });
    send(guest, { type: 'START_COUNTDOWN' });
  }
}

function leaveRoom(p) {
  const room = rooms.get(p.roomId);
  p.roomId = null;
  p.stats = freshStats();
  if (!room) return;

  const remaining = opponentOf(room, p);
  if (!remaining) { rooms.delete(room.id); return; }

  room.host = remaining;     // the remaining player becomes host
  room.guest = null;
  room.phase = 'idle';
  room.armed = true;
  room.startUrl = '';
  // Unfreeze any pause sync the leaver was holding.
  send(remaining, {
    type: 'OPPONENT_STATS', name: p.name, score: p.stats.score, combo: 0,
    accuracy: 100, finished: false, paused: false
  });
  send(remaining, { type: 'ERROR', message: `${p.name} left the room.` });
}

// ---------- message handling ----------
function handle(p, raw) {
  let d;
  try { d = JSON.parse(raw.toString()); } catch (e) { return; }
  if (!d || typeof d.type !== 'string') return;

  switch (d.type) {
    case 'UPDATE_LOCATION': {
      p.location = typeof d.url === 'string' && /^https?:\/\//i.test(d.url) ? d.url.slice(0, 512) : '';
      const room = rooms.get(p.roomId);
      if (!room) return;
      send(opponentOf(room, p), { type: 'OPPONENT_LOCATION', url: p.location });
      evaluate(room);
      break;
    }

    case 'CREATE_ROOM': {
      if (rooms.size >= MAX_ROOMS) { send(p, { type: 'ERROR', message: 'Server is full, try again later.' }); return; }
      leaveRoom(p);
      p.name = cleanName(d.name, p.name);
      const id = makeCode();
      if (!id) { send(p, { type: 'ERROR', message: 'Could not create a room.' }); return; }
      rooms.set(id, { id, host: p, guest: null, phase: 'idle', armed: true, startUrl: '' });
      p.roomId = id;
      send(p, { type: 'ROOM_CREATED', roomId: id });
      break;
    }

    case 'JOIN_ROOM': {
      const id = String(d.roomId == null ? '' : d.roomId).trim().toUpperCase();
      const target = rooms.get(id);
      if (!target) { send(p, { type: 'ERROR', message: 'Room not found.' }); return; }
      if (target.host === p || target.guest === p) { send(p, { type: 'ERROR', message: 'You are already in that room.' }); return; }
      if (target.host && target.guest) { send(p, { type: 'ERROR', message: 'That room is full.' }); return; }

      leaveRoom(p);
      const room = rooms.get(id);       // still exists: p was never in it
      if (!room || !room.host) { send(p, { type: 'ERROR', message: 'Room not found.' }); return; }
      p.name = cleanName(d.name, p.name);
      room.guest = p;
      p.roomId = id;

      send(p, { type: 'JOIN_SUCCESS', roomId: id, opponent: room.host.name });
      send(room.host, { type: 'OPPONENT_JOINED', opponent: p.name });
      send(p, { type: 'OPPONENT_LOCATION', url: room.host.location });
      send(room.host, { type: 'OPPONENT_LOCATION', url: p.location });
      evaluate(room);
      break;
    }

    case 'UPDATE_STATS': {
      const room = rooms.get(p.roomId);
      if (!room) return;
      if (typeof d.name === 'string') p.name = cleanName(d.name, p.name);
      p.stats = {
        score: Math.round(clamp(d.score, 0, 0, 1e9)),
        combo: Math.round(clamp(d.combo, 0, 0, 1e6)),
        accuracy: clamp(d.accuracy, 100, 0, 100),
        finished: !!d.finished,
        paused: !!d.paused
      };
      const opp = opponentOf(room, p);
      if (opp) send(opp, Object.assign({ type: 'OPPONENT_STATS', name: p.name }, p.stats));
      evaluate(room);
      break;
    }

    default:
      break;
  }
}

// ---------- server ----------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ status: 'ok', players: playerCount, rooms: rooms.size }));
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  const p = {
    ws, name: 'Player', location: '', roomId: null, stats: freshStats(),
    windowStart: Date.now(), windowCount: 0
  };
  ws.isAlive = true;
  playerCount++;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - p.windowStart >= 1000) { p.windowStart = now; p.windowCount = 0; }
    if (++p.windowCount > MAX_MSGS_PER_SEC) return;
    try { handle(p, raw); } catch (err) { console.error('handler error:', err); }
  });
  ws.on('close', () => { playerCount--; leaveRoom(p); });
  ws.on('error', () => { /* 'close' follows */ });
});

// Drops dead connections and keeps idle proxies from closing healthy ones.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, HEARTBEAT_MS);

server.listen(PORT, () => console.log(`Rhythm Plus duel server listening on port ${PORT}`));
