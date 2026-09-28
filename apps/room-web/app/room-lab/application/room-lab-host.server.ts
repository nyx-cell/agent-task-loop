import { randomUUID } from 'node:crypto';
import {
  AgentRuntime,
  LeaseManager,
  nodeClock,
  nodeIdentity,
  nodeLiveness,
  runtimeKey,
  type AgentBinding,
  type AgentProbe,
  type Harness,
} from '@rivus/agent-orchestration';
import { AcpConnector, ToolServer } from '@rivus/agent-orchestration/acp';
import { RoomService, RoomInputError } from './room-service.server';
import { RoomDm } from './room-dm.server';
import type { TurnLog } from './ports';
import { createRoomRecordInput, defaultWorkRoot, nowIso } from '../infrastructure/room-home.server';
import { SqliteRoomStore } from '../infrastructure/sqlite-room-store.server';
import { SqliteAgentRegistry } from '../infrastructure/sqlite-agent-registry.server';
import { SqliteLeaseStore } from '../infrastructure/sqlite-lease-store.server';
import { SqliteTurnLog } from '../infrastructure/sqlite-turn-log.server';
import { INHERITED_AGENT_ROLE } from '../infrastructure/agent-seed.server';
import { RoomCatalog, RoomCatalogInvariantError, type RoomWakeMode } from '../domain/room-catalog';
import { isAgentId, type AgentRegistry, type RoomLabAgentId } from '../domain/agent-registry';
import {
  deriveAgentAvailability,
  type AgentDeskView,
  type RoomAgentProbeItem,
  type RoomCatalogItemView,
  type RoomLabAction,
  type RoomLabState,
  type RoomView,
} from '../read-model';

export interface RoomLabHostBindings {
  /** Test seam: answer a row's probe without starting an ACP process. */
  probe?: (binding: AgentBinding) => Promise<AgentProbe>;
}

/**
 * The endpoint's assembly (RFC 0015): the record comes from `@rivus/agent-room`
 * through the sqlite stream store, the control plane — registry, lease,
 * runtime, tool server — from `@rivus/agent-orchestration`, and everything
 * with a product name (seating, settings, the Room tools, the turn log) lives
 * here. One runtime and one lease manager serve every room; the runtime's
 * single activate handler routes each key back to its own RoomService.
 */
export class RoomLabHost {
  private readonly store: SqliteRoomStore;
  private readonly services = new Map<string, RoomService>();
  private catalog: RoomCatalog;
  private inventoryCache?: RoomAgentProbeItem[];

  /** The one roster the desk, the routes and the views read members from. */
  readonly agents: AgentRegistry;

  private readonly connector: AcpConnector;
  private readonly probeRow: (binding: AgentBinding) => Promise<AgentProbe>;
  private readonly controlRegistry: SqliteAgentRegistry;
  private readonly lease: LeaseManager;
  private readonly runtime: AgentRuntime;
  private readonly toolServer: ToolServer;
  private readonly turnLog: TurnLog;
  /** The room_dm write path; the child rooms it opens are this host's. */
  private readonly dm: RoomDm;

  constructor(
    store: SqliteRoomStore = SqliteRoomStore.open(),
    private readonly bindings: RoomLabHostBindings = {},
  ) {
    this.store = store;
    this.agents = store.agents;
    this.catalog = store.loadCatalog();
    this.connector = new AcpConnector();
    this.probeRow = bindings.probe ?? (binding => this.connector.probe(binding));
    this.controlRegistry = new SqliteAgentRegistry(store.db);
    this.lease = new LeaseManager({
      store: new SqliteLeaseStore(store.db),
      clock: nodeClock,
      identity: nodeIdentity(),
      holderId: randomUUID(),
      liveness: nodeLiveness,
    });
    this.runtime = new AgentRuntime({
      connector: this.connector,
      registry: this.controlRegistry,
      lease: this.lease,
    });
    this.toolServer = new ToolServer();
    this.turnLog = new SqliteTurnLog(store.db);
    this.dm = new RoomDm({
      findPrivate: (parentRoomId, members) => this.catalog.findPrivate(parentRoomId, members),
      openPrivate: input => {
        const record = this.catalog.openPrivate(input);
        this.store.saveRoom(record);
        return record;
      },
      stream: roomId => this.store.stream(roomId),
      dispatch: (roomId, event) => this.open(roomId).dispatch(event),
      now: nowIso,
    });
    this.runtime.onActivate(key => this.activateKey(key));
  }

