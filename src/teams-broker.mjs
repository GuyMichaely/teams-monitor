import { teamsQueue } from './teams-queue.mjs';
import { getUnreadChats, readChat, markChatRead } from './monitor.mjs';
import { sendScheduledMessage } from './scheduled-teams.mjs';
import { loadConfig } from './context.mjs';
import { isReplyAllowed } from './reply-policy.mjs';
import { scheduleError } from './scheduled-actions.mjs';
import { ownerActive } from './agent/owner.mjs';
import { assertActionAuthority } from './agent/executor.mjs';
import { agentStore } from './agent/store.mjs';

export function teamsOperation(body, io = { unread: getUnreadChats, read: readChat, markRead: markChatRead, send: sendScheduledMessage, config: loadConfig }) {
  return teamsQueue.run(async () => {
    const cfg = await io.config();
    if (body.operation === 'unread') return io.unread(cfg.port);
    if (typeof body.chat !== 'string' || !body.chat.trim() || body.chat.length > 300) throw scheduleError('destination');
    if (body.operation === 'read') return io.read(body.chat, 15, cfg.port);
    if (body.operation === 'mark_read') {
      if (!Number.isInteger(body.receipt?.count) || body.receipt.count < 1 || body.receipt.count > 15 || !/^[a-f0-9]{64}$/.test(body.receipt.hash || '')) throw scheduleError('destination');
      const guard = async () => { if (!ownerActive(body.owner)) throw scheduleError('stopped'); };
      await guard();
      return io.markRead(body.chat, body.receipt, cfg.port, guard);
    }
    if (body.operation !== 'send' || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000 || !Number.isSafeInteger(body.expiresAt) || body.expiresAt > Date.now() + 300000) throw scheduleError('destination');
    const guard = async () => {
      if (!ownerActive(body.owner)) throw scheduleError('stopped');
      if (Date.now() > body.expiresAt) throw scheduleError('expired');
      const current = await io.config();
      if (!isReplyAllowed(current, body.chat)) throw scheduleError('blocked');
      if (body.action) {
        const store = agentStore();
        try { assertActionAuthority(body.action, current, store); }
        catch { throw scheduleError('blocked'); }
        finally { store.close(); }
      }
    };
    await guard();
    return { result: await io.send(body.chat, body.text, cfg.port, guard, { expiresAt: body.expiresAt }) };
  });
}
