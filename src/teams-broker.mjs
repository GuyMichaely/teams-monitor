import { teamsQueue } from './teams-queue.mjs';
import { getUnreadChats, readChat } from './monitor.mjs';
import { sendScheduledMessage } from './scheduled-teams.mjs';
import { loadConfig } from './context.mjs';
import { isReplyAllowed } from './reply-policy.mjs';
import { scheduleError } from './scheduled-actions.mjs';

export function teamsOperation(body, io = { unread: getUnreadChats, read: readChat, send: sendScheduledMessage, config: loadConfig }) {
  return teamsQueue.run(async () => {
    const cfg = await io.config();
    if (process.env.TEAMS_MONITOR_DEV === '1' && cfg.port !== 29222) throw scheduleError('destination');
    if (body.operation === 'unread') return io.unread(cfg.port);
    if (typeof body.chat !== 'string' || !body.chat.trim() || body.chat.length > 300) throw scheduleError('destination');
    if (body.operation === 'read') return io.read(body.chat, 15, cfg.port);
    if (body.operation !== 'send' || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 8000 || !Number.isSafeInteger(body.expiresAt) || body.expiresAt > Date.now() + 300000) throw scheduleError('destination');
    const guard = async () => {
      if (Date.now() > body.expiresAt) throw scheduleError('expired');
      if (!isReplyAllowed(await io.config(), body.chat)) throw scheduleError('blocked');
    };
    await guard();
    return { result: await io.send(body.chat, body.text, cfg.port, guard, { expiresAt: body.expiresAt }) };
  });
}
