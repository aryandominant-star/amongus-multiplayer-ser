/* ============================================================================
   SPACE PARTY — server.js
   Authoritative Node.js + Socket.IO server.

   Added in this build:
   - public/private rooms + live room browser
   - active player / spectator / match counters
   - live spectator mode (spectators never receive hidden roles)
   - selectable maps
   - server-authoritative security gates
   - pulse blaster pickup + non-lethal stun system
   - Z.AI proxy endpoint for AI-assisted local bots (API key stays on Render)
   ============================================================================ */
'use strict';

const http = require('http');
const { Server } = require('socket.io');
const Maps = require('./maps');

const PORT = Number(process.env.PORT || 3000);
const TICK_HZ = Number(process.env.TICK_RATE || 30);
const SPEED = Number(process.env.PLAYER_SPEED || 230);
const KILL_RANGE = 90;
const KILL_COOLDOWN_MS = Number(process.env.KILL_COOLDOWN_MS || 24000);
const DISCUSSION_MS = Number(process.env.DISCUSSION_MS || 15000);
const VOTING_MS = Number(process.env.VOTING_MS || 30000);
const EJECT_MS = 5200;
const TASKS_PER_PLAYER = 6;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS_TO_START || 4);
const VIEW_RANGE = 700;

const GATE_RANGE = 125;
const GATE_CLOSE_MS = 8000;
const GATE_COOLDOWN_MS = 20000;
const WEAPON_RANGE = 430;
const WEAPON_STUN_MS = 3000;
const WEAPON_COOLDOWN_MS = 2500;
const WEAPON_AMMO = 3;
const WEAPON_RESPAWN_MS = 20000;

const ZAI_ENABLED = String(process.env.ZAI_ENABLED || 'false').toLowerCase() === 'true';
const ZAI_API_KEY = process.env.ZAI_API_KEY || '';
const ZAI_MODEL = process.env.ZAI_MODEL || 'glm-5.2';
const ZAI_BASE_URL = (process.env.ZAI_BASE_URL || 'https://api.z.ai/api/paas/v4').replace(/\/$/, '');

const COLORS = [
  { number: 1, color: 'red', hex: '#d93b3b' }, { number: 2, color: 'blue', hex: '#3b66d9' },
  { number: 3, color: 'green', hex: '#39a85a' }, { number: 4, color: 'pink', hex: '#ef72b7' },
  { number: 5, color: 'orange', hex: '#f59b42' }, { number: 6, color: 'yellow', hex: '#f3d84a' },
  { number: 7, color: 'black', hex: '#2c2c35' }, { number: 8, color: 'white', hex: '#e8edf2' },
  { number: 9, color: 'purple', hex: '#7952b3' }, { number: 10, color: 'cyan', hex: '#46c7c7' },
];

