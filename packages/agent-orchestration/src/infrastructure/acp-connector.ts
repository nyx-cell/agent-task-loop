import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Client,
  type ContentBlock,
  type McpServer,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { AgentBinding } from '../contracts/agent';
import type {
  AgentConnection,
  AgentConnector,
  AgentProbe,
  PermissionOutcome,
  PermissionRequest,
  SessionUpdate,
  Unsubscribe,
} from '../contracts/connection';

/** JSON-RPC code the ACP spec reserves for "open a session after logging in". */
export const AUTH_REQUIRED_ERROR_CODE = -32000;

/** One started ACP process the connector speaks newline-delimited JSON over. */
export interface AcpProcessHandle {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | undefined;
  exit: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: NodeJS.Signals): void;
}

export type AcpProcessSpawner = (binding: AgentBinding) => AcpProcessHandle;

export interface AcpConnectorOptions {
  /** Login shell the binding's command line runs through. */
  shell?: string;
  initializeTimeoutMs?: number;
  sessionTimeoutMs?: number;
  /** Test seam: start the process yourself instead of through the login shell. */
  spawnProcess?: AcpProcessSpawner;
}

const DEFAULT_INITIALIZE_TIMEOUT_MS = 45_000;
const DEFAULT_SESSION_TIMEOUT_MS = 30_000;
const STDERR_TAIL_BYTES = 8_192;

/**
 * The one connector on the main path (RFC 0015): an ACP process per agent,
 * spawned through the person's login shell so an alias counts, one
 * `initialize` per process, sessions created per (room, agent).
 */
export class AcpConnector implements AgentConnector {
  private readonly shell: string;
  private readonly initializeTimeoutMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly spawnProcess: AcpProcessSpawner;

  constructor(options: AcpConnectorOptions = {}) {
    this.shell = options.shell ?? '/bin/zsh';
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.spawnProcess = options.spawnProcess ?? ((binding) => loginShellProcess(binding, this.shell));
  }

  async connect(binding: AgentBinding): Promise<AgentConnection> {
    const handle = this.spawnProcess(binding);
    try {
      const opened = await this.openClient(handle);
      return new AcpConnection(handle, opened);
    } catch (error) {
      handle.kill();
      throw error;
    }
  }

  async probe(binding: AgentBinding, signal?: AbortSignal): Promise<AgentProbe> {
    signal?.throwIfAborted();
    let handle: AcpProcessHandle;
    try {
      handle = this.spawnProcess(binding);
    } catch (error) {
      return { status: 'missing', error: errorText(error) };
    }
    const tail = tailStream(handle.stderr);
    let opened: OpenedClient | undefined;
    try {
      opened = await this.openClient(handle, signal);
      // A trial session: the probe's one question is whether this binding can
      // open one, which is where agents report that they need a login.
      await withTimeout(
        opened.connection.newSession({ cwd: os.tmpdir(), mcpServers: [] }),
        this.sessionTimeoutMs,
        'session/new',
        signal,
      );
      return {
        status: 'ready',
        capabilities: opened.initialize.agentCapabilities ?? {},
        ...(opened.initialize.agentInfo
          ? {
              agentInfo: {
                name: opened.initialize.agentInfo.name,
                version: opened.initialize.agentInfo.version ?? '',
              },
            }
          : {}),
      };
    } catch (error) {
      if (isAuthRequiredError(error)) {
        return {
          status: 'needs-login',
          // authMethods lists the ways to log in. The S0 probes showed that a
          // logged-in codex or opencode still advertises them, so they are a
          // directory, never evidence of being logged out.
          authMethods: opened?.initialize.authMethods ?? [],
        };
      }
      const detail = [errorText(error), tail()].filter(Boolean).join('\n');
      return { status: 'missing', error: detail };
    } finally {
      handle.kill();
    }
  }

