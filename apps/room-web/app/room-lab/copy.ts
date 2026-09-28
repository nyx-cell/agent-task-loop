/**
 * Every user-visible string on the room surface, grouped by how it is read.
 *
 * - `status`  is scanned: a noun phrase that sits in a list next to a dot and a
 *             number. One of four shapes only: 已X · X中 · 待X · X失败.
 * - `action`  is acted on: a verb phrase on a button or menu item.
 * - `label`   names a place or a thing: section titles, nav, form labels.
 * - `say`     is read for meaning: a full sentence stating a fact and, where
 *             there is one, the next step.
 * - `availability` is a label keyed by a domain state, so the mapping is
 *             exhaustive rather than a lookup that can miss.
 *
 * Every caller imports a key, the server included, so one state can only ever
 * have one word. `copy.test.ts` enforces it.
 */
import type { RoomAgentAvailability } from './read-model';

export const copy = {
  status: {
    present: '在场',
    reading: '阅读中',
    working: '工作中',
    posted: '已发言',
    passed: '未发言',
    timeout: '超时',
    failed: '失败',
  },

  action: {
    send: '发送',
    sending: '发送中',
    mention: '提及',
    members: '成员',
    manageMembers: '管理成员',
    edit: '编辑',
    done: '完成',
    closeMembers: '收起成员面板',
    roomMenu: '房间菜单',
    roomSettings: '房间设置',
    clearChat: '清空对话',
    confirmClear: '确认清空',
    cancel: '取消',
    newRoom: '新建',
    createRoom: '创建房间',
    create: '创建',
    rescan: '重新扫描',
    addAgent: '新增',
    save: '保存',
    backToRoom: '返回房间',
    backToRooms: '返回房间列表',
    doneMembers: '完成成员编辑',
    skipToComposer: '跳到消息输入框',
    moveUp: (name: string) => `将 ${name} 上移`,
    moveDown: (name: string) => `将 ${name} 下移`,
    remove: (name: string) => `移除 ${name}`,
    add: (name: string) => `加入 ${name}`,
  },

  /** A member's row on the desk, keyed by what one probe can answer. */
  availability: {
    missing: '缺失',
    'needs-login': '待登录',
    ready: '可入座',
    seated: '已入座',
  } satisfies Record<RoomAgentAvailability, string>,

  label: {
    product: 'Rivus',
    tagline: '本地工作台',
    rooms: '房间',
    agents: '智能体',
    pages: '页面',
    membersPanel: '成员',
    members: (count: number) => `成员 · ${count}`,
    membersOrder: '成员与发言顺序',
    mentionList: '选择要提及的成员',
    joinable: '可加入',
    thread: '房间对话',
    roomName: '房间名',
    privateRoomTitle: (a: string, b: string) => `${a} ↔ ${b}`,
    goal: '目标',
    optional: '可选',
    human: '你',
    humanMark: '我',
    everyone: '所有在场成员',
    localAgents: '本机智能体',
    addAgent: '新增智能体',
    agentId: 'ID',
    agentIdPlaceholder: '例如：gemini',
    agentLabel: '名称',
    agentLabelPlaceholder: '例如：Gemini',
    agentCommand: '命令',
    agentCommandPlaceholder: '例如：opencode acp',
    agentRole: '角色',
    agentRolePlaceholder: '例如：调研',
    systemPrompt: (name: string) => `${name} 的系统提示`,
    roomsIn: '所在房间：',
    theme: (choice: string) => `主题：${choice}`,
    themeSystem: '跟随系统',
    themeLight: '亮色',
    themeDark: '暗色',
    composer: '向房间发送消息',
    composerPlaceholder: '说点什么',
    roomNamePlaceholder: '房间名，例如：Q3 定价方案',
    goalPlaceholder: '一句话说明目标，之后可以修改',
    roomWake: '唤醒',
    wakeBroadcast: '所有成员',
    wakeAddressed: '被提及的成员',
    roomSerial: '逐个运行',
    roomCwd: '工作目录',
    roomCwdPlaceholder: '留空则使用本房间的默认目录',
    newMessages: (count: number) => `${count} 条新消息`,
    memberCount: (count: number) => `${count} 位成员`,
    charCount: (used: number, limit: number) => `${used} / ${limit}`,
    justNow: '刚刚',
    minutesAgo: (n: number) => `${n} 分钟前`,
    hoursAgo: (n: number) => `${n} 小时前`,
    daysAgo: (n: number) => `${n} 天前`,
  },

  say: {
    composerHint: 'Enter 发送 · Shift+Enter 换行 · 消息会送到每位在场成员',
    sendFailed: '发送失败，内容已保留在输入框',
    noMentionMatch: '没有匹配的成员',
    crewExplain: '成员顺序即发言顺序。打开逐个运行后，成员按此顺序一个接一个地回。',
    everyoneDescription: '发给全部在场成员',
    emptyThreadTitle: '还没有消息',
    emptyThread: (count: number) => `发一条消息，在场的 ${count} 位成员都会收到；输入 @ 可只发给其中一位。`,
    clearConfirm: '清空这间房的全部对话？房间和成员保留。',
    membersSheet: '这间房的成员与各自的状态。',
    received: (count: number, head: number) => `已收到 ${count} 条消息，最新序号 ${head}。`,
    mentioned: (names: string) => `提及：${names}`,
    promptPlaceholder: '这位智能体的系统提示。留空则使用默认调用方式。',
    savedLocally: '数据保存在本机',
    promptSaved: '保存在本机，所有房间共用。',
    createTitle: '新建房间',
    createIntro: '用要做的事命名房间。成员收到消息后各自决定何时回话。',
    agentsLink: '查看并新增本机的 agent，为每位设置系统提示。',
    agentsIntro: (total: number, seatable: number) => `本机 ${total} 位智能体，${seatable} 位可入座。系统提示会在房间调用时随请求带上。`,
    agentIdPattern: 'ID 需以小写字母开头，只能含小写字母、数字和连字符。',
    inNoRoom: '未加入任何房间',
    roomUnavailable: '无法打开这间房',
    serviceUnavailable: '房间服务不可用',
    agentsUnavailable: '智能体页面不可用',
    metaDescription: '在本机开一间房，让几位本地 agent 在同一条对话里协作。',
    /** Posted into the room by the dispatcher itself, so it lives here too. */
    roundBudgetReached: '本轮已达调用上限',
  },
} as const;

export type StatusKey = keyof typeof copy.status;
