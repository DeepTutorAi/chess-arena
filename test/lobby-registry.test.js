import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

let registrySequence = 0;
let registryName = 'registry-0';

beforeEach(() => {
  registrySequence += 1;
  registryName = `registry-${registrySequence}`;
});

function projection(roomId, overrides = {}) {
  return {
    roomId,
    title: `Room ${roomId.slice(0, 4)}`,
    status: 'waiting',
    host: { name: 'Host', avatar: 'knight' },
    guest: null,
    openColor: 'b',
    timeControlId: 'blitz_5_0',
    createdAt: 1_000,
    updatedAt: 1_000,
    spectatorCount: 0,
    allowSpectators: true,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

async function registryRequest(path, method = 'GET', body) {
  const stub = env.LOBBY.get(env.LOBBY.idFromName(registryName));
  return stub.fetch(`http://lobby${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  });
}

describe('LobbyRegistry', () => {
  it('lists bounded public projections without private authority data', async () => {
    const rooms = [
      projection('aaaaaaaaaaaaaaaa', { title: 'Friday Blitz', updatedAt: 3_000 }),
      projection('bbbbbbbbbbbbbbbb', {
        title: 'Watch Masters',
        status: 'active',
        guest: { name: 'Guest', avatar: 'rook' },
        openColor: null,
        spectatorCount: 3,
        updatedAt: 2_000,
      }),
      projection('cccccccccccccccc', { title: 'Rapid Garden', timeControlId: 'rapid_10_0' }),
    ];
    for (const room of rooms) {
      const response = await registryRequest('/upsert', 'POST', room);
      expect(response.status).toBe(204);
    }

    const response = await registryRequest('/list?status=all&time=all&search=');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rooms).toHaveLength(3);
    expect(body.rooms[0].roomId).toBe('aaaaaaaaaaaaaaaa');
    expect(body.rooms[1]).toMatchObject({ status: 'active', spectatorCount: 3 });
    expect(JSON.stringify(body)).not.toMatch(/token|digest|initialFen|fen|moves/i);
    expect(body.serverTime).toEqual(expect.any(Number));
  });

  it('filters open, watchable, time, and search results', async () => {
    await registryRequest('/upsert', 'POST', projection('dddddddddddddddd', {
      title: 'Quiet Rapid', host: { name: 'Alice', avatar: 'bishop' }, timeControlId: 'rapid_10_0', updatedAt: 6_000,
    }));
    await registryRequest('/upsert', 'POST', projection('eeeeeeeeeeeeeeee', {
      title: 'Live Blitz', status: 'active', guest: { name: 'Bob', avatar: 'rook' }, openColor: null, updatedAt: 5_000,
    }));
    await registryRequest('/upsert', 'POST', projection('ffffffffffffffff', {
      title: 'No Audience', status: 'active', guest: { name: 'Cara', avatar: 'shield' }, openColor: null, allowSpectators: false, updatedAt: 4_000,
    }));

    expect((await (await registryRequest('/list?status=open&time=rapid&search=alice')).json()).rooms)
      .toEqual([expect.objectContaining({ roomId: 'dddddddddddddddd' })]);
    expect((await (await registryRequest('/list?status=watch&time=all&search=')).json()).rooms)
      .toEqual([expect.objectContaining({ roomId: 'eeeeeeeeeeeeeeee' })]);
  });

  it('paginates deterministically, removes records, and omits expired records', async () => {
    for (let index = 0; index < 26; index += 1) {
      const roomId = String.fromCharCode(97 + index).repeat(16);
      await registryRequest('/upsert', 'POST', projection(roomId, { updatedAt: 10_000 - index }));
    }
    await registryRequest('/upsert', 'POST', projection('expiredexpiredxx', { expiresAt: Date.now() - 1, updatedAt: 20_000 }));

    const first = await (await registryRequest('/list?status=all&time=all&search=')).json();
    expect(first.rooms).toHaveLength(24);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.rooms.some((room) => room.roomId === 'expiredexpiredxx')).toBe(false);

    const second = await (await registryRequest(`/list?status=all&time=all&search=&cursor=${first.nextCursor}`)).json();
    expect(second.rooms).toHaveLength(2);
    expect(new Set([...first.rooms, ...second.rooms].map((room) => room.roomId)).size).toBe(26);

    const removedId = second.rooms[0].roomId;
    expect((await registryRequest('/remove', 'POST', { roomId: removedId })).status).toBe(204);
    const after = await (await registryRequest('/list?status=all&time=all&search=')).json();
    expect(after.rooms.some((room) => room.roomId === removedId)).toBe(false);
  });

  it('rejects malformed projections and cursors', async () => {
    expect((await registryRequest('/upsert', 'POST', { roomId: 'bad' })).status).toBe(400);
    expect((await registryRequest('/list?status=all&time=all&search=&cursor=broken')).status).toBe(400);
  });
});
