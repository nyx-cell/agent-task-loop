import { useEffect, useRef, useState } from 'react';
import { ArrowDown } from '@phosphor-icons/react/dist/ssr/ArrowDown';
import type { RoomLabAgentView, RoomLabEventView } from '../read-model';
import { AgentMark } from './AgentMark';
import { RoomMessage, type AgentColorLookup } from './RoomMessage';
import { copy } from '../copy';
import { Button } from '~/components/ui/button';

/**
 * The record itself. Who is mid-turn shows in the members column, derived
 * from the lease and the turn log; the transcript only ever shows what was
 * said.
 */
export function RoomTimeline({ events, head, agents, colorOf }: {
  events: RoomLabEventView[]; head: number; agents: RoomLabAgentView[];
  /** Every member the registry knows, not only the ones seated here. */
  colorOf: AgentColorLookup;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const lastHead = useRef(head);
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    if (atBottom.current) {
      pane.scrollTop = pane.scrollHeight;
      setUnseen(0);
    } else if (head > lastHead.current) {
      setUnseen(count => count + (head - lastHead.current));
    }
    lastHead.current = head;
  }, [head]);

  const jump = () => {
    const pane = scrollRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
    atBottom.current = true;
    setUnseen(0);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <section
        ref={scrollRef}
        // Containing block for anything positioned inside a message; without
        // it their overflow escapes the scroll clip and stretches the page.
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pt-[22px] pb-3"
        aria-label={copy.label.thread}
        onScroll={event => {
          const pane = event.currentTarget;
          atBottom.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100;
          if (atBottom.current) setUnseen(0);
        }}
      >
        <span className="sr-only" role="status" aria-live="polite">{copy.say.received(events.length, head)}</span>
        {events.length === 0 ? (
          <div className="flex min-h-full flex-col justify-end pb-6">
            <div className="mb-3 flex items-center gap-1.5">
              {agents.map(agent => <AgentMark key={agent.id} agentId={agent.id} color={agent.color} size={22} />)}
            </div>
            <h2 className="m-0 mb-1 text-[18px] font-semibold">{copy.say.emptyThreadTitle}</h2>
            <p className="m-0 max-w-[46ch] font-serif text-base leading-[1.7] text-foreground/75">
              {copy.say.emptyThread(agents.length)}
            </p>
          </div>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-[22px] p-0">
            {events.map(event => <RoomMessage key={event.messageId} event={event} colorOf={colorOf} />)}
          </ol>
        )}
      </section>
      {unseen > 0 && (
        <Button
          size="xs"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-3.5 shadow-card"
          onClick={jump}
        >
          <ArrowDown size={13} weight="bold" />
          {copy.label.newMessages(unseen)}
        </Button>
      )}
    </div>
  );
}
