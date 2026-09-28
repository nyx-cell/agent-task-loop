// @vitest-environment jsdom
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RoomComposer } from './RoomComposer';
import { TEST_AGENTS } from './testing/test-agents';

/** The two members every composer test seats, with their identity colours. */
const CREW = TEST_AGENTS.filter(agent => agent.id === 'claude' || agent.id === 'codex');
const CODEX = TEST_AGENTS.filter(agent => agent.id === 'codex');

afterEach(cleanup);
type Props = ComponentProps<typeof RoomComposer>;
function Harness(props: Partial<Props> & { onSubmit: () => void }) {
  const [value, setValue] = useState(props.value ?? '');
  return <RoomComposer sending={false} agents={CREW}
    {...props} value={value} onValueChange={setValue} />;
}

/**
 * The editable area is ProseMirror, so the contracts are driven the way a
 * browser drives them: keydown on the contenteditable, clicks on the toolbar
 * and on the listbox. jsdom cannot synthesise typed characters into a
 * contenteditable, so text arrives through the `value` prop (which is how a
 * restored draft arrives in production too) and the mention menu is opened
 * with the toolbar button rather than by typing `@`.
 */
const editorEl = () => screen.getByRole('textbox');
const sendButton = () => screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;

/**
 * The suggestion plugin resolves its item list through a microtask, and the
 * popup is rendered by Tiptap's own React root, so both queues have to drain
 * before the listbox is readable.
 */
const settle = async (run: () => void) => {
  await act(async () => { run(); await Promise.resolve(); });
};

describe('Room composer', () => {
  it('sends once on Enter and keeps Shift+Enter for a newline', () => {
    const send = vi.fn();
    render(<Harness value="一起讨论" onSubmit={send} />);
    fireEvent.keyDown(editorEl(), { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(editorEl(), { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(editorEl(), { key: 'Enter', repeat: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not send or complete a mention while confirming Chinese IME input', async () => {
    const send = vi.fn();
    render(<Harness value="中文" onSubmit={send} />);
    fireEvent.keyDown(editorEl(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(editorEl(), { key: 'Enter', keyCode: 229 });
    expect(send).not.toHaveBeenCalled();

    // Same guard with the mention menu open: the Enter that confirms a
    // candidate must not pick a member either.
    await settle(() => fireEvent.click(screen.getByRole('button', { name: '提及' })));
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(editorEl(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(editorEl(), { key: 'Enter', keyCode: 229 });
    expect(send).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('selects a mention on Enter without sending the message', async () => {
    const send = vi.fn();
    render(<Harness onSubmit={send} />);
    await settle(() => fireEvent.click(screen.getByRole('button', { name: '提及' })));
    // [all, claude, codex] — walk to codex, the way a person would.
    await settle(() => fireEvent.keyDown(editorEl(), { key: 'ArrowDown' }));
    await settle(() => fireEvent.keyDown(editorEl(), { key: 'ArrowDown' }));
    expect(screen.getByRole('option', { selected: true }).textContent).toContain('codex');
    await settle(() => fireEvent.keyDown(editorEl(), { key: 'Enter' }));
    expect(editorEl().textContent).toContain('codex');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('serialises the selected mention back to @codex for the server', async () => {
    const changes: string[] = [];
    render(<RoomComposer value="" sending={false} agents={CREW}
      onValueChange={value => changes.push(value)} onSubmit={vi.fn()} />);
    await settle(() => fireEvent.click(screen.getByRole('button', { name: '提及' })));
    await settle(() => fireEvent.click(screen.getByRole('option', { name: /codex/ })));
    expect(changes.at(-1)).toBe('@codex');
  });

  it('opens the mention menu from the toolbar and only lists active members', async () => {
    render(<Harness onSubmit={vi.fn()} />);
    await settle(() => fireEvent.click(screen.getByRole('button', { name: '提及' })));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.queryByRole('option', { name: /dsh/i })).toBeNull();
  });

  it('blocks an empty send', () => {
    const send = vi.fn();
    render(<Harness onSubmit={send} />);
    fireEvent.keyDown(editorEl(), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);
  });

  it('stays editable while a message is in flight and keeps the draft', () => {
    const send = vi.fn();
    render(<Harness value="保留草稿" sending onSubmit={send} />);
    expect(editorEl().getAttribute('contenteditable')).toBe('true');
    fireEvent.submit(screen.getByRole('button', { name: '发送中' }).closest('form')!);
    expect(send).not.toHaveBeenCalled();
    expect(editorEl().textContent).toContain('保留草稿');
  });

  it('counts characters against the 2000 limit only once there are any', () => {
    const { rerender } = render(<RoomComposer value="" sending={false} agents={CODEX}
      onValueChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByText(/\/ 2000/)).toBeNull();
    rerender(<RoomComposer value="四个字符" sending={false} agents={CODEX}
      onValueChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.getByText('4 / 2000')).toBeTruthy();
  });

  it('counts a mention at its wire length, which is what the server limits', () => {
    render(<RoomComposer value="@codex 先别写代码" sending={false} agents={CREW}
      onValueChange={vi.fn()} onSubmit={vi.fn()} />);
    // The chip is one object on screen and eight characters on the wire; the
    // server rejects a body over 2000 characters, so the counter speaks its
    // language rather than the document's.
    expect(screen.getByText('12 / 2000')).toBeTruthy();
  });

  it('refuses to send a body the server would reject as too long', () => {
    render(<RoomComposer value={'字'.repeat(2001)} sending={false} agents={CODEX}
      onValueChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(sendButton().disabled).toBe(true);
  });

  it('rebuilds a restored draft as a chip, not as loose text', () => {
    render(<RoomComposer value="@codex 先别写代码" sending={false} agents={CREW}
      onValueChange={vi.fn()} onSubmit={vi.fn()} />);
    const chip = editorEl().querySelector('[data-mention]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute('data-id')).toBe('codex');
    // The chip wears the colour stored on that member's row.
    expect(chip?.getAttribute('class')).toContain('text-chart-3');
  });
});
