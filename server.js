'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const TICK_RATE = Number(process.env.TICK_RATE || 30);
const MAX_PLAYERS = 10;
const MIN_PLAYERS_TO_START = Number(process.env.MIN_PLAYERS_TO_START || 4);
const PLAYER_SPEED = Number(process.env.PLAYER_SPEED || 220); // pixels / second
const PLAYER_RADIUS = 18;
const KILL_RADIUS = 85;
const REPORT_RADIUS = 110;
const VENT_RADIUS = 90;
const TASK_RADIUS = 120;
const EMERGENCY_RADIUS = 100;
const KILL_COOLDOWN_MS = Number(process.env.KILL_COOLDOWN_MS || 25_000);
const INITIAL_KILL_COOLDOWN_MS = Number(process.env.INITIAL_KILL_COOLDOWN_MS || 10_000);
const DISCUSSION_MS = Number(process.env.DISCUSSION_MS || 10_000);
const VOTING_MS = Number(process.env.VOTING_MS || 45_000);
const EMERGENCY_MEETINGS_PER_PLAYER = Number(process.env.EMERGENCY_MEETINGS_PER_PLAYER || 1);

const GameState = Object.freeze({
  LOBBY: 'Lobby',
  PLAYING: 'Playing',
  MEETING: 'Meeting',
  GAME_OVER: 'GameOver',
});

const PLAYER_SLOTS = Object.freeze([
  { number: 1, color: 'red', hex: '#d93b3b' },
  { number: 2, color: 'blue', hex: '#3b66d9' },
  { number: 3, color: 'green', hex: '#39a85a' },
  { number: 4, color: 'pink', hex: '#ef72b7' },
  { number: 5, color: 'orange', hex: '#f59b42' },
  { number: 6, color: 'yellow', hex: '#f3d84a' },
  { number: 7, color: 'black', hex: '#2c2c35' },
  { number: 8, color: 'white', hex: '#e8edf2' },
  { number: 9, color: 'purple', hex: '#7952b3' },
  { number: 10, color: 'cyan', hex: '#46c7c7' },
]);

// This same geometry can be copied/shared with the browser in Step 3.
const MAP = Object.freeze({
  id: 'station-alpha',
  width: 1600,
  height: 900,
  spawn: { x: 800, y: 450 },
  emergencyButton: { x: 800, y: 450 },
  rooms: [
    { id: 'reactor', name: 'Reactor', x: 20, y: 20, w: 470, h: 410 },
    { id: 'electrical', name: 'Electrical', x: 20, y: 470, w: 470, h: 410 },
    { id: 'cafeteria', name: 'Cafeteria', x: 510, y: 20, w: 580, h: 860 },
    { id: 'o2', name: 'O2', x: 1110, y: 20, w: 470, h: 410 },
    { id: 'shields', name: 'Shields', x: 1110, y: 470, w: 470, h: 410 },
  ],
  // Interior walls. Gaps act as doorways/corridors.
  collisionRects: [
    { x: 490, y: 0, w: 20, h: 300 },
    { x: 490, y: 600, w: 20, h: 300 },
    { x: 1090, y: 0, w: 20, h: 300 },
    { x: 1090, y: 600, w: 20, h: 300 },
    { x: 0, y: 430, w: 180, h: 20 },
    { x: 320, y: 430, w: 170, h: 20 },
    { x: 1110, y: 430, w: 170, h: 20 },
    { x: 1420, y: 430, w: 180, h: 20 },
  ],
  vents: [
    { id: 'vent-reactor', room: 'reactor', x: 190, y: 170, connections: ['vent-electrical', 'vent-o2'] },
    { id: 'vent-electrical', room: 'electrical', x: 240, y: 700, connections: ['vent-reactor', 'vent-shields'] },
    { id: 'vent-o2', room: 'o2', x: 1360, y: 175, connections: ['vent-reactor', 'vent-shields'] },
    { id: 'vent-shields', room: 'shields', x: 1360, y: 700, connections: ['vent-electrical', 'vent-o2'] },
  ],
});

const TASK_LIBRARY = Object.freeze([
  { templateId: 'reactor-sequence', type: 'sequence', name: 'Start Reactor', room: 'reactor', x: 170, y: 260 },
  { templateId: 'electrical-wires', type: 'wires', name: 'Fix Wiring', room: 'electrical', x: 280, y: 650 },
  { templateId: 'o2-filter', type: 'button_hold', name: 'Clean O2 Filter', room: 'o2', x: 1350, y: 255 },
  { templateId: 'shields-charge', type: 'button_hold', name: 'Prime Shields', room: 'shields', x: 1340, y: 650 },
  { templateId: 'cafeteria-card', type: 'card_swipe', name: 'Swipe ID Card', room: 'cafeteria', x: 690, y: 520 },
  { templateId: 'cafeteria-align', type: 'sequence', name: 'Align Navigation', room: 'cafeteria', x: 930, y: 340 },
]);

const SPAWN_POINTS = Object.freeze([
  { x: 730, y: 390 }, { x: 800, y: 390 }, { x: 870, y: 390 },
  { x: 700, y: 450 }, { x: 900, y: 450 },
  { x: 700, y: 520 }, { x: 900, y: 520 },
  { x: 750, y: 570 }, { x: 820, y: 570 }, { x: 870, y: 570 },
]);