  /** The runtime's activate handler: one key, one room's member. */
  private activateKey(key: string): Promise<Harness> {
    const marker = ':member:';
    const at = key.lastIndexOf(marker);
    const roomId = key.slice('room:'.length, at);
    const agentId = key.slice(at + marker.length);
    return this.open(roomId).activate(agentId);
  }

  /** Re-reads the `agents` table; the next probe re-runs against the new rows. */
  private reloadAgents(): void {
    this.agents.reload();
    this.inventoryCache = undefined;
  }

  list() {
    return this.catalog.list();
  }

  lastOpened() {
    return this.catalog.lastOpened();
  }

  /**
   * The desk's rows as the last scan left them. The first call probes every
   * row — one ACP process per row, asked `initialize` plus a trial
   * `session/new` — and the answers are cached until 重新扫描.
   */
  async inventory(): Promise<RoomAgentProbeItem[]> {
    if (this.inventoryCache) return this.inventoryCache;
    const agents = this.agents.list();
    const rooms = this.list();
    const items = await Promise.all(agents.map(async agent => {
      const probe = await this.probeRow({ command: agent.command });
      return {
        id: agent.id,
        label: agent.label,
        role: agent.role,
        color: agent.color,
        command: agent.command,
        availability: deriveAgentAvailability({
          probe: probe.status,
          seatedIn: rooms.filter(room => room.memberIds.includes(agent.id)).length,
        }),
      };
    }));
    return this.inventoryCache = items;
  }

  /**
   * What 重新扫描 does: re-read the table, then probe it again. Both halves are
   * needed — a row edited outside this process is as much a change as an
   * adapter that has since been installed or logged into.
   */
  async refreshInventory(): Promise<RoomAgentProbeItem[]> {
    this.reloadAgents();
    return this.inventory();
  }

  /**
   * Writes the desk's add-agent form to a new row and re-reads the table, so
   * the next scan answers for it. The id is the word after `@`, which is why it
   * must match the mention grammar; the role is the endpoint's own column.
   */
  async addAgent(input: { id: string; label: string; role?: string; command: string }): Promise<void> {
    const id = input.id.trim();
    if (!isAgentId(id)) throw new RoomInputError('An agent id must match ^[a-z][a-z0-9-]*$');
    if (this.agents.has(id)) throw new RoomInputError(`Agent ${id} already exists`);
    const label = input.label.trim();
    if (!label) throw new RoomInputError('An agent needs a label');
    const command = input.command.trim();
    if (!command) throw new RoomInputError('An agent needs a command to probe');
    this.store.addAgent({ id, label, role: input.role?.trim() || INHERITED_AGENT_ROLE, command });
    this.reloadAgents();
  }

  /**
   * Writes the prompt onto the member's row and re-reads the table, so the next
   * turn in any open room uses it without restarting the server.
   */
  saveSystemPrompt(agentId: RoomLabAgentId, prompt: string): void {
    this.store.saveSystemPrompt(agentId, prompt);
    // Re-read the rows, but keep the probe: a prompt has nothing to do with
    // whether the adapter starts, and re-probing costs an ACP process.
    this.agents.reload();
  }

  async agentDesk(): Promise<AgentDeskView> {
    const rooms = this.list();
    const lastOpenedId = this.lastOpened()?.id;
    return {
      ...(lastOpenedId === undefined ? {} : { lastOpenedId }),
      agents: (await this.inventory()).map(agent => ({
        ...agent,
        seatedIn: rooms
          .filter(room => room.memberIds.includes(agent.id))
          .map(room => ({ id: room.id, title: room.title })),
        systemPrompt: this.agents.get(agent.id)?.systemPrompt ?? '',
      })),
    };
  }

  async create(input: {
    title: string;
    goal?: string;
    memberIds?: readonly RoomLabAgentId[];
    wake?: RoomWakeMode;
    serial?: boolean;
    cwd?: string;
  }): Promise<RoomLabState> {
    const record = this.catalog.create(createRoomRecordInput(input));
    this.store.saveRoom(record);
    this.store.saveLastOpened(record);
    return this.snapshot(record.id);
  }

  async snapshot(roomId: string): Promise<RoomLabState> {
    if (this.catalog.lastOpened()?.id !== roomId) {
      this.store.saveLastOpened(this.catalog.touch(roomId, nowIso()));
    }
    const service = this.open(roomId);
    return await this.decorate(await service.snapshot(), roomId);
  }

