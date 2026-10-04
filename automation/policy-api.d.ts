/** A visible Teams badge snapshot. Counts include your own reaction, if self is true. */
export interface ReactionBadge {
  emoji: string;
  count: number;
  self: boolean;
}

/** A change synthesized from two badge snapshots on a message you authored. */
export interface Reaction {
  key: string;
  emoji: string;
  change: 'added' | 'removed';
  count: number;
  actorKnown: false;
  originalMessageId: string;
  originalAuthor: string;
  originalTime: string | null;
  originalText: string;
  observedAt: string;
  timing: 'Observed between polls; actual reaction time is unavailable';
}

export interface TeamsMessage {
  /** Teams DOM ID; distinct from ctx.messageId, TM's recorded-message ID. */
  id?: string | null;
  author: string;
  text: string;
  time: string | null;
  mentions: string[];
  /** Omitted from automatic context for other authors; explicitly readable with readReactions. */
  reactions?: ReactionBadge[];
  reaction?: Reaction;
}

/** Exact display content; 256/3000 UTF-8 bytes, JSON-encoded total <= 3500 bytes. */
export interface AlertPayload {
  title: string;
  body: string;
}

export interface PolicyError {
  code: string;
  message: string;
}
export interface Failure {
  ok: false;
  error: PolicyError;
  runId?: string;
}
export interface ActionHandle {
  ok: true;
  id: string;
  state: 'pending' | 'cancelled';
  dueAt?: string;
}
export type ActionResult = ActionHandle | Failure;
export type DelayTime = string | number | { afterMs: number };
export type Presence = 'available' | 'busy' | 'dnd' | 'brb' | 'away' | 'offline';
export type ActionKind = 'message' | 'alert' | 'status' | 'wake';
export type ToolName = 'list_conversations' | 'read_conversation' | 'read_reactions' | 'search_conversations'
  | 'send_message' | 'alert' | 'set_status' | 'schedule' | 'cancel_action' | 'modify_action'
  | 'list_notes' | 'read_note' | 'search_notes' | 'write_note';

export interface SandboxLimits {
  timeoutMs?: number;
  memoryMb?: number;
  cpuPercent?: number;
  maxProcesses?: number;
  outputBytes?: number;
}
export interface AgentPermissions {
  tools?: ToolName[];
  readChats?: string[];
  writeChats?: string[];
  initiateActions?: ActionKind[];
  cancelIds?: string[];
  modifyIds?: Record<string, ('text' | 'title' | 'body')[]>;
  sandbox?: SandboxLimits;
}
export interface AgentOptions extends AgentPermissions {
  conversationId?: string;
  timeoutMs?: number;
  maxTurns?: number;
  maxMessages?: number;
}

export interface PlannedActionBase {
  id: string;
  due: number;
  origin: 'policy' | 'agent' | 'user';
  authority?: AgentPermissions;
  cancelled?: boolean;
}
export interface MessageAction extends PlannedActionBase {
  kind: 'message';
  chat: string;
  text: string;
}
export interface AlertAction extends PlannedActionBase {
  kind: 'alert';
  title: string;
  body: string;
  time?: string | null;
  /** Present only on unmodified alertMessage proposals; owned by the runtime. */
  teamsMessage?: { chat: string; author: string; text: string; time: string | null };
}
export interface StatusAction extends PlannedActionBase {
  kind: 'status';
  presence: Presence;
}
export interface WakeAction extends PlannedActionBase {
  kind: 'wake';
  prompt: string;
  ceiling: AgentPermissions;
  conversationId?: string | null;
  conversationEpoch?: number;
}
export type PlannedAction = MessageAction | AlertAction | StatusAction | WakeAction;
export type AgentResult = Failure | {
  ok: true;
  runId: string;
  conversationId: string | null;
  output: string;
  actions: PlannedAction[];
  replay: boolean;
};

export type PolicyTrigger = 'message' | 'wake' | 'intervention' | 'action_result';
export interface BasePolicyContext {
  trigger: PolicyTrigger;
  /** ISO time when this context was assembled. */
  now: string;
  userProfile: string;
  contextId?: string;
}
/** Context for handle(). */
export interface PolicyContext extends BasePolicyContext {
  trigger: 'message';
  messageId: string;
  message: TeamsMessage;
  history: TeamsMessage[];
  chatName: string;
  authorName: string;
  isDM: boolean;
  mentionsMe: boolean;
  reaction: Reaction | null;
  mentionNames: string[];
  brief: string;
}
/** Context for onWake(). */
export interface WakeContext extends BasePolicyContext {
  trigger: 'wake';
  prompt: string;
  ceiling: AgentPermissions;
  conversationId?: string | null;
  conversationEpoch?: number;
  due: number;
  latenessMs: number;
  actionId: string;
}
/** Context for onIntervention(). */
export interface InterventionContext extends BasePolicyContext {
  trigger: 'intervention';
  prompt: string;
  ceiling: AgentPermissions;
  conversationId: string;
  conversationEpoch: number;
  chatName?: string;
}
export interface ActionOutcome {
  id: string;
  action: MessageAction | AlertAction | StatusAction;
  state: 'completed' | 'failed' | 'blocked' | 'missed' | 'uncertain' | 'superseded';
  /** Transport/Teams-specific evidence. Narrow/check it before accessing fields. */
  result: unknown;
}
/** Context for onActionResult(); incoming-message fields are absent. */
export interface ActionResultContext extends BasePolicyContext {
  trigger: 'action_result';
  contextId: string;
  outcome: ActionOutcome;
}
export type AnyPolicyContext = PolicyContext | WakeContext | InterventionContext | ActionResultContext;

export type ReactionsResult = Failure | {
  ok: true;
  messageId: string;
  chat: string;
  reactions: ReactionBadge[];
  observedAt: string;
};
export interface PolicyActions {
  /** Reads the last observed snapshot; messageId is ctx.messageId / a conversation tool's row ID. */
  readReactions(chat: string, messageId: string): Promise<ReactionsResult>;
  alert(value: AlertPayload): Promise<ActionResult>;
  /** Current incoming Teams message: author · chat title, flattened 200-character body. */
  alertMessage(): Promise<ActionResult>;
  sendMessage(chat: string, text: string): Promise<ActionResult>;
  setStatus(presence: Presence): Promise<ActionResult>;
  delay(action: ActionHandle | string, when: DelayTime): Promise<ActionResult>;
  cancel(action: ActionHandle | string): Promise<ActionResult>;
  modify(action: ActionHandle | string, changes: { text: string } | { title?: string; body?: string }): Promise<ActionResult>;
  llm(prompt: string, permissions?: AgentOptions): Promise<AgentResult>;
  wake(prompt: string, options: { conversationId?: string; dueAt: string; permissions: AgentPermissions }): Promise<ActionResult>;
}