const app = express();
const httpServer = http.createServer(app);

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const io = new Server(httpServer, {
  cors: allowedOrigins.length
    ? { origin: allowedOrigins, methods: ['GET', 'POST'] }
    : undefined,
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, any>} */
const rooms = new Map();

class GameError extends Error {
  constructor(message, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

function now() {
  return Date.now();
}

function touchRoom(room) {
  room.updatedAt = now();
}

function safeDisplayName(value) {
  if (typeof value !== 'string') {
    throw new GameError('Name is required.', 'INVALID_NAME');
  }

  const cleaned = value
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 16);

  if (!cleaned) {
    throw new GameError('Name is required.', 'INVALID_NAME');
  }

  return cleaned;
}

function normalizeRoomCode(value) {
  if (typeof value !== 'string') return '';
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function normalizePlayerNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_PLAYERS) {
    throw new GameError('Player number must be between 1 and 10.', 'INVALID_PLAYER_NUMBER');
  }
  return number;
}

function getSlot(number) {
  const slot = PLAYER_SLOTS.find((s) => s.number === number);
  if (!slot) {
    throw new GameError('Invalid player slot.', 'INVALID_PLAYER_NUMBER');
  }
  return slot;
}

function randomRoomCode() {
  const mode = (process.env.ROOM_CODE_MODE || 'letters').toLowerCase();

  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = '';

    if (mode === 'digits') {
      code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    } else {
      // Avoid I/O to reduce visual confusion with 1/0.
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
      for (let i = 0; i < 4; i += 1) {
        code += alphabet[crypto.randomInt(0, alphabet.length)];
      }
    }

    if (!rooms.has(code)) return code;
  }

  throw new GameError('Could not allocate a room code. Please try again.', 'ROOM_CODE_EXHAUSTED');
}

function cryptoShuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function makePlayer(socketId, name, playerNumber, spawnIndex = 0) {
  const slot = getSlot(playerNumber);
  const spawn = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length] || MAP.spawn;

  return {
    socketId,
    name,
    number: slot.number,
    color: slot.color,
    colorHex: slot.hex,
    isImpostor: false,
    isAlive: true,
    currentX: spawn.x,
    currentY: spawn.y,
    input: { up: false, down: false, left: false, right: false },
    tasks: [],
    inVent: false,
    currentVentId: null,
    killCooldownUntil: 0,
    emergencyMeetingsRemaining: EMERGENCY_MEETINGS_PER_PLAYER,
    joinedAt: now(),
  };
}

function createRoom(socketId, payload = {}) {
  const roomCode = randomRoomCode();
  const name = safeDisplayName(payload.name);
  const playerNumber = normalizePlayerNumber(payload.playerNumber);

  const requestedImpostors = Number(payload.impostorCount || 1);
  const impostorCount = Number.isInteger(requestedImpostors)
    ? Math.max(1, Math.min(3, requestedImpostors))
    : 1;

  const player = makePlayer(socketId, name, playerNumber, 0);
  const room = {
    roomCode,
    hostSocketId: socketId,
    playerList: [player],
    gameState: GameState.LOBBY,
    impostorCount,
    tasksCompleted: 0,
    totalTasks: 0,
    bodies: [],
    meeting: null,
    winner: null,
    gameOverReason: null,
    createdAt: now(),
    updatedAt: now(),
  };

  rooms.set(roomCode, room);
  return room;
}

function publicPlayer(player) {
  return {
    socketId: player.socketId,
    name: player.name,
    number: player.number,
    color: player.color,
    colorHex: player.colorHex,
    isAlive: player.isAlive,
  };
}

function publicRoomState(room) {
  const takenPlayerNumbers = room.playerList.map((p) => p.number);

  return {
    roomCode: room.roomCode,
    hostSocketId: room.hostSocketId,
    gameState: room.gameState,
    impostorCount: room.impostorCount,
    tasksCompleted: room.tasksCompleted,
    totalTasks: room.totalTasks,
    taskProgress: getTaskProgress(room),
    playerList: room.playerList.map(publicPlayer),
    takenPlayerNumbers,
    availablePlayerNumbers: PLAYER_SLOTS
      .map((slot) => slot.number)
      .filter((number) => !takenPlayerNumbers.includes(number)),
    maxPlayers: MAX_PLAYERS,
  };
}

function getTaskProgress(room) {
  if (room.totalTasks <= 0) return 0;
  return Math.max(0, Math.min(1, room.tasksCompleted / room.totalTasks));
}

function getRoomForSocket(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) {
    throw new GameError('You are not in a room.', 'NOT_IN_ROOM');
  }

  const room = rooms.get(roomCode);
  if (!room) {
    socket.data.roomCode = null;
    throw new GameError('Room no longer exists.', 'ROOM_NOT_FOUND');
  }

  return room;
}

function getPlayer(room, socketId) {
  const player = room.playerList.find((p) => p.socketId === socketId);
  if (!player) {
    throw new GameError('Player not found in room.', 'PLAYER_NOT_FOUND');
  }
  return player;
}

