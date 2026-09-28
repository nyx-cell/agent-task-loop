import { useEffect, useState } from 'react';
import { X } from '@phosphor-icons/react/dist/ssr/X';
import type { RoomLabAgentId, RoomLabAgentView, RoomLabState } from '../read-model';
import { AgentMark } from './AgentMark';
import { CrewComposer } from './CrewComposer';
import { agentStatusLabels, agentStatusTone, memberIsRunning, toneDot, toneText } from './agent-status';
import { formatElapsed } from './format-time';
import { sectionLabel } from './ui';
import { copy } from '../copy';
import { Button } from '~/components/ui/button';
import { ScrollArea } from '~/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet';

const DRAWER_QUERY = '(max-width: 1180px)';

/**
 * Above 1180 the members column is docked beside the sheet; below it, it is a
 * Sheet. Only one of the two is ever mounted, so there is no second copy of
 * the panel's ids in the document. The server renders the docked column, and
 * the swap happens after hydration, so the markup matches.
 */
function useDrawer() {
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DRAWER_QUERY);
    const sync = () => setDrawer(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return drawer;
}

/**
 * The members column. A member's state is derived — lease, update stream and
 * the turn log — never stored, so this column and the turn log can never
 * disagree about who did what.
 */
export function RoomContext({
  state, agents, elapsedOf, open, editing, disabled,
  onEditingChange, onClose, onCompose,
}: {
  state: RoomLabState; agents: RoomLabAgentView[];
  elapsedOf: (agentId: RoomLabAgentId) => number | undefined;
  open: boolean; editing: boolean; disabled: boolean;
  onEditingChange: (editing: boolean) => void; onClose: () => void;
  onCompose: (agentIds: RoomLabAgentId[]) => void;
}) {
  const drawer = useDrawer();
  const panel = (
    <section className="flex flex-col gap-2" aria-labelledby="members-title">
      <div className="flex h-6 items-center justify-between">
        <h2 id="members-title" className={sectionLabel}>{copy.label.members(agents.length)}</h2>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="xs" onClick={() => onEditingChange(!editing)} aria-label={editing ? copy.action.doneMembers : copy.action.manageMembers}>
            {editing ? copy.action.done : copy.action.edit}
          </Button>
          <Button variant="ghost" size="icon-xs" className="min-[1180px]:hidden" onClick={onClose} aria-label={copy.action.closeMembers}>
            <X size={16} />
          </Button>
        </div>
      </div>
      {editing ? (
        <CrewComposer agents={state.agents} activeAgentIds={state.activeAgentIds} disabled={disabled} onCompose={onCompose} />
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {agents.map(agent => {
            const tone = agentStatusTone[agent.status];
            const running = memberIsRunning(agent.status);
            const seconds = running ? elapsedOf(agent.id) : undefined;
            return (
              <li key={agent.id} className="flex flex-col">
                <div className="flex items-center gap-2.5 rounded-md px-1 py-[7px]">
                  <AgentMark agentId={agent.id} color={agent.color} size={22} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {agent.id}
                    <span className="ml-1.5 text-xs text-muted-foreground">{agent.role}</span>
                  </span>
                  <span className={`flex shrink-0 items-center gap-1.5 text-xs ${toneText[tone]}`}>
                    <i aria-hidden="true" className={`inline-block size-1.5 rounded-full ${toneDot[tone]} ${running ? 'animate-pulse-soft' : ''}`} />
                    {agentStatusLabels[agent.status]}
                    {seconds !== undefined && <span className="tabular-nums font-mono">{formatElapsed(seconds)}</span>}
                  </span>
                </div>
                {agent.error && (
                  <p className="m-0 mb-1.5 ml-9 rounded-lg bg-destructive-soft px-3 py-2.5 text-[13px] leading-normal text-destructive-soft-foreground [overflow-wrap:anywhere]">{agent.error}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  if (drawer) {
    return (
      <Sheet open={open} onOpenChange={next => { if (!next) onClose(); }}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="gap-0 bg-sidebar text-sidebar-foreground"
          aria-label={copy.label.membersPanel}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{copy.label.membersPanel}</SheetTitle>
            <SheetDescription>{copy.say.membersSheet}</SheetDescription>
          </SheetHeader>
          <ScrollArea className="h-full">
            <div className="flex flex-col gap-5 px-4 py-[18px]">{panel}</div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      className="flex min-h-0 min-w-0 flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground"
      aria-label={copy.label.membersPanel}
    >
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-4 py-[18px]">{panel}</div>
      </ScrollArea>
    </aside>
  );
}
