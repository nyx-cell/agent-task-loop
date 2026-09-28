import { useEffect, useState } from 'react';
import type { RoomLabAction, RoomLabState } from '../read-model';
import { memberIsRunning } from './agent-status';
import { RoomSidebar } from './RoomSidebar';
import { copy } from '../copy';
import { RoomHeader } from './RoomHeader';
import { RoomComposer } from './RoomComposer';
import { RoomContext } from './RoomContext';
import { RoomTimeline } from './RoomTimeline';
import { formatElapsed } from './format-time';
import { useElapsed } from './use-elapsed';

export function RoomWorkspace({ state, pending, sending, error, value, onValueChange, onAction }: {
  state: RoomLabState; pending: boolean; sending?: boolean; error?: string; value: string;
  onValueChange: (value: string) => void; onAction: (action: RoomLabAction) => void;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const [editingCrew, setEditingCrew] = useState(false);
  const commandLocked = pending && !sending;
  const activeAgents = state.activeAgentIds.flatMap(id => state.agents.filter(agent => agent.id === id));
  // Identity colour for anyone the registry knows, including a member who has
  // since left this room but still speaks in its transcript.
  const colorOf = (agentId: string) => state.agents.find(agent => agent.id === agentId)?.color;
  // Mid-turn members, in seat order: the only members a wait can be about.
  const runningAgents = activeAgents.filter(agent => memberIsRunning(agent.status));
  const elapsedOf = useElapsed(runningAgents.map(agent => agent.id));

  // Switching rooms closes any open panel; the new room starts at rest.
  useEffect(() => { setContextOpen(false); setEditingCrew(false); }, [state.roomId]);

  // A turn can run for minutes; that has to be visible from another window
  // too, so the tab title carries who is running and for how long.
  const nowId = runningAgents[0]?.id;
  const nowSeconds = nowId ? elapsedOf(nowId) : undefined;
  useEffect(() => {
    const wait = nowId
      ? `${nowId}${nowSeconds === undefined ? '' : ` ${formatElapsed(nowSeconds)}`} · `
      : '';
    document.title = `${wait}${state.title}`;
  }, [nowId, nowSeconds, state.title]);

  const submit = () => {
    if (sending || !value.trim()) return;
    onAction({ action: 'message', body: value });
  };
  const openMembers = (edit: boolean) => {
    setEditingCrew(edit);
    setContextOpen(true);
  };

  return (
    <div className="grid h-dvh min-h-[420px] grid-cols-[240px_minmax(0,1fr)_300px] bg-background font-sans text-foreground max-[1180px]:grid-cols-[240px_minmax(0,1fr)] max-[820px]:grid-cols-1 max-[820px]:grid-rows-[auto_minmax(0,1fr)]">
      <a
        className="fixed top-2 left-2 z-50 -translate-y-[160%] rounded-lg border border-input bg-popover px-3 py-2 text-sm text-popover-foreground shadow-card focus:translate-y-0"
        href="#room-command"
      >
        {copy.action.skipToComposer}
      </a>
      <RoomSidebar
        rooms={state.catalog}
        currentRoomId={state.roomId}
        disabled={commandLocked}
        onCreate={title => onAction({ action: 'create', title })}
      />
      <main className="flex min-h-0 min-w-0 flex-col bg-background" aria-labelledby="room-heading">
        <RoomHeader
          title={state.title}
          goal={state.goal}
          memberCount={activeAgents.length}
          settings={state.settings}
          disabled={commandLocked}
          onMembers={() => openMembers(false)}
          onManage={() => openMembers(true)}
          onReset={() => onAction({ action: 'reset' })}
          onSettings={change => onAction(change)}
        />
        {error && (
          <div className="mx-7 mt-3 rounded-sm bg-destructive-soft px-2.5 py-[5px] text-[13px] leading-snug text-destructive-soft-foreground [overflow-wrap:anywhere]" role="alert">
            {error}
          </div>
        )}
        <RoomTimeline
          events={state.events}
          head={state.head}
          agents={activeAgents}
          colorOf={colorOf}
        />
        <RoomComposer
          value={value}
          sending={!!sending}
          agents={activeAgents}
          onValueChange={onValueChange}
          onSubmit={submit}
        />
      </main>
      <RoomContext
        state={state}
        agents={activeAgents}
        elapsedOf={elapsedOf}
        open={contextOpen}
        editing={editingCrew}
        disabled={commandLocked}
        onEditingChange={setEditingCrew}
        onClose={() => setContextOpen(false)}
        onCompose={agentIds => onAction({ action: 'compose', agentIds })}
      />
    </div>
  );
}
