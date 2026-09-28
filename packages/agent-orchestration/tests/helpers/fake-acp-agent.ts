import { PassThrough, Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
  type AgentCapabilities,
  type AuthMethod,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type StopReason,
} from '@agentclientprotocol/sdk';
import type { AcpProcessHandle } from '../../src/infrastructure/acp-connector';

export interface FakeAgentConfig {
  /** initialize throws with this message. */
  initializeError?: string;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  /** newSession refuses with the ACP auth_required error. */
  authRequired?: boolean;
  newSessionError?: string;
  stopReason?: StopReason;
  /** prompt never resolves until cancel arrives. */
  hangPrompt?: boolean;
  /** prompt asks the client for permission before finishing. */
  requestPermission?: boolean;
}

export class FakeAcpAgent {
  readonly initializeRequests: unknown[] = [];
  readonly newSessionRequests: NewSessionRequest[] = [];
  readonly prompts: PromptRequest[] = [];
  readonly cancels: unknown[] = [];
  readonly permissionResponses: unknown[] = [];

  private pendingPrompt: { resolve: (result: PromptResponse) => void } | undefined;

  constructor(
    private readonly config: FakeAgentConfig,
    private readonly connection: AgentSideConnection,
  ) {}

  async initialize(params: { protocolVersion: number }): Promise<{
    protocolVersion: number;
    agentCapabilities?: AgentCapabilities;
    authMethods?: AuthMethod[];
    agentInfo?: { name: string; version: string };
  }> {
    this.initializeRequests.push(params);
    if (this.config.initializeError) throw new Error(this.config.initializeError);
    return {
      protocolVersion: params.protocolVersion,
      ...(this.config.agentCapabilities ? { agentCapabilities: this.config.agentCapabilities } : {}),
      ...(this.config.authMethods ? { authMethods: this.config.authMethods } : {}),
      agentInfo: { name: 'fake-agent', version: '1.2.3' },
    };
  }

  async newSession(params: NewSessionRequest): Promise<{ sessionId: string }> {
    this.newSessionRequests.push(params);
    if (this.config.authRequired) throw RequestError.authRequired();
    if (this.config.newSessionError) throw new Error(this.config.newSessionError);
    return { sessionId: `fake-session-${this.newSessionRequests.length}` };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.prompts.push(params);
    if (this.config.hangPrompt) {
      return new Promise((resolve) => {
        this.pendingPrompt = { resolve };
      });
    }
    if (this.config.requestPermission) {
      const response = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'call-1', title: 'room_speak' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
        ],
      });
      this.permissionResponses.push(response);
    }
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'room_speak',
        kind: 'edit',
        status: 'in_progress',
      },
    });
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: { output: 'ECHO7733' },
      },
    });
    return { stopReason: this.config.stopReason ?? ('end_turn' as const) };
  }

  async authenticate(): Promise<Record<string, never>> {
    return {};
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    this.cancels.push(params);
    this.pendingPrompt?.resolve({ stopReason: 'cancelled' });
    this.pendingPrompt = undefined;
  }
}

/**
 * A fake ACP agent over an in-memory duplex stream, shaped as the process
 * handle the connector would get from the login shell.
 */
export function fakeAcpProcess(config: FakeAgentConfig = {}): {
  handle: AcpProcessHandle;
  agent: () => FakeAcpAgent | undefined;
} {
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  const holder: { agent?: FakeAcpAgent } = {};
  const agentStream = ndJsonStream(
    Writable.toWeb(agentToClient) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(clientToAgent) as unknown as ReadableStream<Uint8Array>,
  );
  new AgentSideConnection((connection) => {
    holder.agent = new FakeAcpAgent(config, connection);
    return holder.agent;
  }, agentStream);
  let killed: (() => void) | undefined;
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    killed = () => {
      clientToAgent.end();
      agentToClient.end();
      resolve({ code: null, signal: 'SIGTERM' });
    };
  });
  return {
    handle: {
      stdin: clientToAgent,
      stdout: agentToClient,
      stderr: undefined,
      exit,
      kill: () => killed?.(),
    },
    agent: () => holder.agent,
  };
}
