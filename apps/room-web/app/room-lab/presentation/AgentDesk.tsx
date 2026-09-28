import { useState } from 'react';
import { Form, Link, useNavigation } from 'react-router';
import { isAgentId, type RoomLabAgentId } from '../domain/agent-registry';
import type { AgentDeskView } from '../read-model';
import { AgentMark, Wordmark } from './AgentMark';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Textarea } from '~/components/ui/textarea';
import { sectionLabel } from './ui';
import { availabilityVariant } from './agent-status';
import { copy } from '../copy';

/** A row the desk can seat: the probe opened a session, seated or not yet. */
const SEATABLE = new Set(['ready', 'seated']);

export function AgentDesk({ desk, error }: { desk: AgentDeskView; error?: string }) {
  const backTo = desk.lastOpenedId ? `/room/${desk.lastOpenedId}` : '/room';
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';
  const preferred = desk.agents.find(agent => SEATABLE.has(agent.availability))?.id
    ?? desk.agents[0]?.id;
  const [selected, setSelected] = useState<RoomLabAgentId | undefined>(preferred);
  const current = desk.agents.find(agent => agent.id === selected) ?? desk.agents[0];
  const seatable = desk.agents.filter(agent => SEATABLE.has(agent.availability)).length;
  return (
    <main className="min-h-dvh bg-background px-4 py-8 font-sans text-foreground">
      <div className="mx-auto w-[min(760px,100%)]">
        <div className="mb-4 flex items-center gap-2 px-1">
          <Wordmark />
        </div>
        <section className="rounded-lg border border-input bg-card">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-7 pt-[22px] pb-3.5">
            <div>
              <h1 className="m-0 text-2xl font-bold leading-tight tracking-[-0.02em]">{copy.label.agents}</h1>
              <p className="mt-1 mb-0 text-sm leading-snug text-foreground/75">
                {copy.say.agentsIntro(desk.agents.length, seatable)}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" asChild>
                <Link to={backTo} className="no-underline">{copy.action.backToRoom}</Link>
              </Button>
              <Form method="post">
                <input type="hidden" name="intent" value="scan" />
                <Button type="submit" variant="outline" disabled={busy}>{copy.action.rescan}</Button>
              </Form>
            </div>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] max-[720px]:grid-cols-1">
            <ul className="m-0 flex list-none flex-col p-0 border-r border-border max-[720px]:border-r-0 max-[720px]:border-b" aria-label={copy.label.localAgents}>
              {desk.agents.map(agent => {
                const active = current?.id === agent.id;
                return (
                  <li key={agent.id} className="border-b border-border last:border-b-0">
                    <div
                      role="option"
                      aria-selected={active}
                      tabIndex={0}
                      className={`flex w-full cursor-pointer items-start gap-3 px-[18px] py-3 text-left transition-colors duration-150 hover:bg-accent ${active ? 'bg-primary/10' : ''}`}
                      onClick={() => setSelected(agent.id)}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelected(agent.id);
                        }
                      }}
                    >
                      <AgentMark agentId={agent.id} color={agent.color} size={36} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm font-medium">{agent.label}</strong>
                          <Badge variant={availabilityVariant[agent.availability]}>{copy.availability[agent.availability]}</Badge>
                        </div>
                        <p className="m-0 mt-0.5 text-xs text-muted-foreground">{agent.role}</p>
                        <p className="m-0 mt-1 font-mono text-xs leading-relaxed text-foreground/75 [overflow-wrap:anywhere]">
                          {agent.command}
                        </p>
                        {agent.seatedIn.length > 0 ? (
                          <p className="m-0 mt-1.5 text-xs text-muted-foreground">
                            {copy.label.roomsIn}
                            {agent.seatedIn.map((room, index) => (
                              <span key={room.id}>
                                {index > 0 ? '、' : ''}
                                <Link className="text-primary" to={`/room/${room.id}`}>{room.title}</Link>
                              </span>
                            ))}
                          </p>
                        ) : (
                          <p className="m-0 mt-1.5 text-xs text-muted-foreground">{copy.say.inNoRoom}</p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {current && (
              <Form method="post" className="flex flex-col gap-2 px-[18px] py-4">
                <input type="hidden" name="intent" value="save-prompt" />
                <input type="hidden" name="agentId" value={current.id} />
                <label className={sectionLabel} htmlFor="agent-system-prompt">
                  {copy.label.systemPrompt(current.label)}
                </label>
                <Textarea
                  key={current.id}
                  id="agent-system-prompt"
                  name="systemPrompt"
                  rows={9}
                  maxLength={4000}
                  disabled={busy}
                  defaultValue={current.systemPrompt}
                  placeholder={copy.say.promptPlaceholder}
                />
                <div className="mt-1 flex items-center justify-between gap-3">
                  <p className="m-0 text-xs text-muted-foreground">{copy.say.promptSaved}</p>
                  <Button type="submit" disabled={busy}>{copy.action.save}</Button>
                </div>
              </Form>
            )}
          </div>
          <AddAgentForm busy={busy} error={error} />
        </section>
      </div>
    </main>
  );
}

/**
 * One row the catalog has never heard of is one more row (RFC 0015): the form
 * writes it, the next scan answers for it. The id is the word after `@`, so the
 * form refuses anything off the mention grammar before the server has to.
 */
function AddAgentForm({ busy, error }: { busy: boolean; error?: string }) {
  const [idRejected, setIdRejected] = useState(false);
  return (
    <Form
      method="post"
      className="flex flex-col gap-3 border-t border-border px-[18px] py-4"
      onSubmit={event => {
        const id = new FormData(event.currentTarget).get('id');
        const wellFormed = typeof id === 'string' && isAgentId(id);
        setIdRejected(!wellFormed);
        if (!wellFormed) event.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value="add-agent" />
      <h2 className={`${sectionLabel} m-0`}>{copy.label.addAgent}</h2>
      <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
        <label className="flex flex-col gap-1.5 text-sm">
          {copy.label.agentId}
          <Input name="id" required maxLength={40} pattern="[a-z][a-z0-9-]*"
            placeholder={copy.label.agentIdPlaceholder} disabled={busy} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          {copy.label.agentLabel}
          <Input name="label" required maxLength={40}
            placeholder={copy.label.agentLabelPlaceholder} disabled={busy} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          {copy.label.agentCommand}
          <Input name="command" required maxLength={400} className="font-mono"
            placeholder={copy.label.agentCommandPlaceholder} disabled={busy} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          {copy.label.agentRole}
          <Input name="role" maxLength={40}
            placeholder={copy.label.agentRolePlaceholder} disabled={busy} />
        </label>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p data-error className="m-0 min-h-4 text-xs text-destructive" role={idRejected || error ? 'alert' : undefined}>
          {idRejected ? copy.say.agentIdPattern : error ?? ''}
        </p>
        <Button type="submit" className="self-end" disabled={busy}>{copy.action.addAgent}</Button>
      </div>
    </Form>
  );
}
