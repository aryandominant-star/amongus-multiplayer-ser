/* ============================================================================
   SPACE PARTY — server.js
   Authoritative multiplayer server (Node + Socket.IO). Implements exactly the
   event protocol the browser client uses, and adds map selection:
     createRoom { name, playerNumber, impostorCount, mapId? }
     setMap     { mapId }              (host only, in the lobby)   -> roomUpdated
   Everything else is unchanged from the original protocol.
   ============================================================================ */
'use strict';

const http = require('http');
const { Server } = require('socket.io');
const Maps = require('./maps');

const PORT = process.env.PORT || 3000;
const TICK_HZ = 30;
const SPEED = 230;                 // px / s
const KILL_RANGE = 90;
const KILL_COOLDOWN_MS = 24000;
const DISCUSSION_MS = 15000;
const VOTING_MS = 30000;
const EJECT_MS = 5200;
const TASKS_PER_PLAYER = 6;
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 4;
const VIEW_RANGE = 700;            // how far a kill effect is broadcast

const COLORS = [
  { number: 1, color: 'red', hex: '#d93b3b' }, { number: 2, color: 'blue', hex: '#3b66d9' },
  { number: 3, color: 'green', hex: '#39a85a' }, { number: 4, color: 'pink', hex: '#ef72b7' },
  { number: 5, color: 'orange', hex: '#f59b42' }, { number: 6, color: 'yellow', hex: '#f3d84a' },
  { number: 7, color: 'black', hex: '#2c2c35' }, { number: 8, color: 'white', hex: '#e8edf2' },
  { number: 9, color: 'purple', hex: '#7952b3' }, { number: 10, color: 'cyan', hex: '#46c7c7' },
];

const rooms = new Map();           // roomCode -> room
const socketRoom = new Map();      // socket.id -> roomCode

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ok = (cb, extra = {}) => typeof cb === 'function' && cb({ ok: true, ...extra });
const fail = (cb, error) => typeof cb === 'function' && cb({ ok: false, error });

/* ---------------------------------------------------------------------------
   HTTP + Socket.IO
   --------------------------------------------------------------------------- */
const httpServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, name: 'space-party-server', rooms: rooms.size, maps: Maps.MAP_LIST.map(m => m.id), time: Date.now() }));
});
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] }, pingInterval: 10000, pingTimeout: 20000 });

/* ---------------------------------------------------------------------------
   Room helpers
   --------------------------------------------------------------------------- */
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do { code = ''; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; } while (rooms.has(code));
  return code;
}

function publicPlayer(p) {
  return { socketId: p.socketId, name: p.name, number: p.number, color: p.color, colorHex: p.colorHex, isAlive: p.isAlive };
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
    playerList: [...room.players.values()].map(publicPlayer),
  };
}

function broadcastRoom(room) { io.to(room.code).emit('roomUpdated', roomPayload(room)); }
function alive(room) { return [...room.players.values()].filter(p => p.isAlive); }
function roomOf(room, p) { return (room.map._namedRooms.find(r => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) || {}).name || 'the hallway'; }
const publicBody = b => ({ id: b.id, x: b.x, y: b.y, victimSocketId: b.victimSocketId, victimName: b.victimName, victimColorHex: b.victimColorHex });

function makePlayer(socket, name, number) {
  const c = COLORS.find(x => x.number === number);
  return {
    socketId: socket.id, name, number, color: c.color, colorHex: c.hex,
    isAlive: true, isImpostor: false, x: 0, y: 0, inVent: null, killCooldownUntil: 0,
    input: { up: false, down: false, left: false, right: false },
  };
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
    mapId, map: Maps.buildMap(mapId), nav: null, state: 'Lobby', players: new Map(),
    bodies: [], tasks: new Map(), taskDone: 0, taskTotal: 0, meeting: null, tick: null, lastTick: 0, timers: new Set(),
  };
  room.players.set(socket.id, makePlayer(socket, name, number));
  rooms.set(room.code, room);
  socketRoom.set(socket.id, room.code);
  socket.join(room.code);
  ok(cb, { room: roomPayload(room) });
  broadcastRoom(room);
}