const rooms = new Map();           // roomCode -> room
const socketRoom = new Map();      // socket.id -> roomCode
const socketMode = new Map();      // socket.id -> player | spectator
const aiRate = new Map();          // ip -> {windowStart,count}
let aiGlobalWindow = { windowStart: Date.now(), count: 0 };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ok = (cb, extra = {}) => typeof cb === 'function' && cb({ ok: true, ...extra });
const fail = (cb, error, code) => typeof cb === 'function' && cb({ ok: false, error, ...(code ? { code } : {}) });

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function readJson(req, maxBytes = 30000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) reject(new Error('Request too large.'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function parseJsonObject(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { /* continue */ }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch (_) { /* ignore */ }
  }
  return null;
}

function allowAiRequest(req) {
  const now = Date.now();
  if (now - aiGlobalWindow.windowStart > 60000) aiGlobalWindow = { windowStart: now, count: 0 };
  if (aiGlobalWindow.count >= 120) return false;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const item = aiRate.get(ip) || { windowStart: now, count: 0 };
  if (now - item.windowStart > 60000) { item.windowStart = now; item.count = 0; }
  if (item.count >= 36) return false;
  item.count += 1; aiGlobalWindow.count += 1; aiRate.set(ip, item);
  return true;
}

async function handleAiDecision(req, res) {
  corsHeaders(res);
  res.setHeader('Content-Type', 'application/json');
  if (!ZAI_ENABLED || !ZAI_API_KEY) {
    res.statusCode = 503;
    res.end(JSON.stringify({ ok: false, error: 'AI assistance is not enabled on the server.' }));
    return;
  }
  if (!allowAiRequest(req)) {
    res.statusCode = 429;
    res.end(JSON.stringify({ ok: false, error: 'AI decision rate limit reached. Heuristic bot AI will continue.' }));
    return;
  }

  try {
    const body = await readJson(req);
    const mode = body.mode === 'meeting' ? 'meeting' : 'strategy';
    const context = body.context && typeof body.context === 'object' ? body.context : {};

    const system = mode === 'meeting'
      ? 'You are a bot player in a cartoon spaceship social-deduction game. Speak naturally and briefly in a meeting. Use only facts in the supplied context. Never claim knowledge you were not given. Return JSON only: {"message":"...","voteTarget":null|string,"confidence":0..1}.'
      : 'You are the high-level strategy brain for a bot in a cartoon spaceship social-deduction game. Low-level movement and rules are handled by deterministic code. Choose one useful high-level intent. Return JSON only: {"action":"task|investigate|follow|patrol|hunt|fake_task|vent|gate|weapon","targetPlayer":null|string,"targetRoom":null|string,"reason":"short reason"}. Never invent a room or player not in context.';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let apiRes;
    try {
      apiRes = await fetch(`${ZAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ZAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: ZAI_MODEL,
          temperature: mode === 'meeting' ? 0.75 : 0.35,
          max_tokens: mode === 'meeting' ? 120 : 160,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(context) },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!apiRes.ok) {
      const text = await apiRes.text().catch(() => '');
      throw new Error(`Z.AI returned HTTP ${apiRes.status}${text ? `: ${text.slice(0, 180)}` : ''}`);
    }
    const data = await apiRes.json();
    const text = data?.choices?.[0]?.message?.content || '';
    const parsed = parseJsonObject(text);
    if (!parsed) throw new Error('Z.AI did not return valid JSON.');
    res.end(JSON.stringify({ ok: true, decision: parsed }));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ ok: false, error: err.name === 'AbortError' ? 'AI request timed out.' : (err.message || 'AI request failed.') }));
  }
}

function serverStats() {
  let players = 0, spectators = 0, waiting = 0, playing = 0;
  for (const r of rooms.values()) {
    players += r.players.size;
    spectators += r.spectators.size;
    if (r.state === 'Lobby') waiting++;
    else if (r.state === 'Playing' || r.state === 'Meeting') playing++;
  }
  return {
    connected: io?.engine?.clientsCount || 0,
    players,
    spectators,
    rooms: rooms.size,
    waiting,
    playing,
    aiEnabled: Boolean(ZAI_ENABLED && ZAI_API_KEY),
  };
}

function publicRooms() {
  return [...rooms.values()]
    .filter(r => r.isPublic)
    .map(r => ({
      roomCode: r.code,
      gameState: r.state,
      mapId: r.mapId,
      mapName: (Maps.MAPS[r.mapId] || Maps.MAPS.skeld).name,
      players: r.players.size,
      maxPlayers: MAX_PLAYERS,
      spectators: r.spectators.size,
      impostorCount: r.impostorCount,
      allowSpectators: r.allowSpectators,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => (a.gameState === 'Lobby' ? -1 : 1) - (b.gameState === 'Lobby' ? -1 : 1) || b.players - a.players);
}

const httpServer = http.createServer(async (req, res) => {
  corsHeaders(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/api/ai/bot-decision') {
    await handleAiDecision(req, res);
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/health') {
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptimeSeconds: Math.floor(process.uptime()), aiEnabled: Boolean(ZAI_ENABLED && ZAI_API_KEY) }));
    return;
  }
  if (url.pathname === '/stats') {
    res.end(JSON.stringify({ ok: true, ...serverStats(), publicRooms: publicRooms().length }));
    return;
  }
  res.end(JSON.stringify({ ok: true, name: 'space-party-server', ...serverStats(), maps: Maps.MAP_LIST, time: Date.now() }));
});

const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] }, pingInterval: 10000, pingTimeout: 20000 });

function emitStats() {
  io.emit('serverStats', serverStats());
  io.emit('roomListUpdated', publicRooms());
}

/* ---------------------------------------------------------------------------
   Room helpers
   --------------------------------------------------------------------------- */
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do { code = ''; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; } while (rooms.has(code));
  return code;
}

function publicWeapon(weapon) {
  return weapon ? { type: weapon.type, ammo: weapon.ammo, cooldownUntil: weapon.cooldownUntil || 0 } : null;
}

function publicPlayer(p) {
  return {
    socketId: p.socketId, name: p.name, number: p.number, color: p.color, colorHex: p.colorHex,
    isAlive: p.isAlive, weapon: publicWeapon(p.weapon), stunnedUntil: p.stunnedUntil || 0,
  };
}

function roomPayload(room) {
  return {
    gameState: room.state,
    roomCode: room.code,
    hostSocketId: room.hostId,
    impostorCount: room.impostorCount,
    maxPlayers: MAX_PLAYERS,
    mapId: room.mapId,
    mapName: (Maps.MAPS[room.mapId] || Maps.MAPS.skeld).name,
    isPublic: room.isPublic,
    allowSpectators: room.allowSpectators,
    spectatorCount: room.spectators.size,
    playerList: [...room.players.values()].map(publicPlayer),
  };
}

function mapPayload(room) {
  return {
    id: room.map.id, width: room.map.width, height: room.map.height, name: room.map.name, theme: room.map.theme,
    spawn: room.map.spawn, rooms: room.map.rooms, collisionRects: room.map.collisionRects || [],
    taskLocations: room.map.taskLocations, vents: room.map.vents, gates: room.map.gates || [],
    weaponStations: room.map.weaponStations || [], emergencyButton: room.map.emergencyButton,
  };
}

function gatePayload(room) {
  return (room.gates || []).map(g => ({ id: g.id, room: g.room, x: g.x, y: g.y, w: g.w, h: g.h, orientation: g.orientation, label: g.label, isClosed: g.isClosed, closedUntil: g.closedUntil || 0, cooldownUntil: g.cooldownUntil || 0 }));
}

function weaponPickupPayload(room) {
  return (room.weaponPickups || []).map(w => ({ id: w.id, room: w.room, x: w.x, y: w.y, type: w.type, label: w.label || 'Pulse Blaster', available: w.available !== false, respawnAt: w.respawnAt || 0, isDrop: Boolean(w.isDrop) }));
}

function broadcastRoom(room) { io.to(room.code).emit('roomUpdated', roomPayload(room)); emitStats(); }
function alive(room) { return [...room.players.values()].filter(p => p.isAlive); }
function roomOf(room, p) { return (room.map._namedRooms.find(r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) || {}).name || 'the hallway'; }
const publicBody = b => ({ id: b.id, x: b.x, y: b.y, victimSocketId: b.victimSocketId, victimName: b.victimName, victimColorHex: b.victimColorHex });

function publicMeeting(room) {
  if (!room.meeting) return null;
  const t = room.meeting.trigger;
  return {
    trigger: { type: t.type, reporter: { socketId: t.reporter.socketId, name: t.reporter.name, colorHex: t.reporter.colorHex }, body: t.body ? publicBody(t.body) : null },
    players: [...room.players.values()].map(publicPlayer),
    votingStartsAt: room.meeting.votingStartsAt,
    votingEndsAt: room.meeting.votingEndsAt,
  };
}

function makePlayer(socket, name, number) {
  const c = COLORS.find(x => x.number === number);
  return {
    socketId: socket.id, name, number, color: c.color, colorHex: c.hex,
    isAlive: true, isImpostor: false, x: 0, y: 0, inVent: null, killCooldownUntil: 0,
    stunnedUntil: 0, weapon: null,
    input: { up: false, down: false, left: false, right: false },
  };
}

function initializeWorldSystems(room) {
  room.gates = (room.map.gates || []).map(g => ({ ...g, isClosed: false, closedUntil: 0, cooldownUntil: 0 }));
  room.weaponPickups = (room.map.weaponStations || []).map(w => ({ ...w, available: true, respawnAt: 0, isDrop: false }));
}

function createRoom(socket, payload, cb) {
  const name = String(payload?.name || '').trim().slice(0, 16);
  const number = Number(payload?.playerNumber);
  if (!name) return fail(cb, 'Enter a display name.');
  if (!COLORS.some(c => c.number === number)) return fail(cb, 'Choose a suit color.');
  if (socketRoom.has(socket.id)) leaveRoom(socket);
  const mapId = Maps.MAPS[payload?.mapId] ? payload.mapId : 'skeld';
  const room = {
    code: makeCode(), hostId: socket.id, impostorCount: Math.max(1, Math.min(3, Number(payload?.impostorCount) || 1)),
    mapId, map: Maps.buildMap(mapId), nav: null, state: 'Lobby', players: new Map(), spectators: new Map(),
    isPublic: payload?.publicRoom !== false, allowSpectators: payload?.allowSpectators !== false,
    bodies: [], tasks: new Map(), taskDone: 0, taskTotal: 0, meeting: null, tick: null, lastTick: 0, timers: new Set(),
    gates: [], weaponPickups: [], createdAt: Date.now(),
  };
  initializeWorldSystems(room);
  room.players.set(socket.id, makePlayer(socket, name, number));
  rooms.set(room.code, room);
  socketRoom.set(socket.id, room.code);
  socketMode.set(socket.id, 'player');
  socket.join(room.code);
  ok(cb, { room: roomPayload(room) });
  broadcastRoom(room);
}

function joinRoom(socket, payload, cb) {
  const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
  const name = String(payload?.name || '').trim().slice(0, 16);
  const number = Number(payload?.playerNumber);
  if (!room) return fail(cb, 'Room not found.');
  if (room.state !== 'Lobby') return fail(cb, 'That game is already in progress. Spectate it instead.');
  if (room.players.size >= MAX_PLAYERS) return fail(cb, 'Room is full.');
  if (!name) return fail(cb, 'Enter a display name.');
  if (!COLORS.some(c => c.number === number)) return fail(cb, 'Choose a suit color.');
  if ([...room.players.values()].some(p => p.number === number)) return fail(cb, 'That color is taken.', 'PLAYER_NUMBER_TAKEN');
  if (socketRoom.has(socket.id)) leaveRoom(socket);
  room.players.set(socket.id, makePlayer(socket, name, number));
  socketRoom.set(socket.id, room.code);
  socketMode.set(socket.id, 'player');
  socket.join(room.code);
  ok(cb, { room: roomPayload(room) });
  broadcastRoom(room);
}

function spectateRoom(socket, payload, cb) {
  const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
  if (!room) return fail(cb, 'Room not found.');
  if (!room.isPublic || !room.allowSpectators) return fail(cb, 'Spectating is disabled for this room.');
  if (socketRoom.has(socket.id)) leaveRoom(socket);

  const spectator = { socketId: socket.id, name: String(payload?.name || 'Spectator').trim().slice(0, 16) || 'Spectator', joinedAt: Date.now() };
  room.spectators.set(socket.id, spectator);
  socketRoom.set(socket.id, room.code);
  socketMode.set(socket.id, 'spectator');
  socket.join(room.code);

  const payloadOut = {
    room: roomPayload(room),
    roomCode: room.code,
    gameState: room.state,
    map: mapPayload(room),
    players: [...room.players.values()].filter(p => !p.inVent).map(p => ({ ...publicPlayer(p), x: p.x, y: p.y })),
    bodies: room.bodies.map(publicBody),
    taskProgress: room.taskTotal ? room.taskDone / room.taskTotal : 0,
    gates: gatePayload(room),
    weaponPickups: weaponPickupPayload(room),
    meeting: publicMeeting(room),
  };
  ok(cb, payloadOut);
  broadcastRoom(room);
}

function leaveRoom(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  const mode = socketMode.get(socket.id);
  socketRoom.delete(socket.id);
  socketMode.delete(socket.id);
  socket.leave(code);
  if (!room) { emitStats(); return; }

  if (mode === 'spectator') {
    room.spectators.delete(socket.id);
    broadcastRoom(room);
    if (room.players.size === 0 && room.spectators.size === 0) destroyRoom(room);
    return;
  }

  const p = room.players.get(socket.id);
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    if (room.spectators.size === 0) destroyRoom(room);
    else {
      for (const sid of room.spectators.keys()) io.to(sid).emit('roomClosed', { reason: 'All players left the room.' });
      destroyRoom(room);
    }
    emitStats();
    return;
  }
  io.to(code).emit('playerLeft', { socketId: socket.id, name: p?.name || 'Player' });
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
    io.to(code).emit('hostChanged', { hostSocketId: room.hostId });
  }
  if (room.state === 'Lobby') broadcastRoom(room);
  else if (room.state === 'Meeting') { if (room.meeting?.votes) room.meeting.votes.delete(socket.id); sendVoteStatus(room); maybeEndEarly(room); checkWin(room); }
  else checkWin(room);
  emitStats();
}

function destroyRoom(room) {
  clearInterval(room.tick);
  for (const t of room.timers) clearTimeout(t);
  rooms.delete(room.code);
  emitStats();
}

const later = (room, fn, ms) => { const t = setTimeout(() => { room.timers.delete(t); fn(); }, ms); room.timers.add(t); return t; };

/* ---------------------------------------------------------------------------
   Game start
   --------------------------------------------------------------------------- */
function startGame(socket, cb) {
  const room = rooms.get(socketRoom.get(socket.id));
  if (!room || socketMode.get(socket.id) !== 'player') return fail(cb, 'You are not a player in this room.');
  if (room.hostId !== socket.id) return fail(cb, 'Only the host can start.');
  if (room.state !== 'Lobby') return fail(cb, 'Game already running.');
  if (room.players.size < MIN_PLAYERS) return fail(cb, `Need at least ${MIN_PLAYERS} players.`);
  if (room.impostorCount >= Math.floor(room.players.size / 2)) return fail(cb, 'Too many impostors for this many players.');
  ok(cb);

  room.map = Maps.buildMap(room.mapId);
  room.nav = Maps.buildNav(room.map._walkable);
  initializeWorldSystems(room);
  room.state = 'Playing';
  room.bodies = [];
  room.taskDone = 0;
  room.tasks = new Map();
  const players = [...room.players.values()];
  players.forEach(p => {
    p.isAlive = true; p.isImpostor = false; p.inVent = null; p.stunnedUntil = 0; p.weapon = null;
    p.input = { up: false, down: false, left: false, right: false };
  });
  shuffle(players).slice(0, room.impostorCount).forEach(p => { p.isImpostor = true; });
  players.forEach((p, i) => {
    const a = (i / players.length) * Math.PI * 2;
    p.x = room.map.spawn.x + Math.cos(a) * 150;
    p.y = room.map.spawn.y + Math.sin(a) * 100;
  });
  room.taskTotal = 0;
  for (const p of players) {
    if (p.isImpostor) continue;
    const spots = shuffle(room.map._taskSpots).slice(0, TASKS_PER_PLAYER).map(t => ({ ...t, completed: false }));
    room.tasks.set(p.socketId, spots);
    room.taskTotal += spots.length;
  }
  const now = Date.now();
  const firstCooldown = KILL_COOLDOWN_MS * 0.6;
  players.forEach(p => { p.killCooldownUntil = now + firstCooldown; });

  const teammates = players.filter(p => p.isImpostor).map(p => ({ socketId: p.socketId, name: p.name }));
  const mp = mapPayload(room);
  for (const p of players) {
    io.to(p.socketId).emit('gameStarted', {
      roomCode: room.code,
      role: p.isImpostor ? 'Impostor' : 'Crewmate',
      teammates: p.isImpostor ? teammates : [],
      tasks: (room.tasks.get(p.socketId) || []).map(t => ({ id: t.id, name: t.name, room: t.room, type: t.type, x: t.x, y: t.y, completed: false })),
      players: players.map(q => ({ ...publicPlayer(q), x: q.x, y: q.y })),
      map: mp,
      gates: gatePayload(room),
      weaponPickups: weaponPickupPayload(room),
      killCooldownMs: firstCooldown,
      taskProgress: 0,
    });
  }

  for (const sid of room.spectators.keys()) {
    io.to(sid).emit('spectateStarted', {
      room: roomPayload(room), roomCode: room.code, gameState: room.state, map: mp,
      players: players.map(q => ({ ...publicPlayer(q), x: q.x, y: q.y })), bodies: [], taskProgress: 0,
      gates: gatePayload(room), weaponPickups: weaponPickupPayload(room),
    });
  }

  room.lastTick = Date.now();
  clearInterval(room.tick);
  room.tick = setInterval(() => tick(room), 1000 / TICK_HZ);
  emitStats();
}

/* ---------------------------------------------------------------------------
   Movement + snapshots
   --------------------------------------------------------------------------- */
function pointInsideRect(p, r, pad = 0) {
  return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
}

function blockedByGate(room, from, to) {
  for (const gate of room.gates || []) {
    if (!gate.isClosed) continue;
    const wasInside = pointInsideRect(from, gate, 8);
    const willInside = pointInsideRect(to, gate, 8);
    if (!wasInside && willInside) return true;
  }
  return false;
}

function tryMove(room, p, dx, dy) {
  if (!p.isAlive) { p.x = Math.max(0, Math.min(room.map.width, p.x + dx)); p.y = Math.max(0, Math.min(room.map.height, p.y + dy)); return; }
  if (Date.now() < (p.stunnedUntil || 0)) return;

  const from = { x: p.x, y: p.y };
  const candidate = { x: p.x + dx, y: p.y + dy };
  if (!blockedByGate(room, from, candidate) && room.nav.walkableAt(candidate)) { p.x = candidate.x; p.y = candidate.y; return; }
  const cx = { x: p.x + dx, y: p.y };
  if (!blockedByGate(room, from, cx) && room.nav.walkableAt(cx)) { p.x = cx.x; return; }
  const cy = { x: p.x, y: p.y + dy };
  if (!blockedByGate(room, from, cy) && room.nav.walkableAt(cy)) p.y = cy.y;
}

function updateTimedWorld(room, now) {
  let gateChanged = false;
  for (const g of room.gates || []) {
    if (g.isClosed && g.closedUntil && now >= g.closedUntil) {
      g.isClosed = false; g.closedUntil = 0; gateChanged = true;
    }
  }
  if (gateChanged) io.to(room.code).emit('gateState', gatePayload(room));

  let pickupChanged = false;
  for (const w of room.weaponPickups || []) {
    if (!w.available && !w.isDrop && w.respawnAt && now >= w.respawnAt) {
      w.available = true; w.respawnAt = 0; pickupChanged = true;
    }
  }
  if (pickupChanged) io.to(room.code).emit('weaponPickups', weaponPickupPayload(room));
}

function tick(room) {
  const now = Date.now();
  const dt = Math.min(.1, (now - room.lastTick) / 1000);
  room.lastTick = now;
  if (room.state !== 'Playing') return;
  updateTimedWorld(room, now);

  for (const p of room.players.values()) {
    if (p.inVent || now < (p.stunnedUntil || 0)) continue;
    const dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    const dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    if (dx || dy) { const l = Math.hypot(dx, dy); tryMove(room, p, dx / l * SPEED * dt, dy / l * SPEED * dt); }
  }

  const all = [...room.players.values()];
  const bodies = room.bodies.map(publicBody);
  const progress = room.taskTotal ? room.taskDone / room.taskTotal : 0;
  const gates = gatePayload(room);
  const weaponPickups = weaponPickupPayload(room);
  for (const me of all) {
    const meDead = !me.isAlive;
    const players = all
      .filter(p => p === me || (!p.inVent && (meDead || p.isAlive)))
      .map(p => ({ ...publicPlayer(p), x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
    io.to(me.socketId).emit('worldSnapshot', { gameState: room.state, taskProgress: progress, bodies, players, gates, weaponPickups });
  }

  if (room.spectators.size) {
    const visible = all.filter(p => !p.inVent && p.isAlive).map(p => ({ ...publicPlayer(p), x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
    for (const sid of room.spectators.keys()) {
      io.to(sid).emit('worldSnapshot', { gameState: room.state, taskProgress: progress, bodies, players: visible, gates, weaponPickups, spectator: true });
    }
  }
}

/* ---------------------------------------------------------------------------
   Actions
   --------------------------------------------------------------------------- */
function withGame(socket, cb, fn) {
  const room = rooms.get(socketRoom.get(socket.id));
  if (!room) return fail(cb, 'You are not in a room.');
  if (socketMode.get(socket.id) !== 'player') return fail(cb, 'Spectators cannot perform game actions.');
  const me = room.players.get(socket.id);
  if (!me) return fail(cb, 'Player not found.');
  return fn(room, me);
}

function killPlayer(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (room.state !== 'Playing') return fail(cb, 'Not in play.');
    const target = room.players.get(payload?.targetSocketId);
    if (!me.isImpostor || !me.isAlive) return fail(cb, 'Only impostors can kill.');
    if (!target || !target.isAlive || target.isImpostor) return fail(cb, 'Invalid target.');
    if (Date.now() < me.killCooldownUntil) return fail(cb, 'Kill is on cooldown.');
    if (Date.now() < (me.stunnedUntil || 0)) return fail(cb, 'You are stunned.');
    if (dist(me, target) > KILL_RANGE + 10) return fail(cb, 'Too far away.');
    if (me.inVent) return fail(cb, 'Leave the vent first.');
    doKill(room, me, target);
    ok(cb, { cooldownUntil: me.killCooldownUntil });
  });
}

function dropWeapon(room, p) {
  if (!p.weapon) return;
  room.weaponPickups.push({
    id: `drop_${p.socketId}_${Date.now()}`, room: roomOf(room, p), x: p.x, y: p.y,
    type: p.weapon.type || 'pulse', label: 'Dropped Pulse Blaster', available: true, respawnAt: 0, isDrop: true,
  });
  p.weapon = null;
  io.to(room.code).emit('weaponPickups', weaponPickupPayload(room));
}

function doKill(room, killer, victim) {
  const now = Date.now();
  victim.isAlive = false;
  dropWeapon(room, victim);
  killer.killCooldownUntil = now + KILL_COOLDOWN_MS;
  const body = { id: `body-${victim.socketId}-${now}`, x: victim.x, y: victim.y, victimSocketId: victim.socketId, victimName: victim.name, victimColorHex: victim.colorHex, room: roomOf(room, victim), at: now };
  room.bodies.push(body);
  io.to(victim.socketId).emit('playerKilled', { body: publicBody(body) });
  io.to(victim.socketId).emit('youWereKilled', { killer: { socketId: killer.socketId, name: killer.name } });
  for (const p of room.players.values()) {
    if (p === victim) continue;
    if (dist(p, body) <= VIEW_RANGE || roomOf(room, p) === body.room) io.to(p.socketId).emit('playerKilled', { body: publicBody(body) });
  }
  checkWin(room);
}

function taskComplete(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (room.state !== 'Playing') return fail(cb, 'Not in play.');
    const t = (room.tasks.get(me.socketId) || []).find(x => x.id === payload?.taskId);
    if (!t) return fail(cb, 'Unknown task.');
    if (me.isAlive && dist(me, t) > 130) return fail(cb, 'Move closer to the task.');
    if (!t.completed) {
      t.completed = true;
      room.taskDone += 1;
      io.to(me.socketId).emit('yourTaskCompleted', { taskId: t.id });
      io.to(room.code).emit('taskProgress', { progress: room.taskDone / room.taskTotal, completed: room.taskDone, total: room.taskTotal });
    }
    ok(cb);
    checkWin(room);
  });
}

function ventAction(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (room.state !== 'Playing') return fail(cb, 'Not in play.');
    if (!me.isImpostor || !me.isAlive) return fail(cb, 'Only impostors can vent.');
    if (Date.now() < (me.stunnedUntil || 0)) return fail(cb, 'You are stunned.');
    const vents = room.map.vents;
    if (payload?.action === 'enter') {
      const v = vents.find(x => x.id === payload.ventId);
      if (!v || dist(me, v) > 100) return fail(cb, 'No vent here.');
      me.inVent = v.id; me.x = v.x; me.y = v.y;
      return ok(cb, { inVent: true, currentVentId: v.id });
    }
    if (payload?.action === 'travel') {
      const from = vents.find(x => x.id === me.inVent);
      const to = vents.find(x => x.id === payload.ventId);
      if (!from || !to || !from.connections.includes(to.id)) return fail(cb, 'Not connected.');
      me.inVent = to.id; me.x = to.x; me.y = to.y;
      return ok(cb, { inVent: true, currentVentId: to.id });
    }
    const v = vents.find(x => x.id === me.inVent);
    me.inVent = null;
    if (v) { me.x = v.x; me.y = v.y + 30; }
    ok(cb, { inVent: false, currentVentId: null });
  });
}

function gateAction(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (room.state !== 'Playing' || !me.isAlive) return fail(cb, 'You cannot use a gate now.');
    if (Date.now() < (me.stunnedUntil || 0)) return fail(cb, 'You are stunned.');
    const gate = (room.gates || []).find(g => g.id === payload?.gateId);
    if (!gate) return fail(cb, 'Unknown gate.');
    const center = { x: gate.x + gate.w / 2, y: gate.y + gate.h / 2 };
    if (dist(me, center) > GATE_RANGE) return fail(cb, 'Move closer to the gate control.');
    const now = Date.now();
    if (!gate.isClosed && now < (gate.cooldownUntil || 0)) return fail(cb, 'Gate controls are recharging.');

    if (gate.isClosed) {
      gate.isClosed = false; gate.closedUntil = 0;
    } else {
      gate.isClosed = true; gate.closedUntil = now + GATE_CLOSE_MS; gate.cooldownUntil = now + GATE_COOLDOWN_MS;
    }
    io.to(room.code).emit('gateState', gatePayload(room));
    ok(cb, { gate: gatePayload(room).find(g => g.id === gate.id) });
  });
}

function pickupWeapon(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (room.state !== 'Playing' || !me.isAlive) return fail(cb, 'You cannot pick that up now.');
    if (me.weapon) return fail(cb, 'You already have a pulse blaster.');
    const pickup = (room.weaponPickups || []).find(w => w.id === payload?.pickupId && w.available !== false);
    if (!pickup) return fail(cb, 'That weapon is not available.');
    if (dist(me, pickup) > 115) return fail(cb, 'Move closer to the weapon rack.');

    me.weapon = { type: 'pulse', ammo: WEAPON_AMMO, cooldownUntil: 0 };
    if (pickup.isDrop) room.weaponPickups = room.weaponPickups.filter(w => w.id !== pickup.id);
    else { pickup.available = false; pickup.respawnAt = Date.now() + WEAPON_RESPAWN_MS; }
    io.to(room.code).emit('weaponPickups', weaponPickupPayload(room));
    io.to(room.code).emit('weaponPickedUp', { socketId: me.socketId, pickupId: pickup.id });
    ok(cb, { weapon: publicWeapon(me.weapon) });
  });
}

function fireWeapon(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (room.state !== 'Playing' || !me.isAlive) return fail(cb, 'You cannot fire now.');
    if (Date.now() < (me.stunnedUntil || 0)) return fail(cb, 'You are stunned.');
    if (!me.weapon || me.weapon.ammo <= 0) return fail(cb, 'You do not have a charged pulse blaster.');
    if (Date.now() < (me.weapon.cooldownUntil || 0)) return fail(cb, 'Pulse blaster is recharging.');
    const target = room.players.get(payload?.targetSocketId);
    if (!target || target === me || !target.isAlive || target.inVent) return fail(cb, 'Invalid target.');
    if (dist(me, target) > WEAPON_RANGE) return fail(cb, 'Target is out of range.');

    const now = Date.now();
    me.weapon.ammo -= 1;
    me.weapon.cooldownUntil = now + WEAPON_COOLDOWN_MS;
    target.stunnedUntil = Math.max(target.stunnedUntil || 0, now + WEAPON_STUN_MS);
    const fired = {
      shooterSocketId: me.socketId, targetSocketId: target.socketId,
      from: { x: me.x, y: me.y - 24 }, to: { x: target.x, y: target.y - 24 },
      targetStunnedUntil: target.stunnedUntil,
    };
    io.to(room.code).emit('pulseFired', fired);
    io.to(target.socketId).emit('youWereStunned', { by: { socketId: me.socketId, name: me.name }, until: target.stunnedUntil });
    if (me.weapon.ammo <= 0) me.weapon = null;
    ok(cb, { weapon: publicWeapon(me.weapon), targetStunnedUntil: target.stunnedUntil });
  });
}

function reportBody(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (room.state !== 'Playing') return fail(cb, 'Not in play.');
    const body = room.bodies.find(b => b.id === payload?.bodyId);
    if (!me.isAlive) return fail(cb, 'Ghosts cannot report.');
    if (!body || dist(me, body) > 150) return fail(cb, 'No body nearby.');
    ok(cb);
    startMeeting(room, { type: 'body', reporter: me, body });
  });
}

function emergencyMeeting(socket, cb) {
  withGame(socket, cb, (room, me) => {
    if (room.state !== 'Playing') return fail(cb, 'Not in play.');
    if (!me.isAlive) return fail(cb, 'Ghosts cannot call meetings.');
    if (dist(me, room.map.emergencyButton) > 110) return fail(cb, 'Go to the emergency button.');
    ok(cb);
    startMeeting(room, { type: 'emergency', reporter: me });
  });
}

/* ---------------------------------------------------------------------------
   Meetings
   --------------------------------------------------------------------------- */
function startMeeting(room, trigger) {
  if (room.state !== 'Playing' || room.meeting) return;
  room.state = 'Meeting';
  const now = Date.now();
  room.meeting = { trigger, votes: new Map(), votingStartsAt: now + DISCUSSION_MS, votingEndsAt: now + DISCUSSION_MS + VOTING_MS, ended: false };
  room.bodies = [];
  const players = [...room.players.values()];
  players.forEach((p, i) => {
    p.inVent = null;
    p.input = { up: false, down: false, left: false, right: false };
    const a = (i / players.length) * Math.PI * 2;
    p.x = room.map.spawn.x + Math.cos(a) * 150; p.y = room.map.spawn.y + Math.sin(a) * 100;
  });
  io.to(room.code).emit('meetingStarted', {
    trigger: { type: trigger.type, reporter: { socketId: trigger.reporter.socketId, name: trigger.reporter.name, colorHex: trigger.reporter.colorHex }, body: trigger.body ? publicBody(trigger.body) : null },
    players: players.map(publicPlayer),
    votingStartsAt: room.meeting.votingStartsAt,
    votingEndsAt: room.meeting.votingEndsAt,
  });
  sendVoteStatus(room);
  later(room, () => endMeeting(room), DISCUSSION_MS + VOTING_MS + 200);
}

function meetingChat(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (!room.meeting || room.meeting.ended) return fail(cb, 'No meeting running.');
    if (!me.isAlive) return fail(cb, 'Ghosts cannot chat.');
    const message = String(payload?.message || '').slice(0, 200).trim();
    if (!message) return fail(cb, 'Empty message.');
    io.to(room.code).emit('chatMessage', { sender: { socketId: me.socketId, name: me.name, colorHex: me.colorHex }, message, at: Date.now() });
    ok(cb);
  });
}

function castVote(socket, payload, cb) {
  withGame(socket, cb, (room, me) => {
    if (!room.meeting || room.meeting.ended) return fail(cb, 'No meeting running.');
    if (Date.now() < room.meeting.votingStartsAt) return fail(cb, 'Voting has not started.');
    if (!me.isAlive) return fail(cb, 'Ghosts cannot vote.');
    if (room.meeting.votes.has(me.socketId)) return fail(cb, 'You already voted.');
    const target = payload?.targetSocketId ? room.players.get(payload.targetSocketId) : null;
    if (payload?.targetSocketId && payload.targetSocketId !== 'SKIP' && (!target || !target.isAlive)) return fail(cb, 'Invalid vote.');
    room.meeting.votes.set(me.socketId, payload?.targetSocketId === 'SKIP' ? null : (target ? target.socketId : null));
    ok(cb);
    sendVoteStatus(room);
    maybeEndEarly(room);
  });
}

function sendVoteStatus(room) {
  if (!room.meeting) return;
  io.to(room.code).emit('voteStatus', { votedCount: room.meeting.votes.size, voterCount: alive(room).length });
}

function maybeEndEarly(room) {
  if (room.meeting && !room.meeting.ended && room.meeting.votes.size >= alive(room).length) later(room, () => endMeeting(room), 900);
}

function endMeeting(room) {
  if (!room.meeting || room.meeting.ended) return;
  room.meeting.ended = true;
  const tally = new Map();
  let skips = 0;
  for (const v of room.meeting.votes.values()) { if (v === null) skips++; else tally.set(v, (tally.get(v) || 0) + 1); }
  let top = null, topCount = 0, tie = false;
  for (const [id, c] of tally) { if (c > topCount) { top = id; topCount = c; tie = false; } else if (c === topCount) tie = true; }
  let ejected = null, isTie = false, skipped = false;
  if (top && topCount > skips && !tie) {
    const p = room.players.get(top);
    if (p) { p.isAlive = false; dropWeapon(room, p); ejected = { socketId: p.socketId, name: p.name, colorHex: p.colorHex, wasImpostor: p.isImpostor }; }
  } else if (top && (tie || topCount === skips)) isTie = true;
  else skipped = true;
  io.to(room.code).emit('meetingEnded', { ejected, isTie, skipped, votes: [...room.meeting.votes.entries()].map(([voter, target]) => ({ voter, target })) });
  later(room, () => {
    room.meeting = null;
    if (checkWin(room)) return;
    room.state = 'Playing';
    const now = Date.now();
    for (const p of room.players.values()) p.killCooldownUntil = now + KILL_COOLDOWN_MS * 0.7;
    io.to(room.code).emit('gameResumed', { taskProgress: room.taskTotal ? room.taskDone / room.taskTotal : 0 });
  }, EJECT_MS);
}

/* ---------------------------------------------------------------------------
   Win conditions / lobby return
   --------------------------------------------------------------------------- */
function checkWin(room) {
  if (room.state === 'Lobby' || room.state === 'Ended') return room.state === 'Ended';
  const imps = alive(room).filter(p => p.isImpostor).length;
  const crew = alive(room).filter(p => !p.isImpostor).length;
  let winner = null, reason = '';
  if (room.taskTotal && room.taskDone >= room.taskTotal) { winner = 'Crewmates'; reason = 'All tasks were completed.'; }
  else if (imps === 0) { winner = 'Crewmates'; reason = 'Every impostor was ejected.'; }
  else if (imps >= crew) { winner = 'Impostors'; reason = 'The impostors outnumber the crew.'; }
  if (!winner) return false;
  room.state = 'Ended';
  clearInterval(room.tick); room.tick = null;
  const wasMeeting = Boolean(room.meeting);
  later(room, () => io.to(room.code).emit('gameOver', { winner, reason, players: [...room.players.values()].map(p => ({ ...publicPlayer(p), isImpostor: p.isImpostor })) }), wasMeeting ? 400 : 900);
  emitStats();
  return true;
}

function returnToLobby(socket, cb) {
  withGame(socket, cb, (room) => {
    if (room.hostId !== socket.id) return fail(cb, 'Only the host can return everyone to the lobby.');
    ok(cb);
    room.state = 'Lobby';
    room.meeting = null;
    room.bodies = [];
    clearInterval(room.tick); room.tick = null;
    for (const t of room.timers) clearTimeout(t);
    room.timers.clear();
    room.map = Maps.buildMap(room.mapId);
    initializeWorldSystems(room);
    for (const p of room.players.values()) { p.isAlive = true; p.isImpostor = false; p.inVent = null; p.weapon = null; p.stunnedUntil = 0; }
    io.to(room.code).emit('returnedToLobby', roomPayload(room));
    emitStats();
  });
}

/* ---------------------------------------------------------------------------
   Socket wiring
   --------------------------------------------------------------------------- */
io.on('connection', socket => {
  emitStats();

  socket.on('getServerStats', cb => ok(cb, { stats: serverStats() }));
  socket.on('listRooms', cb => ok(cb, { rooms: publicRooms() }));
  socket.on('createRoom', (payload, cb) => createRoom(socket, payload, cb));
  socket.on('getRoomInfo', (payload, cb) => {
    const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
    if (!room) return fail(cb, 'Room not found.');
    ok(cb, { room: { ...roomPayload(room), takenPlayerNumbers: [...room.players.values()].map(p => p.number) } });
  });
  socket.on('joinRoom', (payload, cb) => joinRoom(socket, payload, cb));
  socket.on('spectateRoom', (payload, cb) => spectateRoom(socket, payload, cb));
  socket.on('setImpostorCount', (payload, cb) => withGame(socket, cb, (room) => {
    if (room.hostId !== socket.id) return fail(cb, 'Only the host can change that.');
    if (room.state !== 'Lobby') return fail(cb, 'Game already running.');
    room.impostorCount = Math.max(1, Math.min(3, Number(payload?.count) || 1));
    ok(cb, { room: roomPayload(room) });
    broadcastRoom(room);
  }));
  socket.on('setMap', (payload, cb) => withGame(socket, cb, (room) => {
    if (room.hostId !== socket.id) return fail(cb, 'Only the host can change the map.');
    if (room.state !== 'Lobby') return fail(cb, 'Game already running.');
    if (!Maps.MAPS[payload?.mapId]) return fail(cb, 'Unknown map.');
    room.mapId = payload.mapId;
    room.map = Maps.buildMap(room.mapId);
    initializeWorldSystems(room);
    ok(cb, { room: roomPayload(room) });
    broadcastRoom(room);
  }));
  socket.on('setRoomVisibility', (payload, cb) => withGame(socket, cb, room => {
    if (room.hostId !== socket.id) return fail(cb, 'Only the host can change room visibility.');
    if (room.state !== 'Lobby') return fail(cb, 'Game already running.');
    room.isPublic = payload?.isPublic !== false;
    room.allowSpectators = payload?.allowSpectators !== false;
    ok(cb, { room: roomPayload(room) });
    broadcastRoom(room);
  }));
  socket.on('startGame', cb => startGame(socket, cb));
  socket.on('playerInput', payload => {
    const room = rooms.get(socketRoom.get(socket.id));
    const me = room?.players.get(socket.id);
    if (me && socketMode.get(socket.id) === 'player') me.input = { up: !!payload?.up, down: !!payload?.down, left: !!payload?.left, right: !!payload?.right };
  });
  socket.on('killPlayer', (payload, cb) => killPlayer(socket, payload, cb));
  socket.on('taskComplete', (payload, cb) => taskComplete(socket, payload, cb));
  socket.on('ventAction', (payload, cb) => ventAction(socket, payload, cb));
  socket.on('gateAction', (payload, cb) => gateAction(socket, payload, cb));
  socket.on('pickupWeapon', (payload, cb) => pickupWeapon(socket, payload, cb));
  socket.on('fireWeapon', (payload, cb) => fireWeapon(socket, payload, cb));
  socket.on('reportBody', (payload, cb) => reportBody(socket, payload, cb));
  socket.on('emergencyMeeting', cb => emergencyMeeting(socket, cb));
  socket.on('meetingChat', (payload, cb) => meetingChat(socket, payload, cb));
  socket.on('castVote', (payload, cb) => castVote(socket, payload, cb));
  socket.on('returnToLobby', cb => returnToLobby(socket, cb));
  socket.on('leaveRoom', cb => { leaveRoom(socket); ok(cb); });
  socket.on('disconnect', () => leaveRoom(socket));
});

setInterval(emitStats, 10000).unref?.();

httpServer.listen(PORT, () => {
  console.log(`Space Party server listening on :${PORT}`);
  console.log(`Maps: ${Maps.MAP_LIST.map(m => m.id).join(', ')}`);
  console.log(`Z.AI assistance: ${ZAI_ENABLED && ZAI_API_KEY ? `enabled (${ZAI_MODEL})` : 'disabled'}`);
});
