import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const ORIGIN = 'http://localhost:5173';

function jsonRequest(url, method, body, origin = ORIGIN) {
  return new Request(url, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createRoom(overrides = {}) {
  const response = await exports.default.fetch(jsonRequest(
    'http://worker.test/api/rooms',
    'POST',
    {
      playerName: 'Host',
      title: 'Integration room',
      color: 'w',
      timeControlId: 'unlimited',
      ...overrides,
    },
  ));
  return { response, body: await response.json() };
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      cleanup();
      resolve(JSON.parse(event.data));
    };
    const onError = () => {
      cleanup();
      reject(new Error('WebSocket failed'));
    };
    const cleanup = () => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
  });
}

async function connect(roomId, sessionToken) {
  const response = await exports.default.fetch(new Request(
    `http://worker.test/api/rooms/${roomId}/socket`,
    {
      headers: {
        Origin: ORIGIN,
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `chess.v1, session.${sessionToken}`,
      },
    },
  ));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  socket.accept();
  return socket;
}

async function playMove(sender, observer, move, expectedRevision) {
  const senderMessage = nextMessage(sender);
  const observerMessage = nextMessage(observer);
  sender.send(JSON.stringify({ type: 'move', ...move, expectedRevision }));
  const [senderState, observerState] = await Promise.all([senderMessage, observerMessage]);
  expect(senderState.revision).toBe(expectedRevision + 1);
  expect(observerState.revision).toBe(expectedRevision + 1);
  expect(senderState.lastMove).toBe(`${move.from}${move.to}${move.promotion || ''}`);
  expect(observerState.fen).toBe(senderState.fen);
  return senderState;
}