function assertHost(room, socketId) {
  if (room.hostSocketId !== socketId) {
    throw new GameError('Only the host can do that.', 'HOST_ONLY');
  }
}

function assertGameState(room, expected) {
  if (room.gameState !== expected) {
    throw new GameError(`Action is only valid while game state is ${expected}.`, 'INVALID_GAME_STATE');
  }
}

function addPlayerToRoom(room, socketId, payload = {}) {
  assertGameState(room, GameState.LOBBY);

  if (room.playerList.length >= MAX_PLAYERS) {
    throw new GameError('Room is full.', 'ROOM_FULL');
  }

  const name = safeDisplayName(payload.name);
  const playerNumber = normalizePlayerNumber(payload.playerNumber);

  if (room.playerList.some((p) => p.number === playerNumber)) {
    throw new GameError('That player number/color is already taken.', 'PLAYER_NUMBER_TAKEN');
  }

  const player = makePlayer(socketId, name, playerNumber, room.playerList.length);
  room.playerList.push(player);
  touchRoom(room);
  return player;
}

function sanitizeMapForClient() {
  return {
    id: MAP.id,
    width: MAP.width,
    height: MAP.height,
    spawn: MAP.spawn,
    emergencyButton: MAP.emergencyButton,
    rooms: MAP.rooms,
    collisionRects: MAP.collisionRects,
    vents: MAP.vents,
  };
}

function assignTasks(player, isFake = false) {
  const chosen = cryptoShuffle(TASK_LIBRARY).slice(0, 3);
  return chosen.map((task) => ({
    id: crypto.randomUUID(),
    templateId: task.templateId,
    type: task.type,
    name: task.name,
    room: task.room,
    x: task.x,
    y: task.y,
    completed: false,
    isFake,
  }));
}

function resetPlayerForGame(player, spawnIndex) {
  const spawn = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length] || MAP.spawn;
  player.isAlive = true;
  player.currentX = spawn.x;
  player.currentY = spawn.y;
  player.input = { up: false, down: false, left: false, right: false };
  player.inVent = false;
  player.currentVentId = null;
  player.killCooldownUntil = now() + INITIAL_KILL_COOLDOWN_MS;
  player.emergencyMeetingsRemaining = EMERGENCY_MEETINGS_PER_PLAYER;
}

function startGame(room) {
  if (room.playerList.length < MIN_PLAYERS_TO_START) {
    throw new GameError(
      `At least ${MIN_PLAYERS_TO_START} players are required to start.`,
      'NOT_ENOUGH_PLAYERS'
    );
  }

  const maxImpostors = Math.max(1, Math.floor((room.playerList.length - 1) / 2));
  const impostorCount = Math.max(1, Math.min(room.impostorCount, maxImpostors));
  room.impostorCount = impostorCount;

  const shuffledPlayers = cryptoShuffle(room.playerList);
  const impostorIds = new Set(shuffledPlayers.slice(0, impostorCount).map((p) => p.socketId));

  room.tasksCompleted = 0;
  room.totalTasks = 0;
  room.bodies = [];
  room.winner = null;
  room.gameOverReason = null;
  room.meeting = null;
  room.gameState = GameState.PLAYING;

  room.playerList.forEach((player, index) => {
    resetPlayerForGame(player, index);
    player.isImpostor = impostorIds.has(player.socketId);
    player.tasks = assignTasks(player, player.isImpostor);

    if (!player.isImpostor) {
      room.totalTasks += player.tasks.length;
    }
  });

  touchRoom(room);
}

function distance(aX, aY, bX, bY) {
  return Math.hypot(aX - bX, aY - bY);
}

function circleIntersectsRect(cx, cy, radius, rect) {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy < radius * radius;
}

function collidesWithMap(x, y) {
  if (
    x - PLAYER_RADIUS < 0 ||
    y - PLAYER_RADIUS < 0 ||
    x + PLAYER_RADIUS > MAP.width ||
    y + PLAYER_RADIUS > MAP.height
  ) {
    return true;
  }

  return MAP.collisionRects.some((rect) => circleIntersectsRect(x, y, PLAYER_RADIUS, rect));
}

function movePlayer(player, deltaSeconds) {
  if (!player.isAlive || player.inVent) return;

  let dx = 0;
  let dy = 0;
  if (player.input.left) dx -= 1;
  if (player.input.right) dx += 1;
  if (player.input.up) dy -= 1;
  if (player.input.down) dy += 1;

  if (dx === 0 && dy === 0) return;

  const length = Math.hypot(dx, dy);
  dx /= length;
  dy /= length;

  const stepX = dx * PLAYER_SPEED * deltaSeconds;
  const stepY = dy * PLAYER_SPEED * deltaSeconds;

  const candidateX = player.currentX + stepX;
  if (!collidesWithMap(candidateX, player.currentY)) {
    player.currentX = candidateX;
  }

  const candidateY = player.currentY + stepY;
  if (!collidesWithMap(player.currentX, candidateY)) {
    player.currentY = candidateY;
  }
}

function serializeBody(body) {
  return {
    id: body.id,
    victimSocketId: body.victimSocketId,
    victimName: body.victimName,
    victimNumber: body.victimNumber,
    victimColor: body.victimColor,
    victimColorHex: body.victimColorHex,
    x: body.x,
    y: body.y,
    reported: body.reported,
    createdAt: body.createdAt,
  };
}

