// @vitest-environment jsdom
import { copy } from '../copy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
vi.mock('react-router', () => ({
  Link: ({ to, children, prefetch: _prefetch, preventScrollReset: _reset, ...rest }: {
    to: string; children: React.ReactNode; prefetch?: string; preventScrollReset?: boolean;
  }) => <a href={to} {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/room/r_aaaaaaaaaa' }),
}));
import { RoomWorkspace } from './RoomWorkspace';
import { RoomMessage } from './RoomMessage';
import { roomFixture } from './testing/room-fixture';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Room workspace', () => {
  it('uses Rivus as the product wordmark, not 房间', () => {
    render(<RoomWorkspace state={roomFixture()} pending={false} value=""
      onValueChange={vi.fn()} onAction={vi.fn()} />);
    expect(copy.label.product).not.toBe(copy.label.rooms);
    const brand = screen.getByText(copy.label.product);
    expect(brand.tagName).toBe('STRONG');
  });

  it('does not introduce task controls or the board link this round', () => {
    render(<RoomWorkspace state={roomFixture()} pending={false} value=""
      onValueChange={vi.fn()} onAction={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /任务/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /看板/ })).toBeNull();
    expect(screen.queryByText(/Task/)).toBeNull();
  });

  // The room menu is a Radix DropdownMenu, so 清空对话 is a `menuitem` and the
  // trigger opens on pointerdown, not click. The contract under test is
  // unchanged: the destructive step is still two clicks inside the menu, and
  // 取消 still puts it back.
  const openRoomMenu = () =>
    fireEvent.pointerDown(screen.getByLabelText('房间菜单'), { button: 0, ctrlKey: false });

  it('only clears the conversation after an inline second step', () => {
    const onAction = vi.fn();
    render(<RoomWorkspace state={roomFixture()} pending={false} value=""
      onValueChange={vi.fn()} onAction={onAction} />);
    openRoomMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '清空对话' }));
    expect(onAction).not.toHaveBeenCalledWith({ action: 'reset' });
    // 取消 puts the menu back on its action list, still open.
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('button', { name: '确认清空' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '清空对话' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    expect(onAction).toHaveBeenCalledWith({ action: 'reset' });
  });

  it('edits wake, serial and cwd from the room menu and sends only what changed', () => {
    const onAction = vi.fn();
    render(<RoomWorkspace state={roomFixture()} pending={false} value=""
      onValueChange={vi.fn()} onAction={onAction} />);
    openRoomMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '房间设置' }));
    fireEvent.change(screen.getByLabelText('唤醒'), { target: { value: 'addressed' } });
    fireEvent.click(screen.getByLabelText('逐个运行'));
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/tmp/room-work' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).toHaveBeenCalledWith({
      action: 'settings', wake: 'addressed', serial: true, cwd: '/tmp/room-work',
    });

    // Nothing touched: the form closes without dispatching an action the
    // server would have to refuse as empty.
    onAction.mockClear();
    openRoomMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: '房间设置' }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('shows a member\'s derived state, and a failed turn\'s error, in the members column', () => {
    const state = roomFixture();
    state.agents = state.agents.map(agent => {
      if (agent.id === 'codex') return { ...agent, status: 'working' };
      if (agent.id === 'claude') {
        return { ...agent, status: 'failed', error: 'ACP connection closed' };
      }
      return agent;
    });
    render(<RoomWorkspace state={state} pending={false} value=""
      onValueChange={vi.fn()} onAction={vi.fn()} />);
    const aside = screen.getByRole('complementary', { name: '成员' });
    expect(within(aside).getByText('工作中')).toBeTruthy();
    expect(within(aside).getByText('失败')).toBeTruthy();
    expect(within(aside).getByText('ACP connection closed')).toBeTruthy();
    // The transcript itself stays free of it: the record holds what was said.
    expect(screen.getByRole('region', { name: '房间对话' }).textContent).not.toContain('ACP connection closed');
  });

  it('keeps the composer editable while a member is mid-turn', () => {
    const state = roomFixture();
    state.agents = state.agents.map(agent =>
      agent.id === 'codex' ? { ...agent, status: 'working' } : agent);
    render(<RoomWorkspace state={state} pending={false} value=""
      onValueChange={vi.fn()} onAction={vi.fn()} />);
    // The composer is a Tiptap editor now, so "still editable" reads off
    // contenteditable rather than a textarea's disabled flag.
    expect(screen.getByRole('textbox').getAttribute('contenteditable')).toBe('true');
  });

  it('nests a private room under its parent, titled by its members', () => {
    const state = roomFixture({
      catalog: [{
        id: 'r_aaaaaaaaaa',
        title: '产品讨论',
        updatedAt: '2026-09-06T00:00:00.000Z',
        memberCount: 5,
        children: [{
          id: 'r_bbbbbbbbbb',
          title: 'claude ↔ codex',
          updatedAt: '2026-09-06T01:00:00.000Z',
          memberCount: 2,
        }],
      }],
    });
    render(<RoomWorkspace state={state} pending={false} value=""
      onValueChange={vi.fn()} onAction={vi.fn()} />);
    // The private room is one of the person's rooms: reachable from the row of
    // the room it was opened from.
    const parentItem = screen.getByRole('link', { name: /产品讨论/ }).closest('li');
    expect(parentItem).toBeTruthy();
    const childLink = within(parentItem as HTMLElement).getByRole('link', { name: /claude ↔ codex/ });
    expect(childLink.getAttribute('href')).toBe('/room/r_bbbbbbbbbb');
  });

  it('renders message bodies as text, not executable HTML, and names the person 你', () => {
    const { container } = render(<ol><RoomMessage event={{
      seq: 1, messageId: 'web:1', author: { kind: 'human', id: 'director' }, kind: 'human',
      body: '<img src=x onerror=alert(1)> @codex', addressedTo: ['codex'], at: '2026-09-05T06:32:00Z',
    }} /></ol>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(copy.label.human).toBe('你');
    expect(screen.getByText(copy.label.human)).toBeTruthy();
  });
});