function joinRoom(socket, payload, cb) {
  const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
  const name = String(payload?.name || '').trim().slice(0, 16);
  const number = Number(payload?.playerNumber);
  if (!room) return fail(cb, 'Room not found.');
  if (room.state !== 'Lobby') return fail(cb, 'That game is already in progress.');
  if (room.players.size >= MAX_PLAYERS) return fail(cb, 'Room is full.');
  if (!name) return fail(cb, 'Enter a display name.');
  if (!COLORS.some(c => c.number === number)) return fail(cb, 'Choose a suit color.');
  if ([...room.players.values()].some(p => p.number === number)) return fail(cb, 'That color is taken.');
  if (socketRoom.has(socket.id)) leaveRoom(socket);
  room.players.set(socket.id, makePlayer(socket, name, number));
  socketRoom.set(socket.id, room.code);
  socket.join(room.code);
  ok(cb, { room: roomPayload(room) });
  broadcastRoom(room);
}

function leaveRoom(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRoom.delete(socket.id);
  socket.leave(code);
  if (!room) return;
  const p = room.players.get(socket.id);
  room.players.delete(socket.id);
  if (room.players.size === 0) { destroyRoom(room); return; }
  io.to(code).emit('playerLeft', { socketId: socket.id, name: p?.name || 'Player' });
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
    io.to(code).emit('hostChanged', { hostSocketId: room.hostId });
  }
  if (room.state === 'Lobby') broadcastRoom(room);
  else if (room.state === 'Meeting') { if (room.meeting?.votes) room.meeting.votes.delete(socket.id); sendVoteStatus(room); maybeEndEarly(room); checkWin(room); }
  else checkWin(room);
}

function destroyRoom(room) {
  clearInterval(room.tick);
  for (const t of room.timers) clearTimeout(t);
  rooms.delete(room.code);
}

const later = (room, fn, ms) => { const t = setTimeout(() => { room.timers.delete(t); fn(); }, ms); room.timers.add(t); return t; };

/* ---------------------------------------------------------------------------
   Game start
   --------------------------------------------------------------------------- */
function startGame(socket, cb) {
  const room = rooms.get(socketRoom.get(socket.id));
  if (!room) return fail(cb, 'You are not in a room.');
  if (room.hostId !== socket.id) return fail(cb, 'Only the host can start.');
  if (room.state !== 'Lobby') return fail(cb, 'Game already running.');
  if (room.players.size < MIN_PLAYERS) return fail(cb, `Need at least ${MIN_PLAYERS} players.`);
  if (room.impostorCount >= Math.floor(room.players.size / 2)) return fail(cb, 'Too many impostors for this many players.');
  ok(cb);

  room.map = Maps.buildMap(room.mapId);
  room.nav = Maps.buildNav(room.map._walkable);
  room.state = 'Playing';
  room.bodies = [];
  room.taskDone = 0;
  room.tasks = new Map();
  const players = [...room.players.values()];
  players.forEach(p => { p.isAlive = true; p.isImpostor = false; p.inVent = null; p.input = { up: false, down: false, left: false, right: false }; });
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
  const mapPayload = { width: room.map.width, height: room.map.height, name: room.map.name, spawn: room.map.spawn, rooms: room.map.rooms, collisionRects: [], taskLocations: room.map.taskLocations, vents: room.map.vents, emergencyButton: room.map.emergencyButton };
  for (const p of players) {
    io.to(p.socketId).emit('gameStarted', {
      roomCode: room.code,
      role: p.isImpostor ? 'Impostor' : 'Crewmate',
      teammates: p.isImpostor ? teammates : [],
      tasks: (room.tasks.get(p.socketId) || []).map(t => ({ id: t.id, name: t.name, room: t.room, type: t.type, x: t.x, y: t.y, completed: false })),
      players: players.map(q => ({ ...publicPlayer(q), x: q.x, y: q.y })),
      map: mapPayload,
      killCooldownMs: firstCooldown,
      taskProgress: 0,
    });
  }
  room.lastTick = Date.now();
  clearInterval(room.tick);
  room.tick = setInterval(() => tick(room), 1000 / TICK_HZ);
}

/* ---------------------------------------------------------------------------
   Movement + snapshots
   --------------------------------------------------------------------------- */
function tryMove(room, p, dx, dy) {
  if (!p.isAlive) { p.x = Math.max(0, Math.min(room.map.width, p.x + dx)); p.y = Math.max(0, Math.min(room.map.height, p.y + dy)); return; }
  if (room.nav.walkableAt({ x: p.x + dx, y: p.y + dy })) { p.x += dx; p.y += dy; return; }
  if (room.nav.walkableAt({ x: p.x + dx, y: p.y })) { p.x += dx; return; }
  if (room.nav.walkableAt({ x: p.x, y: p.y + dy })) p.y += dy;
}