function removeOutstandingTasksForDeadCrew(room, player) {
  if (player.isImpostor) return;

  const incomplete = player.tasks.filter((task) => !task.completed).length;
  if (incomplete > 0) {
    room.totalTasks = Math.max(room.tasksCompleted, room.totalTasks - incomplete);
  }
}

function emitTaskProgress(room) {
  io.to(room.roomCode).emit('taskProgress', {
    completed: room.tasksCompleted,
    total: room.totalTasks,
    progress: getTaskProgress(room),
  });
}

function checkWinConditions(room) {
  if (![GameState.PLAYING, GameState.MEETING].includes(room.gameState)) {
    return false;
  }

  const living = room.playerList.filter((p) => p.isAlive);
  const livingImpostors = living.filter((p) => p.isImpostor).length;
  const livingCrewmates = living.filter((p) => !p.isImpostor).length;

  if (livingImpostors === 0) {
    endGame(room, 'Crewmates', 'All impostors were eliminated.');
    return true;
  }

  if (livingImpostors >= livingCrewmates) {
    endGame(room, 'Impostors', 'Impostors reached parity with the crewmates.');
    return true;
  }

  if (room.totalTasks > 0 && room.tasksCompleted >= room.totalTasks) {
    endGame(room, 'Crewmates', 'All required tasks were completed.');
    return true;
  }

  return false;
}

function clearMeetingTimer(room) {
  if (room.meeting && room.meeting.timer) {
    clearTimeout(room.meeting.timer);
    room.meeting.timer = null;
  }
}

function endGame(room, winner, reason) {
  clearMeetingTimer(room);
  room.gameState = GameState.GAME_OVER;
  room.winner = winner;
  room.gameOverReason = reason;

  room.playerList.forEach((player) => {
    player.input = { up: false, down: false, left: false, right: false };
    player.inVent = false;
    player.currentVentId = null;
  });

  touchRoom(room);

  io.to(room.roomCode).emit('gameOver', {
    winner,
    reason,
    players: room.playerList.map((player) => ({
      ...publicPlayer(player),
      isImpostor: player.isImpostor,
    })),
  });
}

function getVent(ventId) {
  return MAP.vents.find((vent) => vent.id === ventId);
}

function beginMeeting(room, trigger) {
  if (room.gameState !== GameState.PLAYING) {
    throw new GameError('A meeting cannot start right now.', 'INVALID_GAME_STATE');
  }

  const startedAt = now();
  const meeting = {
    id: crypto.randomUUID(),
    trigger,
    startedAt,
    votingStartsAt: startedAt + DISCUSSION_MS,
    votingEndsAt: startedAt + DISCUSSION_MS + VOTING_MS,
    votes: new Map(),
    timer: null,
  };

  room.gameState = GameState.MEETING;
  room.meeting = meeting;

  room.playerList.forEach((player) => {
    player.input = { up: false, down: false, left: false, right: false };
    player.inVent = false;
    player.currentVentId = null;
  });

  meeting.timer = setTimeout(() => {
    const currentRoom = rooms.get(room.roomCode);
    if (!currentRoom || currentRoom.gameState !== GameState.MEETING) return;
    if (!currentRoom.meeting || currentRoom.meeting.id !== meeting.id) return;
    resolveMeeting(currentRoom);
  }, DISCUSSION_MS + VOTING_MS);

  touchRoom(room);

  io.to(room.roomCode).emit('meetingStarted', {
    meetingId: meeting.id,
    trigger,
    startedAt: meeting.startedAt,
    votingStartsAt: meeting.votingStartsAt,
    votingEndsAt: meeting.votingEndsAt,
    players: room.playerList.map(publicPlayer),
  });
}

function aliveVoters(room) {
  return room.playerList.filter((p) => p.isAlive);
}

function maybeResolveMeetingEarly(room) {
  if (!room.meeting || room.gameState !== GameState.MEETING) return;
  if (now() < room.meeting.votingStartsAt) return;

  const voters = aliveVoters(room);
  const everyAlivePlayerVoted = voters.every((player) => room.meeting.votes.has(player.socketId));
  if (everyAlivePlayerVoted) {
    resolveMeeting(room);
  }
}

