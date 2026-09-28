import { useEffect, useRef, useState } from 'react';
import { useFetcher, useNavigate, useRevalidator } from 'react-router';
import { RoomLabStateSelector } from '../read-model';
import type { RoomLabAction, RoomLabActionResponse, RoomLabEventView, RoomLabState } from '../read-model';
import { RoomWorkspace } from './RoomWorkspace';

export function RoomLab({ initialState }: { initialState: RoomLabState }) {
  const fetcher = useFetcher<RoomLabActionResponse>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [state, setState] = useState(initialState);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [optimistic, setOptimistic] = useState<RoomLabEventView[]>([]);
  const submittedAction = useRef<RoomLabAction | undefined>(undefined);
  const handledResponse = useRef<RoomLabActionResponse | undefined>(undefined);
  const stateSelector = useRef(new RoomLabStateSelector());

  useEffect(() => {
    setState(current => stateSelector.current.takeLoader(current, initialState));
  }, [initialState]);

  useEffect(() => {
    const data = fetcher.data;
    if (!data || data === handledResponse.current) return;
    handledResponse.current = data;
    if (!data.ok) {
      setError(data.error);
      if (submittedAction.current?.action === 'message') {
        const failed = submittedAction.current;
        setValue(current => current || failed.body);
        if (failed.clientMessageId) {
          const failedId = failed.clientMessageId;
          setOptimistic(events => events.map(event => event.messageId === failedId ? { ...event, failed: true } : event));
        }
      }
      submittedAction.current = undefined;
      return;
    }
    if (submittedAction.current?.action === 'create') {
      navigate(`/room/${data.state.roomId}`);
      submittedAction.current = undefined;
      return;
    }
    if (data.state.epoch !== state.epoch) revalidator.revalidate();
    setState(current => stateSelector.current.takeAction(current, data.state));
    if (submittedAction.current?.action === 'message') {
      const acceptedId = submittedAction.current.clientMessageId;
      setOptimistic(events => events.filter(event => event.messageId !== acceptedId));
      setValue('');
    }
    submittedAction.current = undefined;
  }, [fetcher.data, revalidator, state.epoch]);

  const pending = fetcher.state !== 'idle';
  const sending = pending && submittedAction.current?.action === 'message';
  // Members mid-turn show it in their derived status; the poll follows them.
  const live = pending || state.agents.some(agent => agent.status === 'reading' || agent.status === 'working');
  useEffect(() => {
    if (!live) return;
    const poll = window.setInterval(() => {
      if (revalidator.state === 'idle') revalidator.revalidate();
    }, 900);
    return () => window.clearInterval(poll);
  }, [live, revalidator]);

  const runAction = (action: RoomLabAction) => {
    if (action.action === 'message') {
      if (sending) return;
      const clientMessageId = action.clientMessageId ?? crypto.randomUUID();
      const pendingEvent: RoomLabEventView = {
        seq: state.head + 1,
        messageId: clientMessageId,
        author: { kind: 'human', id: 'director' },
        kind: 'human',
        body: action.body,
        addressedTo: [],
        at: new Date().toISOString(),
        pending: true,
      };
      setOptimistic(events => [...events.filter(event => event.messageId !== clientMessageId), pendingEvent]);
      submittedAction.current = { ...action, clientMessageId };
      setError(undefined);
      fetcher.submit({ ...action, clientMessageId }, {
        method: 'POST',
        action: `/room/${state.roomId}`,
        encType: 'application/json',
      });
      setValue('');
      return;
    }
    if (pending) return;
    submittedAction.current = action;
    setError(undefined);
    fetcher.submit(action, { method: 'POST', action: `/room/${state.roomId}`, encType: 'application/json' });
  };

  const visible = {
    ...state,
    events: mergeEvents(state.events, optimistic),
  };

  return <RoomWorkspace state={visible} pending={pending} sending={sending} error={error}
    value={value} onValueChange={setValue} onAction={runAction} />;
}

function mergeEvents(events: RoomLabEventView[], optimistic: RoomLabEventView[]): RoomLabEventView[] {
  const posted = new Set(events.map(event => event.messageId));
  return [...events, ...optimistic.filter(event => !posted.has(event.messageId))];
}
