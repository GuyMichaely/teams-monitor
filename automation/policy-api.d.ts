export interface TeamsMessage {
  id?: string;
  type?: string;
  author?: string;
  text?: string;
  time?: string;
  chat?: string;
  mentions?: string[];
  reactions?: unknown[];
  reaction?: Reaction | null;
  [key: string]: unknown;
}

export interface Reaction {
  emoji?: string;
  count?: number;
  self?: boolean;
  [key: string]: unknown;
}

export interface AlertPayload {
  chat?: string;
  author?: string;
  text?: string;
  time?: string;
  [key: string]: unknown;
}

export interface ActionResult {
  ok: boolean;
  id?: string;
  state?: string;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export interface ActionHandle extends ActionResult {
  ok: true;
  id: string;
}

export type DelayTime = string | number | { afterMs: number };

export interface AgentPermissions {
  tools?: string[];
  readChats?: string[];
  writeChats?: string[];
  initiateActions?: string[];
  cancelIds?: string[];
  modifyIds?: Record<string, string[]>;
  conversationId?: string;
  timeoutMs?: number;
}

export interface AgentResult extends ActionResult {
  output?: unknown;
}

export interface PolicyContext {
  message?: TeamsMessage;
  latest?: TeamsMessage;
  history: TeamsMessage[];
  chat?: string;
  chatName: string;
  authorName: string;
  isDM: boolean;
  mentionsMe: boolean;
  reaction: Reaction | null;
  mentionNames: string[];
  ignoreAuthors: string[];
  now: string;
  trigger: string;
  contextId?: string;
  messageId?: string;
  userProfile?: string;
  brief?: string;
  coverage?: string;
  notifyAll?: boolean;
  conversationId?: string;
  prompt?: string;
  ceiling?: AgentPermissions;
  outcome?: unknown;
}

export interface PolicyActions {
  alert(value: string | AlertPayload): Promise<ActionResult>;
  sendMessage(chat: string, text: string): Promise<ActionResult>;
  setStatus(presence: string): Promise<ActionResult>;
  delay(action: ActionHandle | string, when: DelayTime): Promise<ActionResult>;
  cancel(action: ActionHandle | string): Promise<ActionResult>;
  modify(action: ActionHandle | string, changes: { text?: string }): Promise<ActionResult>;
  llm(prompt: string, permissions?: AgentPermissions): Promise<AgentResult>;
  wake(prompt: string, options?: { conversationId?: string; dueAt?: string; permissions?: AgentPermissions }): Promise<ActionResult>;
}