function resolveMeeting(room) {
  if (room.gameState !== GameState.MEETING || !room.meeting) return;

  const meeting = room.meeting;
  clearMeetingTimer(room);

  const tally = new Map();
  for (const target of meeting.votes.values()) {
    tally.set(target, (tally.get(target) || 0) + 1);
  }

  let maxVotes = 0;
  for (const count of tally.values()) {
    maxVotes = Math.max(maxVotes, count);
  }

  const leaders = [...tally.entries()]
    .filter(([, count]) => count === maxVotes && maxVotes > 0)
    .map(([target]) => target);

  const isTie = leaders.length > 1;
  const skipWon = leaders.length === 1 && leaders[0] === 'SKIP';
  let ejected = null;

  if (!isTie && !skipWon && leaders.length === 1) {
    const targetSocketId = leaders[0];
    const target = room.playerList.find((p) => p.socketId === targetSocketId && p.isAlive);

    if (target) {
      target.isAlive = false;
      target.input = { up: false, down: false, left: false, right: false };
      removeOutstandingTasksForDeadCrew(room, target);
      ejected = {
        ...publicPlayer(target),
        wasImpostor: target.isImpostor,
      };
    }
  }

  const result = {
    meetingId: meeting.id,
    ejected,
    isTie,
    skipWon,
    tally: Object.fromEntries(tally),
  };

  room.meeting = null;
  room.bodies = [];

  room.playerList.forEach((player, index) => {
    if (player.isAlive) {
      const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length] || MAP.spawn;
      player.currentX = spawn.x;
      player.currentY = spawn.y;
      player.killCooldownUntil = now() + INITIAL_KILL_COOLDOWN_MS;
    }
    player.input = { up: false, down: false, left: false, right: false };
    player.inVent = false;
    player.currentVentId = null;
  });

  io.to(room.roomCode).emit('meetingEnded', result);
  emitTaskProgress(room);

  room.gameState = GameState.PLAYING;
  touchRoom(room);

  if (!checkWinConditions(room)) {
    io.to(room.roomCode).emit('gameResumed', {
      players: room.playerList.map(publicPlayer),
      taskProgress: getTaskProgress(room),
    });
  }
}

function resetRoomToLobby(room) {
  clearMeetingTimer(room);
  room.gameState = GameState.LOBBY;
  room.tasksCompleted = 0;
  room.totalTasks = 0;
  room.bodies = [];
  room.meeting = null;
  room.winner = null;
  room.gameOverReason = null;

  room.playerList.forEach((player, index) => {
    const spawn = SPAWN_POINTS[index % SPAWN_POINTS.length] || MAP.spawn;
    player.isImpostor = false;
    player.isAlive = true;
    player.currentX = spawn.x;
    player.currentY = spawn.y;
    player.input = { up: false, down: false, left: false, right: false };
    player.tasks = [];
    player.inVent = false;
    player.currentVentId = null;
    player.killCooldownUntil = 0;
    player.emergencyMeetingsRemaining = EMERGENCY_MEETINGS_PER_PLAYER;
  });

  touchRoom(room);
}

