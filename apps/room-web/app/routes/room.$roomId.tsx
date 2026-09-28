import {
  data,
  useLoaderData,
  useRouteError,
  type ActionFunctionArgs,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from 'react-router';
import { RoomLab } from '../room-lab/presentation/RoomLab';
import { getRoomLabHost } from '../room-lab/composition.server';
import { RoomInputError } from '../room-lab/application/room-service.server';
import { roomActionMessage, roomActionStatus } from '../room-lab/application/room-error';
import type { RoomLabActionResponse } from '../room-lab/read-model';
import { parseRoomAction } from '../room-lab/application/parse-room-action';
// The loader answers 404 for a room that is not in the catalog, which is a
// different question from the action ladder's "this request was invalid".
import { RoomCatalogInvariantError } from '../room-lab/domain/room-catalog';
import { isRoomIdentity } from '../room-lab/domain/room-identity';
import { copy } from '../room-lab/copy';
import { RoomErrorPage, routeErrorMessage } from '../room-lab/presentation/RoomErrorPage';
import {
  LocalRequestError,
  assertLocalRuntime,
  assertSameOriginJson,
  noStoreHeaders,
} from '../room-lab/infrastructure/local-guard.server';

/**
 * Single fetch builds every response's headers from the route's `headers`
 * export; a loader's own init headers only survive as cookies. Re-export
 * no-store here so Room state stays uncached on document and .data alike.
 */
export const headers: HeadersFunction = () => noStoreHeaders;

export async function loader({ params }: LoaderFunctionArgs) {
  try {
    assertLocalRuntime();
    const roomId = params.roomId;
    if (!roomId || !isRoomIdentity(roomId)) {
      throw new LocalRequestError(404, 'Unknown Room');
    }
    return data(await getRoomLabHost().snapshot(roomId), { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof RoomCatalogInvariantError) {
      throw data({ error: error.message }, { status: 404, headers: noStoreHeaders });
    }
    if (error instanceof LocalRequestError) {
      throw data({ error: error.message }, { status: error.status, headers: noStoreHeaders });
    }
    throw error;
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  try {
    assertLocalRuntime();
    assertSameOriginJson(request);
    const roomId = params.roomId;
    if (!roomId || !isRoomIdentity(roomId)) {
      throw new LocalRequestError(404, 'Unknown Room');
    }
    const host = getRoomLabHost();
    const input = parseRoomAction(await request.json().catch(() => {
      throw new RoomInputError('Room action must be valid JSON');
    }), host.agents);
    if (input.action === 'create') {
      const created = await host.create({
        title: input.title,
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.agentIds === undefined ? {} : { memberIds: input.agentIds }),
        ...(input.wake === undefined ? {} : { wake: input.wake }),
        ...(input.serial === undefined ? {} : { serial: input.serial }),
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      });
      return data<RoomLabActionResponse>({ ok: true, state: created }, { headers: noStoreHeaders });
    }
    const state = await host.act(roomId, input);
    return data<RoomLabActionResponse>({ ok: true, state }, { headers: noStoreHeaders });
  } catch (error) {
    return data<RoomLabActionResponse>(
      { ok: false, error: roomActionMessage(error) },
      { status: roomActionStatus(error), headers: noStoreHeaders },
    );
  }
}

export default function RoomRoute() {
  const initialState = useLoaderData<typeof loader>();
  return <RoomLab key={initialState.roomId} initialState={initialState} />;
}

export function ErrorBoundary() {
  const message = routeErrorMessage(useRouteError(), copy.say.serviceUnavailable);
  return (
    <RoomErrorPage>
      <section className="shadow-card w-[min(480px,100%)] rounded-lg border border-input bg-card p-6" role="alert" aria-labelledby="room-unavailable-title">
        <h1 id="room-unavailable-title" className="m-0 text-2xl font-bold tracking-[-0.02em]">{copy.say.roomUnavailable}</h1>
        <p className="leading-relaxed text-foreground/75 [overflow-wrap:anywhere]">{message}</p>
        <a className="text-primary" href="/room">{copy.action.backToRooms}</a>
      </section>
    </RoomErrorPage>
  );
}
