import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { action, loader } from '../../routes/room.$roomId';
import { action as agentsAction } from '../../routes/room.agents';
import { isLocalOrigin } from '../infrastructure/local-guard.server';
import { getRoomLabHost } from '../composition.server';
import { RoomLabHost } from './room-lab-host.server';
import { SqliteRoomStore } from '../infrastructure/sqlite-room-store.server';

/** Every row answers its probe ready, so the tests never start an ACP process. */
const probeReadyBinding = {
  probe: () => Promise.resolve({ status: 'ready' as const, capabilities: {} }),
};

describe('Room action boundary', () => {
  afterEach(() => {
    globalThis.__rivusRoomLabHost = undefined;
    delete process.env.RIVUS_ROOM_HOME;
  });

  it('rejects a cross-origin JSON mutation', async () => {
    const response = asResponse(await action(args(new Request('http://127.0.0.1:3210/room/r_aaaaaaaaaa', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://attacker.example',
      },
      body: JSON.stringify({ action: 'reset' }),
    }))));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'Room actions require a same-origin browser request',
    });
  });

  it('rejects form submissions before parsing the action', async () => {
    const response = asResponse(await action(args(new Request('http://127.0.0.1:3210/room/r_aaaaaaaaaa', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'http://127.0.0.1:3210',
      },
      body: 'action=reset',
    }))));

    expect(response.status).toBe(415);
  });

  it('rejects malformed JSON payloads as a client error', async () => {
    const response = asResponse(await action(args(new Request('http://127.0.0.1:3210/room/r_aaaaaaaaaa', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:3210',
      },
      body: JSON.stringify({ action: 'task', title: 42 }),
    }))));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'Room action payload is invalid',
    });
  });

  it('rejects an empty Room composition at the domain boundary', async () => {
    process.env.RIVUS_ROOM_HOME = mkdtempSync(join(tmpdir(), 'rivus-room-'));
    globalThis.__rivusRoomLabHost = new RoomLabHost(SqliteRoomStore.open(process.env.RIVUS_ROOM_HOME), probeReadyBinding);
    const created = await getRoomLabHost().create({ title: '边界测试' });
    const response = asResponse(await action(args(new Request(`http://127.0.0.1:3210/room/${created.roomId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:3210',
      },
      body: JSON.stringify({ action: 'compose', agentIds: [] }),
    }), created.roomId)));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'A Room needs at least one active agent',
    });
  });

  it('reads the origin as a URL, so a hostname that merely starts with one is not local', () => {
    expect(isLocalOrigin('http://127.0.0.1:3210')).toBe(true);
    expect(isLocalOrigin('http://localhost:3210')).toBe(true);
    // Prefix matching admits these hostnames; the guard must parse the origin.
    expect(isLocalOrigin('http://localhost.attacker.example')).toBe(false);
    expect(isLocalOrigin('http://127.0.0.1.attacker.example')).toBe(false);
    expect(isLocalOrigin('https://127.0.0.1')).toBe(false);
  });

  it('refuses a form post to the agent desk from a host that only looks local', async () => {
    const rejected = agentsAction(args(new Request('http://127.0.0.1:3210/room/agents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'http://localhost.attacker.example',
      },
      body: 'intent=scan',
    })));

    await expect(rejected).rejects.toMatchObject({ init: { status: 403 } });
  });

  it('returns an explicit 403 response when the loader is not local', async () => {
    const previous = process.env.VERCEL;
    process.env.VERCEL = '1';
    try {
      const rejected = loader(loaderArgs(new Request('http://127.0.0.1:3210/room/r_aaaaaaaaaa')));
      await expect(rejected).rejects.toMatchObject({ init: { status: 403 } });
    } finally {
      if (previous === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previous;
    }
  });
});

/**
 * Single fetch has the action return its value plus a response init rather than
 * a Response. Rebuild the response the router would send, so the assertions
 * stay about status codes and bodies.
 */
function asResponse(result: Awaited<ReturnType<typeof action>>): Response {
  return Response.json(result.data, result.init ?? undefined);
}

const ROOM_PATTERN = '/room/:roomId';

function args(request: Request, roomId = 'r_aaaaaaaaaa'): ActionFunctionArgs {
  return { request, url: new URL(request.url), pattern: ROOM_PATTERN, params: { roomId }, context: {} };
}

function loaderArgs(request: Request): LoaderFunctionArgs {
  return {
    request,
    url: new URL(request.url),
    pattern: ROOM_PATTERN,
    params: { roomId: 'r_aaaaaaaaaa' },
    context: {},
  };
}