function registerAck(socket, eventName, handler) {
  socket.on(eventName, async (...args) => {
    const maybeAck = args[args.length - 1];
    const ack = typeof maybeAck === 'function' ? args.pop() : null;

    try {
      const result = await handler(...args);
      if (ack) ack({ ok: true, ...(result || {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected server error.';
      const code = error && error.code ? error.code : 'SERVER_ERROR';

      if (ack) {
        ack({ ok: false, error: message, code });
      } else {
        socket.emit('serverError', { error: message, code });
      }

      if (!(error instanceof GameError)) {
        console.error(`[${eventName}]`, error);
      }
    }
  });
}

function removeSocketFromCurrentRoom(socket, reason = 'left') {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  socket.data.roomCode = null;

  if (!room) return;

  const playerIndex = room.playerList.findIndex((p) => p.socketId === socket.id);
  if (playerIndex === -1) return;

  const [leavingPlayer] = room.playerList.splice(playerIndex, 1);

  if (!leavingPlayer.isImpostor && leavingPlayer.isAlive) {
    // Preserve already-completed task credit, but remove work that can no longer
    // be completed after this player disconnects.
    removeOutstandingTasksForDeadCrew(room, leavingPlayer);
  }

  if (room.meeting) {
    room.meeting.votes.delete(leavingPlayer.socketId);
    for (const [voter, target] of room.meeting.votes.entries()) {
      if (target === leavingPlayer.socketId) {
        room.meeting.votes.delete(voter);
      }
    }
  }

  if (room.playerList.length === 0) {
    clearMeetingTimer(room);
    rooms.delete(room.roomCode);
    return;
  }

  if (room.hostSocketId === leavingPlayer.socketId) {
    room.hostSocketId = room.playerList[0].socketId;
    io.to(room.roomCode).emit('hostChanged', { hostSocketId: room.hostSocketId });
  }

  touchRoom(room);

  io.to(room.roomCode).emit('playerLeft', {
    socketId: leavingPlayer.socketId,
    reason,
  });

  io.to(room.roomCode).emit('roomUpdated', publicRoomState(room));
  emitTaskProgress(room);

  if ([GameState.PLAYING, GameState.MEETING].includes(room.gameState)) {
    if (!checkWinConditions(room) && room.gameState === GameState.MEETING) {
      maybeResolveMeetingEarly(room);
    }
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

app.get('/api/rooms/:roomCode', (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const room = rooms.get(roomCode);

  if (!room) {
    return res.status(404).json({ ok: false, error: 'Room not found.' });
  }

  return res.json({ ok: true, room: publicRoomState(room) });
});

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  registerAck(socket, 'createRoom', (payload = {}) => {
    if (socket.data.roomCode) {
      throw new GameError('Leave your current room first.', 'ALREADY_IN_ROOM');
    }

    const room = createRoom(socket.id, payload);
    socket.data.roomCode = room.roomCode;
    socket.join(room.roomCode);

    socket.emit('roomUpdated', publicRoomState(room));

    return {
      room: publicRoomState(room),
      you: publicPlayer(getPlayer(room, socket.id)),
    };
  });

  registerAck(socket, 'getRoomInfo', (payload = {}) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);

    if (!room) {
      throw new GameError('Room not found.', 'ROOM_NOT_FOUND');
    }

    return { room: publicRoomState(room) };
  });

  registerAck(socket, 'joinRoom', (payload = {}) => {
    if (socket.data.roomCode) {
      throw new GameError('Leave your current room first.', 'ALREADY_IN_ROOM');
    }

    const roomCode = normalizeRoomCode(payload.roomCode);
    const room = rooms.get(roomCode);

    if (!room) {
      throw new GameError('Room not found.', 'ROOM_NOT_FOUND');
    }

    const player = addPlayerToRoom(room, socket.id, payload);
    socket.data.roomCode = room.roomCode;
    socket.join(room.roomCode);

    io.to(room.roomCode).emit('roomUpdated', publicRoomState(room));

    return {
      room: publicRoomState(room),
      you: publicPlayer(player),
    };
  });

  registerAck(socket, 'setImpostorCount', (payload = {}) => {
    const room = getRoomForSocket(socket);
    assertHost(room, socket.id);
    assertGameState(room, GameState.LOBBY);

    const count = Number(payload.count);
    if (!Number.isInteger(count) || count < 1 || count > 3) {
      throw new GameError('Impostor count must be 1, 2, or 3.', 'INVALID_IMPOSTOR_COUNT');
    }

    room.impostorCount = count;
    touchRoom(room);
    io.to(room.roomCode).emit('roomUpdated', publicRoomState(room));
    return { room: publicRoomState(room) };
  });

  registerAck(socket, 'startGame', () => {
    const room = getRoomForSocket(socket);
    assertHost(room, socket.id);
    assertGameState(room, GameState.LOBBY);

    startGame(room);

    const impostorTeammates = room.playerList.filter((p) => p.isImpostor).map(publicPlayer);

    for (const player of room.playerList) {
      io.to(player.socketId).emit('gameStarted', {
        roomCode: room.roomCode,
        gameState: room.gameState,
        map: sanitizeMapForClient(),
        players: room.playerList.map(publicPlayer),
        role: player.isImpostor ? 'Impostor' : 'Crewmate',
        teammates: player.isImpostor ? impostorTeammates : [],
        tasks: player.tasks.map(({ isFake, ...task }) => task),
        taskProgress: getTaskProgress(room),
        killCooldownMs: KILL_COOLDOWN_MS,
      });
    }

    io.to(room.roomCode).emit('roomUpdated', publicRoomState(room));
    return { started: true };
  });

  socket.on('playerInput', (payload = {}) => {
    try {
      const room = getRoomForSocket(socket);
      if (room.gameState !== GameState.PLAYING) return;

      const player = getPlayer(room, socket.id);
      if (!player.isAlive || player.inVent) return;

      player.input = {
        up: payload.up === true,
        down: payload.down === true,
        left: payload.left === true,
        right: payload.right === true,
      };
    } catch {
      // High-frequency input deliberately fails silently.
    }
  });

  registerAck(socket, 'killPlayer', (payload = {}) => {
    const room = getRoomForSocket(socket);
    assertGameState(room, GameState.PLAYING);

    const killer = getPlayer(room, socket.id);
    if (!killer.isAlive || !killer.isImpostor || killer.inVent) {
      throw new GameError('You cannot kill right now.', 'KILL_NOT_ALLOWED');
    }

    if (now() < killer.killCooldownUntil) {
      throw new GameError('Kill is still on cooldown.', 'KILL_COOLDOWN');
    }

    const target = room.playerList.find((p) => p.socketId === payload.targetSocketId);
    if (!target || !target.isAlive || target.isImpostor || target.inVent) {
      throw new GameError('Invalid kill target.', 'INVALID_KILL_TARGET');
    }

    const d = distance(killer.currentX, killer.currentY, target.currentX, target.currentY);
    if (d > KILL_RADIUS) {
      throw new GameError('Target is out of kill range.', 'OUT_OF_RANGE');
    }

    target.isAlive = false;
    target.input = { up: false, down: false, left: false, right: false };
    killer.killCooldownUntil = now() + KILL_COOLDOWN_MS;
    removeOutstandingTasksForDeadCrew(room, target);

    const body = {
      id: crypto.randomUUID(),
      victimSocketId: target.socketId,
      victimName: target.name,
      victimNumber: target.number,
      victimColor: target.color,
      victimColorHex: target.colorHex,
      x: target.currentX,
      y: target.currentY,
      reported: false,
      createdAt: now(),
    };

    room.bodies.push(body);
    touchRoom(room);

    io.to(target.socketId).emit('youWereKilled', { body: serializeBody(body) });
    io.to(room.roomCode).emit('playerKilled', { body: serializeBody(body) });
    emitTaskProgress(room);
    checkWinConditions(room);

    return { killed: true, cooldownUntil: killer.killCooldownUntil };
  });

  registerAck(socket, 'taskComplete', (payload = {}) => {
    const room = getRoomForSocket(socket);
    assertGameState(room, GameState.PLAYING);

    const player = getPlayer(room, socket.id);
    if (!player.isAlive || player.isImpostor || player.inVent) {
      throw new GameError('You cannot complete tasks right now.', 'TASK_NOT_ALLOWED');
    }

    const task = player.tasks.find((t) => t.id === payload.taskId);
    if (!task) {
      throw new GameError('Task is not assigned to this player.', 'INVALID_TASK');
    }
    if (task.completed) {
      throw new GameError('Task is already complete.', 'TASK_ALREADY_COMPLETE');
    }

    const d = distance(player.currentX, player.currentY, task.x, task.y);
    if (d > TASK_RADIUS) {
      throw new GameError('Move closer to the task console.', 'OUT_OF_RANGE');
    }

    task.completed = true;
    room.tasksCompleted += 1;
    touchRoom(room);

    socket.emit('yourTaskCompleted', { taskId: task.id });
    emitTaskProgress(room);
    checkWinConditions(room);

    return {
      taskId: task.id,
      completed: room.tasksCompleted,
      total: room.totalTasks,
      progress: getTaskProgress(room),
    };
  });

  registerAck(socket, 'ventAction', (payload = {}) => {
    const room = getRoomForSocket(socket);
    assertGameState(room, GameState.PLAYING);

    const player = getPlayer(room, socket.id);
    if (!player.isAlive || !player.isImpostor) {
      throw new GameError('Only living impostors can use vents.', 'VENT_NOT_ALLOWED');
    }

    const action = String(payload.action || '');
    const vent = getVent(payload.ventId);
    if (!vent) {
      throw new GameError('Vent not found.', 'INVALID_VENT');
    }

    if (action === 'enter') {
      if (player.inVent) {
        throw new GameError('You are already in a vent.', 'ALREADY_IN_VENT');
      }

      if (distance(player.currentX, player.currentY, vent.x, vent.y) > VENT_RADIUS) {
        throw new GameError('Move closer to the vent.', 'OUT_OF_RANGE');
      }

      player.inVent = true;
      player.currentVentId = vent.id;
      player.currentX = vent.x;
      player.currentY = vent.y;
      player.input = { up: false, down: false, left: false, right: false };
    } else if (action === 'travel') {
      if (!player.inVent || !player.currentVentId) {
        throw new GameError('Enter a vent first.', 'NOT_IN_VENT');
      }

      const currentVent = getVent(player.currentVentId);
      if (!currentVent || !currentVent.connections.includes(vent.id)) {
        throw new GameError('Those vents are not connected.', 'VENT_NOT_CONNECTED');
      }

      player.currentVentId = vent.id;
      player.currentX = vent.x;
      player.currentY = vent.y;
    } else if (action === 'exit') {
      if (!player.inVent || player.currentVentId !== vent.id) {
        throw new GameError('You can only exit from your current vent.', 'INVALID_VENT_EXIT');
      }

      player.inVent = false;
      player.currentVentId = null;
      player.currentX = vent.x;
      player.currentY = vent.y;
    } else {
      throw new GameError('Vent action must be enter, travel, or exit.', 'INVALID_VENT_ACTION');
    }

    touchRoom(room);

    return {
      inVent: player.inVent,
      currentVentId: player.currentVentId,
      x: player.currentX,
      y: player.currentY,
    };
  });

  registerAck(socket, 'reportBody', (payload = {}) => {
    const room = getRoomForSocket(socket);
    assertGameState(room, GameState.PLAYING);

    const reporter = getPlayer(room, socket.id);
    if (!reporter.isAlive || reporter.inVent) {
      throw new GameError('You cannot report right now.', 'REPORT_NOT_ALLOWED');
    }

    let body = null;
    if (payload.bodyId) {
      body = room.bodies.find((b) => b.id === payload.bodyId && !b.reported);
    } else {
      body = room.bodies
        .filter((b) => !b.reported)
        .sort(
          (a, b) =>
            distance(reporter.currentX, reporter.currentY, a.x, a.y) -
            distance(reporter.currentX, reporter.currentY, b.x, b.y)
        )[0];
    }

    if (!body) {
      throw new GameError('No reportable body found.', 'BODY_NOT_FOUND');
    }

    if (distance(reporter.currentX, reporter.currentY, body.x, body.y) > REPORT_RADIUS) {
      throw new GameError('Move closer to the body.', 'OUT_OF_RANGE');
    }

    body.reported = true;

    beginMeeting(room, {
      type: 'body',
      reporter: publicPlayer(reporter),
      body: serializeBody(body),
    });

    return { meetingStarted: true };
  });

  registerAck(socket, 'emergencyMeeting', () => {
    const room = getRoomForSocket(socket);
    assertGameState(room, GameState.PLAYING);

    const player = getPlayer(room, socket.id);
    if (!player.isAlive || player.inVent) {
      throw new GameError('You cannot call an emergency meeting right now.', 'MEETING_NOT_ALLOWED');
    }

    if (player.emergencyMeetingsRemaining <= 0) {
      throw new GameError('You have no emergency meetings remaining.', 'NO_EMERGENCY_MEETINGS');
    }

    if (
      distance(
        player.currentX,
        player.currentY,
        MAP.emergencyButton.x,
        MAP.emergencyButton.y
      ) > EMERGENCY_RADIUS
    ) {
      throw new GameError('Move closer to the emergency button.', 'OUT_OF_RANGE');
    }

    player.emergencyMeetingsRemaining -= 1;

    beginMeeting(room, {
      type: 'emergency',
      reporter: publicPlayer(player),
    });

    return {
      meetingStarted: true,
      emergencyMeetingsRemaining: player.emergencyMeetingsRemaining,
    };
  });

  registerAck(socket, 'meetingChat', (payload = {}) => {
    const room = getRoomForSocket(socket);
    assertGameState(room, GameState.MEETING);

    const player = getPlayer(room, socket.id);
    const raw = typeof payload.message === 'string' ? payload.message : '';
    const message = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 200);

    if (!message) {
      throw new GameError('Message cannot be empty.', 'EMPTY_MESSAGE');
    }

    const chat = {
      id: crypto.randomUUID(),
      sender: publicPlayer(player),
      message,
      sentAt: now(),
    };

    io.to(room.roomCode).emit('chatMessage', chat);
    return { messageId: chat.id };
  });

  registerAck(socket, 'castVote', (payload = {}) => {
    const room = getRoomForSocket(socket);
    assertGameState(room, GameState.MEETING);

    const voter = getPlayer(room, socket.id);
    if (!voter.isAlive) {
      throw new GameError('Dead players cannot vote.', 'VOTE_NOT_ALLOWED');
    }

    if (!room.meeting) {
      throw new GameError('No meeting is active.', 'NO_MEETING');
    }

    if (now() < room.meeting.votingStartsAt) {
      throw new GameError('Voting has not started yet.', 'VOTING_NOT_STARTED');
    }

    if (room.meeting.votes.has(voter.socketId)) {
      throw new GameError('You have already voted.', 'ALREADY_VOTED');
    }

    let target = payload.targetSocketId;
    if (target === null || target === undefined || target === '' || target === 'SKIP') {
      target = 'SKIP';
    } else {
      const targetPlayer = room.playerList.find((p) => p.socketId === target && p.isAlive);
      if (!targetPlayer) {
        throw new GameError('Invalid vote target.', 'INVALID_VOTE_TARGET');
      }
    }

    room.meeting.votes.set(voter.socketId, target);
    touchRoom(room);

    const voterCount = aliveVoters(room).length;
    io.to(room.roomCode).emit('voteStatus', {
      votedCount: room.meeting.votes.size,
      voterCount,
    });

    maybeResolveMeetingEarly(room);
    return { voted: true };
  });

  registerAck(socket, 'returnToLobby', () => {
    const room = getRoomForSocket(socket);
    assertHost(room, socket.id);
    assertGameState(room, GameState.GAME_OVER);

    resetRoomToLobby(room);
    io.to(room.roomCode).emit('returnedToLobby', publicRoomState(room));
    io.to(room.roomCode).emit('roomUpdated', publicRoomState(room));
    return { room: publicRoomState(room) };
  });

  registerAck(socket, 'leaveRoom', () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return { left: true };

    socket.leave(roomCode);
    removeSocketFromCurrentRoom(socket, 'left');
    return { left: true };
  });

  socket.on('disconnect', (reason) => {
    removeSocketFromCurrentRoom(socket, reason || 'disconnected');
  });
});

