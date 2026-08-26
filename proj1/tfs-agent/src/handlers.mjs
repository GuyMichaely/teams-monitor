// The RPC surface: primitive name -> handler + metadata. Transport-agnostic.
// The server dispatches incoming calls through here; the laptop client uses the
// same names/descriptions to expose tool definitions to the brain.

import * as tfs from "./tfs.mjs";

// sideEffect:true = mutates TFS (write). These should be gated hardest.
export const PRIMITIVES = {
  search_tickets: {
    sideEffect: false,
    description: "Find work items. args: { state?, assignedToMe?, assignedTo?, types?, top? }",
    handler: tfs.searchTickets,
  },
  list_states: {
    sideEffect: false,
    description: "Valid states for a work item type. args: { type }",
    handler: tfs.listStates,
  },
  read_ticket: {
    sideEffect: false,
    description: "Read a work item's fields + relations. args: { id }",
    handler: tfs.readTicket,
  },
  read_ticket_comments: {
    sideEffect: false,
    description: "Read a work item's comment thread. args: { id }",
    handler: tfs.readTicketComments,
  },
  list_attachments: {
    sideEffect: false,
    description: "List a work item's attachments. args: { id }",
    handler: tfs.listAttachments,
  },
  download_attachment: {
    sideEffect: false,
    description: "Download an attachment. args: { url, name? } -> { name, base64 }",
    handler: tfs.downloadAttachment,
  },
  change_state: {
    sideEffect: true,
    description: "Change a work item's state. args: { id, state }",
    handler: tfs.changeState,
  },
  modify_ticket: {
    sideEffect: true,
    description: "Edit title/description/fields. args: { id, title?, description?, fields? }",
    handler: tfs.modifyTicket,
  },
  comment_ticket: {
    sideEffect: true,
    description: "Add a comment. args: { id, text }",
    handler: tfs.commentTicket,
  },
  add_attachment: {
    sideEffect: true,
    description: "Upload + link a file. args: { id, fileName, base64, comment? }",
    handler: tfs.addAttachment,
  },
  assign_ticket: {
    sideEffect: true,
    description: "Reassign a work item. args: { id, assignee }",
    handler: tfs.assignTicket,
  },
  link_tickets: {
    sideEffect: true,
    description: "Link two work items. args: { id, targetId, rel? }",
    handler: tfs.linkTickets,
  },
  run_agent_task: {
    sideEffect: true,
    description:
      "ESCAPE HATCH: hand an open-ended task to Claude Code on the VM (browser etc.) " +
      "for things the fixed primitives don't cover. args: { prompt }",
    handler: async () => {
      throw new Error("run_agent_task not implemented — Claude Code bridge on the VM is a TODO.");
    },
  },
};

/**
 * Dispatch a call by name. `allowWrites` lets the server refuse mutations globally
 * (e.g. a read-only deployment). Returns the handler result.
 */
export async function dispatch(cfg, name, args = {}, { allowWrites = true } = {}) {
  const prim = PRIMITIVES[name];
  if (!prim) throw new Error(`Unknown primitive: ${name}`);
  if (prim.sideEffect && !allowWrites) {
    throw new Error(`Primitive "${name}" is a write and this agent is read-only.`);
  }
  return await prim.handler(cfg, args);
}

/** Contract metadata (no handlers) — safe to share with the client/brain. */
export function contract() {
  return Object.fromEntries(
    Object.entries(PRIMITIVES).map(([name, p]) => [
      name,
      { description: p.description, sideEffect: p.sideEffect },
    ])
  );
}