describe('online room Worker', () => {
  it('rejects untrusted origins and malformed HTTP boundaries', async () => {
    const forbidden = await exports.default.fetch(jsonRequest(
      'http://worker.test/api/rooms',
      'POST',
      { playerName: 'Host' },
      'https://attacker.example',
    ));
    expect(forbidden.status).toBe(403);

    const wrongType = await exports.default.fetch(new Request('http://worker.test/api/rooms', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'Content-Type': 'text/plain' },
      body: '{}',
    }));
    expect(wrongType.status).toBe(415);

    const sameOrigin = await exports.default.fetch(jsonRequest(
      'http://worker.test/api/rooms',
      'POST',
      { playerName: 'Same Origin', title: 'Hosted room', color: 'w', timeControlId: 'unlimited' },
      'http://worker.test',
    ));
    expect(sameOrigin.status).toBe(201);
  });

  it('creates a room and allows the invite capability to be claimed once', async () => {
    const created = await createRoom();
    expect(created.response.status).toBe(201);
    expect(created.body.roomId).toMatch(/^[a-z2-7]{16}$/);
    expect(created.body.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.role).toBe('host');
    expect(created.body.color).toBe('w');
    expect(created.body.state.status).toBe('waiting');

    const joined = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${created.body.roomId}/join`,
      'POST',
      { playerName: 'Guest', inviteToken: created.body.inviteToken },
    ));
    const guest = await joined.json();
    expect(joined.status).toBe(200);
    expect(guest.role).toBe('guest');
    expect(guest.color).toBe('b');
    expect(guest.state.status).toBe('active');

    const reused = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${created.body.roomId}/join`,
      'POST',
      { playerName: 'Other', inviteToken: created.body.inviteToken },
    ));
    expect(reused.status).toBe(401);
    expect(await reused.json()).toEqual({ error: 'invite_invalid' });
  });

  it('rejects tampering and persists an authoritative game across reconnect', async () => {
    const created = await createRoom();
    const joinedResponse = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${created.body.roomId}/join`,
      'POST',
      { playerName: 'Guest', inviteToken: created.body.inviteToken },
    ));
    const guest = await joinedResponse.json();

    const badSocket = await exports.default.fetch(new Request(
      `http://worker.test/api/rooms/${created.body.roomId}/socket`,
      { headers: { Origin: ORIGIN, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'chess.v1' } },
    ));
    expect(badSocket.status).toBe(401);

    const hostSocket = await connect(created.body.roomId, created.body.sessionToken);
    const initialPromise = nextMessage(hostSocket);
    const initial = await initialPromise;
    expect(initial.status).toBe('active');
    expect(initial.revision).toBe(1);

    const guestSocket = await connect(created.body.roomId, guest.sessionToken);
    const guestInitial = await nextMessage(guestSocket);
    expect(guestInitial.revision).toBe(1);

    const illegalMessage = nextMessage(hostSocket);
    hostSocket.send(JSON.stringify({ type: 'move', from: 'e2', to: 'e5', expectedRevision: 1 }));
    expect(await illegalMessage).toMatchObject({ type: 'error', code: 'illegal_move', revision: 1 });

    await playMove(hostSocket, guestSocket, { from: 'e2', to: 'e4' }, 1);
    await playMove(guestSocket, hostSocket, { from: 'e7', to: 'e5' }, 2);
    await playMove(hostSocket, guestSocket, { from: 'g1', to: 'f3' }, 3);
    const moved = await playMove(guestSocket, hostSocket, { from: 'b8', to: 'c6' }, 4);

    hostSocket.close(1000, 'reconnect');
    const reconnected = await connect(created.body.roomId, created.body.sessionToken);
    const syncPromise = nextMessage(reconnected);
    const synced = await syncPromise;
    expect(synced.revision).toBe(5);
    expect(synced.fen).toBe(moved.fen);

    guestSocket.close(1000, 'done');
    reconnected.close(1000, 'done');
  });

  it('lists multiple public rooms but never enumerates a private room', async () => {
    const marker = `Lobby QA ${crypto.randomUUID().slice(0, 8)}`;
    const publicRooms = await Promise.all([
      createRoom({ title: `${marker} Blitz`, playerName: 'Alpha', timeControlId: 'blitz_5_0' }),
      createRoom({ title: `${marker} Rapid`, playerName: 'Beta', timeControlId: 'rapid_10_0' }),
      createRoom({ title: `${marker} Open`, playerName: 'Gamma', timeControlId: 'unlimited' }),
    ]);
    const privateRoom = await createRoom({
      title: `${marker} Secret`, playerName: 'Hidden', visibility: 'private',
    });
    expect(privateRoom.body.watchInviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(privateRoom.body.watchInviteToken).not.toBe(privateRoom.body.inviteToken);

    const listed = await exports.default.fetch(new Request(
      `http://worker.test/api/lobby?status=all&time=all&search=${encodeURIComponent(marker)}`,
      { headers: { Origin: ORIGIN } },
    ));
    const body = await listed.json();
    expect(listed.status).toBe(200);
    expect(new Set(body.rooms.map((room) => room.roomId))).toEqual(new Set(publicRooms.map((room) => room.body.roomId)));
    expect(body.rooms.some((room) => room.roomId === privateRoom.body.roomId)).toBe(false);
  });

  it('allows exactly one concurrent direct Join to claim a public seat', async () => {
    const created = await createRoom({ title: `Race ${crypto.randomUUID()}` });
    const attempts = await Promise.all(['Guest One', 'Guest Two'].map((playerName, index) => (
      exports.default.fetch(jsonRequest(
        `http://worker.test/api/rooms/${created.body.roomId}/join-public`,
        'POST',
        { playerName, avatar: index === 0 ? 'rook' : 'bishop' },
      ))
    )));
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
    const bodies = await Promise.all(attempts.map((response) => response.json()));
    expect(bodies.filter((body) => body.role === 'guest')).toHaveLength(1);
    expect(bodies.filter((body) => body.error === 'room_full')).toHaveLength(1);
    expect(bodies.find((body) => body.role === 'guest').state.revision).toBe(1);
  });

  it('gives spectators live presence while rejecting every game mutation', async () => {
    const created = await createRoom({ title: `Spectator ${crypto.randomUUID()}`, color: 'w' });
    const joinedResponse = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${created.body.roomId}/join-public`,
      'POST',
      { playerName: 'Guest', avatar: 'rook' },
    ));
    const guest = await joinedResponse.json();
    const hostSocket = await connect(created.body.roomId, created.body.sessionToken);
    await nextMessage(hostSocket);
    const guestSocket = await connect(created.body.roomId, guest.sessionToken);
    await nextMessage(guestSocket);

    const watchers = [];
    for (const [playerName, avatar] of [['Viewer One', 'bishop'], ['Viewer Two', 'shield']]) {
      const watched = await exports.default.fetch(jsonRequest(
        `http://worker.test/api/rooms/${created.body.roomId}/watch`,
        'POST',
        { playerName, avatar },
      ));
      expect(watched.status).toBe(200);
      watchers.push(await watched.json());
    }
    const spectatorOne = await connect(created.body.roomId, watchers[0].sessionToken);
    const firstPresence = await nextMessage(spectatorOne);
    expect(firstPresence.spectatorCount).toBe(1);
    const spectatorTwo = await connect(created.body.roomId, watchers[1].sessionToken);
    const secondPresence = await nextMessage(spectatorTwo);
    expect(secondPresence.spectatorCount).toBe(2);
    expect(secondPresence.spectators.map((profile) => profile.name)).toEqual(['Viewer One', 'Viewer Two']);

    const illegalMove = nextMessage(spectatorTwo);
    spectatorTwo.send(JSON.stringify({ type: 'move', from: 'e2', to: 'e4', expectedRevision: 1 }));
    expect(await illegalMove).toMatchObject({ type: 'error', code: 'unauthorized_role', revision: 1 });
    const illegalResign = nextMessage(spectatorTwo);
    spectatorTwo.send(JSON.stringify({ type: 'resign', expectedRevision: 1 }));
    expect(await illegalResign).toMatchObject({ type: 'error', code: 'unauthorized_role', revision: 1 });

    spectatorTwo.close(1000, 'reconnect');
    const replacement = await connect(created.body.roomId, watchers[1].sessionToken);
    const reconnected = await nextMessage(replacement);
    expect(reconnected.revision).toBe(1);
    expect(reconnected.fen).toBe(created.body.state.fen);
    expect(reconnected.spectators.filter((profile) => profile.name === 'Viewer Two')).toHaveLength(1);

    hostSocket.close(1000, 'done');
    guestSocket.close(1000, 'done');
    spectatorOne.close(1000, 'done');
    replacement.close(1000, 'done');
  });

  it('keeps private player and watch capabilities separate and honors spectator settings', async () => {
    const privateRoom = await createRoom({ visibility: 'private', title: `Private ${crypto.randomUUID()}` });
    const playerAsWatcher = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${privateRoom.body.roomId}/watch`,
      'POST',
      { playerName: 'Wrong capability', avatar: 'king', watchInviteToken: privateRoom.body.inviteToken },
    ));
    expect(playerAsWatcher.status).toBe(401);

    const watcher = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${privateRoom.body.roomId}/watch`,
      'POST',
      { playerName: 'Invited Viewer', avatar: 'king', watchInviteToken: privateRoom.body.watchInviteToken },
    ));
    expect(watcher.status).toBe(200);
    expect((await watcher.json()).role).toBe('spectator');

    const watchCapabilityAsPlayer = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${privateRoom.body.roomId}/join`,
      'POST',
      { playerName: 'Wrong seat', inviteToken: privateRoom.body.watchInviteToken },
    ));
    expect(watchCapabilityAsPlayer.status).toBe(401);

    const noAudience = await createRoom({ allowSpectators: false, title: `No Watch ${crypto.randomUUID()}` });
    const blocked = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${noAudience.body.roomId}/watch`,
      'POST',
      { playerName: 'Viewer', avatar: 'pawns' },
    ));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'spectators_disabled' });
  });

  it('caps connected spectator presence at fifty profiles', async () => {
    const created = await createRoom({ title: `Capacity ${crypto.randomUUID()}` });
    const sockets = [];
    for (let index = 0; index < 50; index += 1) {
      const watched = await exports.default.fetch(jsonRequest(
        `http://worker.test/api/rooms/${created.body.roomId}/watch`,
        'POST',
        { playerName: `Viewer ${index + 1}`, avatar: 'pawns' },
      ));
      expect(watched.status, `spectator ${index + 1} should be admitted`).toBe(200);
      const session = await watched.json();
      const socket = await connect(created.body.roomId, session.sessionToken);
      const state = await nextMessage(socket);
      expect(state.spectatorCount).toBe(index + 1);
      sockets.push(socket);
    }

    const overflow = await exports.default.fetch(jsonRequest(
      `http://worker.test/api/rooms/${created.body.roomId}/watch`,
      'POST',
      { playerName: 'Viewer 51', avatar: 'pawns' },
    ));
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toEqual({ error: 'spectator_limit' });
    for (const socket of sockets) socket.close(1000, 'done');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }, 15_000);
});