// Authoritative simulation + snapshots.
const tickMs = 1000 / TICK_RATE;
let previousTick = now();

setInterval(() => {
  const currentTick = now();
  const deltaSeconds = Math.min(0.1, (currentTick - previousTick) / 1000);
  previousTick = currentTick;

  for (const room of rooms.values()) {
    if (room.gameState !== GameState.PLAYING) continue;

    for (const player of room.playerList) {
      movePlayer(player, deltaSeconds);
    }

    const common = {
      serverTime: currentTick,
      gameState: room.gameState,
      taskProgress: getTaskProgress(room),
      bodies: room.bodies.filter((body) => !body.reported).map(serializeBody),
    };

    // Send a per-recipient snapshot so vented players can be omitted from peers.
    for (const recipient of room.playerList) {
      const players = room.playerList
        .filter((player) => {
          if (!player.isAlive) return false;
          if (player.socketId === recipient.socketId) return true;
          return !player.inVent;
        })
        .map((player) => ({
          ...publicPlayer(player),
          x: Math.round(player.currentX * 10) / 10,
          y: Math.round(player.currentY * 10) / 10,
        }));

      io.to(recipient.socketId).emit('worldSnapshot', {
        ...common,
        players,
      });
    }
  }
}, tickMs);

// Cleanup abandoned long-lived rooms.
setInterval(() => {
  const cutoff = now() - 2 * 60 * 60 * 1000; // 2 hours

  for (const [roomCode, room] of rooms.entries()) {
    if (room.playerList.length === 0 || (room.updatedAt < cutoff && room.gameState !== GameState.PLAYING)) {
      clearMeetingTimer(room);
      rooms.delete(roomCode);
    }
  }
}, 60_000).unref();

httpServer.listen(PORT, () => {
  console.log(`Game server listening on http://localhost:${PORT}`);
  console.log(`Simulation tick rate: ${TICK_RATE} Hz`);
});
