// @vitest-environment jsdom
import { copy } from '../copy';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentDesk } from './AgentDesk';

vi.mock('react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => <a href={to} {...rest}>{children}</a>,
  Form: ({ children, ...rest }: { children: React.ReactNode }) => <form {...rest}>{children}</form>,
  useNavigation: () => ({ state: 'idle', formData: undefined }),
}));

afterEach(cleanup);

const CODEX_SEATED = {
  id: 'codex',
  label: 'Codex',
  role: '实施',
  color: 3,
  availability: 'seated' as const,
  command: 'codex-acp',
  systemPrompt: '先给结论。',
  seatedIn: [{ id: 'r_aaaaaaaaaa', title: 'Q3 定价方案' }],
};

it('shows a system-prompt field per selected agent and does not send CLI probes', () => {
  const { container } = render(
    <AgentDesk desk={{
      lastOpenedId: 'r_aaaaaaaaaa',
      agents: [CODEX_SEATED],
    }} />,
  );
  expect(screen.getByText(copy.label.product)).toBeTruthy();
  expect(screen.getByRole('heading', { name: '智能体' })).toBeTruthy();
  expect(screen.getByLabelText('Codex 的系统提示')).toBeTruthy();
  expect((screen.getByLabelText('Codex 的系统提示') as HTMLTextAreaElement).value).toBe('先给结论。');
  expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '发送' })).toBeNull();
  expect(container.querySelector('#agent-instruction')).toBeNull();
  expect(container.querySelector('form input[name="intent"][value="instruct"]')).toBeNull();
  // The role word comes off the agent's row, not a table in the source.
  expect(screen.getByText('实施')).toBeTruthy();
  const row = screen.getByRole('option', { name: /Codex/ });
  expect(row.tagName).not.toBe('BUTTON');
  expect(row.closest('button')).toBeNull();
});

it('maps each probe state to its state word', () => {
  render(
    <AgentDesk desk={{
      agents: [
        { ...CODEX_SEATED },
        { id: 'claude', label: 'Claude', role: '审核', color: 1, availability: 'ready', command: 'claude-agent-acp', systemPrompt: '', seatedIn: [] },
        { id: 'gemini', label: 'Gemini', role: '调研', color: 2, availability: 'needs-login', command: 'gemini-acp', systemPrompt: '', seatedIn: [] },
        { id: 'relay', label: 'Relay', role: '成员', color: 4, availability: 'missing', command: 'relay-acp', systemPrompt: '', seatedIn: [] },
      ],
    }} />,
  );
  // The four words are copy's, keyed by the domain state, never the raw status.
  expect(screen.getByText(copy.availability.seated)).toBeTruthy();
  expect(screen.getByText(copy.availability.ready)).toBeTruthy();
  expect(screen.getByText(copy.availability['needs-login'])).toBeTruthy();
  expect(screen.getByText(copy.availability.missing)).toBeTruthy();
  // The intro counts the rows a seat can take: ready plus seated.
  expect(screen.getByText(copy.say.agentsIntro(4, 2))).toBeTruthy();
});

function field(name: string): HTMLInputElement {
  return screen.getByLabelText(name) as HTMLInputElement;
}

it('rejects an add-agent id that is not ^[a-z][a-z0-9-]*$ without posting', () => {
  const { container } = render(
    <AgentDesk desk={{ agents: [CODEX_SEATED] }} />,
  );
  const form = container.querySelector('form input[name="intent"][value="add-agent"]')!.closest('form')!;
  fireEvent.input(field('ID'), { target: { value: 'Gemini_1' } });
  fireEvent.submit(form);

  // The form came back with the grammar the id must follow, and nothing posted.
  expect(screen.getByRole('alert').textContent).toBe(copy.say.agentIdPattern);
  expect(container.querySelector('form input[name="intent"][value="add-agent"]')).toBeTruthy();
});

it('accepts an add-agent id on the mention grammar and posts the four fields', () => {
  const { container } = render(
    <AgentDesk desk={{ agents: [CODEX_SEATED] }} />,
  );
  const form = container.querySelector('form input[name="intent"][value="add-agent"]')!.closest('form')!;
  fireEvent.input(field('ID'), { target: { value: 'gemini' } });
  fireEvent.input(field('名称'), { target: { value: 'Gemini' } });
  fireEvent.input(field('命令'), { target: { value: 'gemini-acp' } });
  fireEvent.input(field('角色'), { target: { value: '调研' } });
  fireEvent.submit(form);

  expect(screen.queryByRole('alert')).toBeNull();
  const posted = new FormData(form);
  expect(posted.get('intent')).toBe('add-agent');
  expect(posted.get('id')).toBe('gemini');
  expect(posted.get('label')).toBe('Gemini');
  expect(posted.get('command')).toBe('gemini-acp');
  expect(posted.get('role')).toBe('调研');
});