  private async openClient(handle: AcpProcessHandle, signal?: AbortSignal): Promise<OpenedClient> {
    const runtime: ConnectionRuntime = {
      updateHandlers: new Set(),
      permissionHandler: undefined,
    };
    const client: Client = {
      sessionUpdate: (params) => {
        runtime.updateHandlers.forEach((handler) => handler(params.update));
      },
      requestPermission: async (params) => {
        const request: PermissionRequest = {
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options,
        };
        const handler = runtime.permissionHandler;
        if (!handler) return { outcome: { outcome: 'cancelled' } as const };
        return { outcome: await handler(request) };
      },
      readTextFile: async (params) => ({ content: await readFile(params.path, 'utf8') }),
      writeTextFile: async (params) => {
        await writeFile(params.path, params.content, 'utf8');
        return {};
      },
    };
    const stream: Stream = ndJsonStream(
      Writable.toWeb(handle.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(handle.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = new ClientSideConnection(() => client, stream);
    const initialize = await withTimeout(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'rivus-agent-orchestration', version: '0.0.0' },
      }),
      this.initializeTimeoutMs,
      'initialize',
      signal,
    );
    return { connection, initialize, runtime };
  }
}

interface ConnectionRuntime {
  updateHandlers: Set<(update: SessionUpdate) => void>;
  permissionHandler: ((request: PermissionRequest) => Promise<PermissionOutcome>) | undefined;
}

interface OpenedClient {
  connection: ClientSideConnection;
  initialize: Awaited<ReturnType<ClientSideConnection['initialize']>>;
  runtime: ConnectionRuntime;
}

/**
 * The connection half of {@link AcpConnector}: one long-lived process, one
 * `initialize`, sessions created on demand, the two inbound ACP streams
 * fanned out to subscribers.
 */
class AcpConnection implements AgentConnection {
  constructor(
    private readonly handle: AcpProcessHandle,
    private readonly opened: OpenedClient,
  ) {
    void this.handle.exit.catch(() => undefined);
  }

  async newSession(input: { cwd: string; mcpServers?: McpServer[]; meta?: Record<string, unknown> }): Promise<string> {
    const response = await this.opened.connection.newSession({
      cwd: input.cwd,
      mcpServers: input.mcpServers ?? [],
      ...(input.meta ? { _meta: input.meta } : {}),
    });
    return response.sessionId;
  }

  async prompt(
    session: string,
    blocks: ContentBlock[],
    signal?: AbortSignal,
  ): Promise<{ stopReason: StopReason }> {
    if (signal?.aborted) {
      await this.cancel(session);
    }
    const abort = () => {
      void this.opened.connection.cancel({ sessionId: session }).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await this.opened.connection.prompt({ sessionId: session, prompt: blocks });
      return { stopReason: result.stopReason };
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async cancel(session: string): Promise<void> {
    await this.opened.connection.cancel({ sessionId: session });
  }

  onUpdate(handler: (update: SessionUpdate) => void): Unsubscribe {
    this.opened.runtime.updateHandlers.add(handler);
    return () => {
      this.opened.runtime.updateHandlers.delete(handler);
    };
  }

  onPermissionRequest(handler: (request: PermissionRequest) => Promise<PermissionOutcome>): Unsubscribe {
    const runtime = this.opened.runtime;
    const previous = runtime.permissionHandler;
    // One turn answers permissions at a time; the newest handler wins.
    runtime.permissionHandler = handler;
    return () => {
      if (runtime.permissionHandler === handler) runtime.permissionHandler = previous;
    };
  }

  async close(): Promise<void> {
    this.handle.kill();
    await this.handle.exit;
  }
}

/** Spawn the binding through the person's login shell so an alias counts. */
export function loginShellProcess(binding: AgentBinding, shell = '/bin/zsh'): AcpProcessHandle {
  const line = [binding.command, ...(binding.args ?? [])].join(' ').trim();
  const child = spawn(shell, ['-lic', line], {
    env: { ...process.env, ...binding.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', reject);
  });
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr,
    exit,
    kill: (signal) => {
      child.kill(signal ?? 'SIGTERM');
    },
  };
}

export function isAuthRequiredError(error: unknown): boolean {
  if (error instanceof RequestError && error.code === AUTH_REQUIRED_ERROR_CODE) return true;
  return /auth[\s_-]?required/i.test(error instanceof Error ? error.message : String(error));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function tailStream(stream: Readable | undefined, maxBytes = STDERR_TAIL_BYTES): () => string {
  if (!stream) return () => '';
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text = `${text}${chunk.toString('utf8')}`.slice(-maxBytes);
  });
  return () => text.trim();
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error(`${label} aborted`));
      },
      { once: true },
    );
  });
  void timeout.catch(() => undefined);
  return Promise.race([promise, timeout]);
}
