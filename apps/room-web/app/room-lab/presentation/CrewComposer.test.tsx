// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CrewComposer } from './CrewComposer';
import { roomFixture } from './testing/room-fixture';

afterEach(cleanup);
describe('Crew management', () => {
  it('keeps composition and speaking order controllable', () => {
    const onCompose = vi.fn();
    render(<CrewComposer agents={roomFixture().agents} activeAgentIds={['codex', 'claude']}
      disabled={false} onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: '将 Claude 上移' }));
    expect(onCompose).toHaveBeenLastCalledWith(['claude', 'codex']);
    fireEvent.click(screen.getByRole('button', { name: '加入 DSH' }));
    expect(onCompose).toHaveBeenLastCalledWith(['codex', 'claude', 'dsh']);
    fireEvent.click(screen.getByRole('button', { name: '移除 Claude' }));
    expect(onCompose).toHaveBeenLastCalledWith(['codex']);
  });
  it('does not remove the last agent or reorder during a run', () => {
    const onCompose = vi.fn();
    const view = render(<CrewComposer agents={roomFixture().agents} activeAgentIds={['codex']}
      disabled={false} onCompose={onCompose} />);
    expect((screen.getByRole('button', { name: '移除 Codex' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<CrewComposer agents={roomFixture().agents} activeAgentIds={['codex', 'claude']}
      disabled onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: '将 Claude 上移' }));
    expect(onCompose).not.toHaveBeenCalled();
  });
});