function tick(room) {
  const now = Date.now();
  const dt = Math.min(.1, (now - room.lastTick) / 1000);
  room.lastTick = now;
  if (room.state !== 'Playing') return;
  for (const p of room.players.values()) {
    if (p.inVent) continue;
    const dx = (p.input.right ? 1 : 0) - (p.input.left ? 1 : 0);
    const dy = (p.input.down ? 1 : 0) - (p.input.up ? 1 : 0);
    if (dx || dy) { const l = Math.hypot(dx, dy); tryMove(room, p, dx / l * SPEED * dt, dy / l * SPEED * dt); }
  }
  const all = [...room.players.values()];
  const bodies = room.bodies.map(publicBody);
  const progress = room.taskTotal ? room.taskDone / room.taskTotal : 0;
  for (const me of all) {
    const meDead = !me.isAlive;
    const players = all
      .filter(p => p === me || (!p.inVent && (meDead || p.isAlive)))
      .map(p => ({ ...publicPlayer(p), x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
    io.to(me.socketId).emit('worldSnapshot', { gameState: room.state, taskProgress: progress, bodies, players });
  }
}

/* ---------------------------------------------------------------------------
   Actions
   --------------------------------------------------------------------------- */
function withGame(socket, cb, fn) {
  const room = rooms.get(socketRoom.get(socket.id));
  if (!room) return fail(cb, 'You are not in a room.');
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
    if (dist(me, target) > KILL_RANGE + 10) return fail(cb, 'Too far away.');
    if (me.inVent) return fail(cb, 'Leave the vent first.');
    doKill(room, me, target);
    ok(cb, { cooldownUntil: me.killCooldownUntil });
  });
}

function doKill(room, killer, victim) {
  const now = Date.now();
  victim.isAlive = false;
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
    if (payload?.targetSocketId && (!target || !target.isAlive)) return fail(cb, 'Invalid vote.');
    room.meeting.votes.set(me.socketId, target ? target.socketId : null);
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
    if (p) { p.isAlive = false; ejected = { socketId: p.socketId, name: p.name, colorHex: p.colorHex, wasImpostor: p.isImpostor }; }
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
    for (const p of room.players.values()) { p.isAlive = true; p.isImpostor = false; p.inVent = null; }
    io.to(room.code).emit('returnedToLobby', roomPayload(room));
  });
}

/* ---------------------------------------------------------------------------
   Socket wiring
   --------------------------------------------------------------------------- */
io.on('connection', socket => {
  socket.on('createRoom', (payload, cb) => createRoom(socket, payload, cb));
  socket.on('getRoomInfo', (payload, cb) => {
    const room = rooms.get(String(payload?.roomCode || '').toUpperCase());
    if (!room) return fail(cb, 'Room not found.');
    ok(cb, { room: { ...roomPayload(room), takenPlayerNumbers: [...room.players.values()].map(p => p.number) } });
  });
  socket.on('joinRoom', (payload, cb) => joinRoom(socket, payload, cb));
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
    ok(cb, { room: roomPayload(room) });
    broadcastRoom(room);
  }));
  socket.on('startGame', cb => startGame(socket, cb));
  socket.on('playerInput', payload => {
    const room = rooms.get(socketRoom.get(socket.id));
    const me = room?.players.get(socket.id);
    if (me) me.input = { up: !!payload?.up, down: !!payload?.down, left: !!payload?.left, right: !!payload?.right };
  });
  socket.on('killPlayer', (payload, cb) => killPlayer(socket, payload, cb));
  socket.on('taskComplete', (payload, cb) => taskComplete(socket, payload, cb));
  socket.on('ventAction', (payload, cb) => ventAction(socket, payload, cb));
  socket.on('reportBody', (payload, cb) => reportBody(socket, payload, cb));
  socket.on('emergencyMeeting', cb => emergencyMeeting(socket, cb));
  socket.on('meetingChat', (payload, cb) => meetingChat(socket, payload, cb));
  socket.on('castVote', (payload, cb) => castVote(socket, payload, cb));
  socket.on('returnToLobby', cb => returnToLobby(socket, cb));
  socket.on('leaveRoom', cb => { leaveRoom(socket); ok(cb); });
  socket.on('disconnect', () => leaveRoom(socket));
});

httpServer.listen(PORT, () => console.log(`Space Party server listening on :${PORT} — maps: ${Maps.MAP_LIST.map(m => m.id).join(', ')}`));