  async act(roomId: string, input: Exclude<RoomLabAction, { action: 'create' }>): Promise<RoomLabState> {
    const service = this.open(roomId);
    switch (input.action) {
      case 'message':
        return await this.decorate(await service.sendMessage(input.body, input.clientMessageId), roomId);
      case 'compose': {
        this.setMembers(roomId, input.agentIds);
        return await this.decorate(await service.snapshot(), roomId);
      }
      case 'settings': {
        this.setSettings(roomId, input);
        return await this.decorate(await service.snapshot(), roomId);
      }
      case 'reset':
        return await this.decorate(await service.reset(), roomId);
      default:
        throw new Error('Unknown Room action');
    }
  }

  private setMembers(roomId: string, agentIds: readonly RoomLabAgentId[]): void {
    const record = this.catalog.replaceMembers(roomId, agentIds, nowIso());
    this.store.saveRoom(record);
  }

  private setSettings(
    roomId: string,
    settings: { wake?: RoomWakeMode; serial?: boolean; cwd?: string },
  ): void {
    const record = this.catalog.replaceSettings(roomId, settings, nowIso());
    this.store.saveRoom(record);
  }

  open(roomId: string): RoomService {
    const existing = this.services.get(roomId);
    if (existing) return existing;
    // A room that is not in the catalog has no service; get throws first.
    this.catalog.get(roomId);
    const service = new RoomService({
      roomId: { tenantId: 'local', conversationId: roomId },
      store: this.store.stream(roomId),
      registry: this.controlRegistry,
      runtime: this.runtime,
      lease: this.lease,
      turnLog: this.turnLog,
      members: () => this.catalog.get(roomId).memberIds,
      agents: () => this.agents.list().map(agent => ({
        id: agent.id,
        label: agent.label,
        role: agent.role,
        color: agent.color,
      })),
      settings: () => {
        const current = this.catalog.get(roomId);
        return { wake: current.wake, serial: current.serial, ...(current.cwd ? { cwd: current.cwd } : {}) };
      },
      roomTitle: () => this.catalog.get(roomId).title,
      workRoot: defaultWorkRoot,
      toolHost: ({ agentId, tools, token }) =>
        this.toolServer.hostTools({ tools, token, transport: this.toolTransport(agentId) }),
      dm: this.dm,
      parentTitle: this.parentTitleOf(roomId),
      ledgerOf: ancestor => this.open(ancestor),
      childRooms: () => this.catalog.list()
        .filter(room => room.parentRoomId === roomId)
        .map(room => room.id),
    });
    this.services.set(roomId, service);
    return service;
  }

  /** What a private room's turn facts call the room it was opened from. */
  private parentTitleOf(roomId: string): (() => string) | undefined {
    const parentId = this.catalog.get(roomId).parentRoomId;
    if (!parentId) return undefined;
    return () => this.catalog.get(parentId).title;
  }

  /**
   * Which transport carries the Room tools into this member's session. An
   * agent without an HTTP MCP channel gets the stdio shim; the capability
   * facts are the agents page's, which lands with S4 on `probe`.
   */
  private toolTransport(_agentId: RoomLabAgentId): 'http' | 'stdio' {
    return 'http';
  }

  async decorate(state: RoomView, roomId: string): Promise<RoomLabState> {
    const record = this.catalog.get(roomId);
    const inventory = new Map((await this.inventory()).map(agent => [agent.id, agent]));
    return {
      ...state,
      roomId,
      title: record.title,
      ...(record.goal === undefined ? {} : { goal: record.goal }),
      settings: {
        wake: record.wake,
        serial: record.serial,
        ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
      },
      catalog: this.catalogView(),
      agents: state.agents.map(agent => {
        const listed = inventory.get(agent.id);
        return {
          ...agent,
          availability: listed?.availability ?? 'missing',
          ...(listed?.command ? { command: listed.command } : {}),
        };
      }),
    };
  }

  /**
   * The sidebar's rooms, private rooms nested under the room they were opened
   * from (RFC 0015). Roots keep their creation order; so do the children.
   */
  catalogView(): RoomCatalogItemView[] {
    const items = new Map<string, RoomCatalogItemView>(this.catalog.list().map(room => {
      const preview = this.store.preview(room.id);
      return [room.id, {
        id: room.id,
        title: room.title,
        updatedAt: preview.lastAt ?? room.updatedAt,
        memberCount: room.memberIds.length,
        ...(preview.lastLine === undefined ? {} : { lastLine: preview.lastLine }),
      }];
    }));
    const roots: RoomCatalogItemView[] = [];
    for (const room of this.catalog.list()) {
      const item = items.get(room.id)!;
      const parent = room.parentRoomId ? items.get(room.parentRoomId) : undefined;
      if (parent) (parent.children ??= []).push(item);
      else roots.push(item);
    }
    return roots;
  }
}

export { RoomCatalogInvariantError };
export { RoomInputError };
