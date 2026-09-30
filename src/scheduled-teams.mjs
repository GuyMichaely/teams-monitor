import { setUnreadFilter, openChat, evalOnPage } from './teams.mjs';
import { getTeamsProfileSession } from './teams-presence.mjs';
import { scheduleError } from './scheduled-actions.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Same orchestrator as monitoring, one CDP session, exact recipient and no draft edits.
export async function sendScheduledMessage(chat, text, port, guard, { expiresAt = Infinity } = {}) {
  let session;
  try { session = await getTeamsProfileSession(port); } catch { throw scheduleError('destination'); }
  if (!session) throw scheduleError('destination');
  let restore;
  try {
    const filter = await setUnreadFilter(session, false);
    if (!filter.ok) throw scheduleError('destination');
    restore = filter.wasOn;
    await sleep(500);
    if (!await openChat(session, chat, { exact: true })) throw scheduleError('destination');
    for (let i = 0; i < 20; i++) {
      if (await evalOnPage(session, `(() => {
        const title = document.querySelector('[data-tid="chat-title"]');
        return (title?.innerText || '').replace(/\\s+/g,' ').trim().toLowerCase() === ${JSON.stringify(chat.replace(/\s+/g, ' ').trim().toLowerCase())}
          && !!document.querySelector('[data-tid="ckeditor"]')?.getClientRects().length;
      })()`)) break;
      await sleep(150);
    }
    await guard();
    const result = await evalOnPage(session, `(${sendScheduledFromDocument.toString()})(document, ${JSON.stringify(chat)}, ${JSON.stringify(text)}, ${Number.isFinite(expiresAt) ? expiresAt : 'Infinity'})`);
    if (['destination', 'draft', 'expired'].includes(result)) throw scheduleError(result);
    return result;
  } finally {
    if (restore !== undefined) await setUnreadFilter(session, restore).catch(() => {});
    session.close();
  }
}

// Exported for DOM tests; both recipient checks occur in the same in-page action.
export async function sendScheduledFromDocument(document, chat, text, expiresAt = Infinity) {
  if (Date.now() > expiresAt) return 'expired';
  const normal = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const title = () => normal(document.querySelector('[data-tid="chat-title"]')?.innerText) === normal(chat);
  const boxes = [...document.querySelectorAll('[data-tid="ckeditor"]')].filter(e => e.getClientRects().length);
  if (!title() || boxes.length !== 1) return 'destination';
  const box = boxes[0];
  const footer = box.closest?.('[data-tid="chat-pane-compose-message-footer"]');
  if ((box.innerText || '').trim() || box.querySelector('img,[data-attachment-id]') ||
      footer?.querySelector('[data-attachment-id],[data-tid*="file-preview"],[data-tid*="quoted-message"],[data-tid*="attachment"]:not(button):not(input):not([role="button"])')) return 'draft';
  const button = document.querySelector('[data-tid="sendMessageCommands-send"]');
  if (!button) return 'destination';
  box.focus();
  if (!document.execCommand('insertText', false, text)) return 'not-inserted';
  await new Promise(resolve => setTimeout(resolve, 150));
  if (Date.now() > expiresAt) return 'expired';
  // Never send a changed destination, another draft, or text the editor did not accept.
  if (!title() || document.querySelector('[data-tid="ckeditor"]') !== box ||
      (box.innerText || '').replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) return 'unconfirmed';
  if (button.disabled || button.getAttribute('aria-disabled') === 'true' || !button.isConnected) return 'unconfirmed';
  button.click();
  return 'sent';
}

export async function setScheduledPresence(status, config, expiresAt) {
  const gui = config.gui || {};
  const token = process.env[gui.authTokenEnv || 'GUI_TOKEN'];
  const response = await fetch(`http://127.0.0.1:${gui.port || 8090}/api/teams/presence`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ status, expiresAt }), signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw Error('Scheduled status was not confirmed');
  return response.json();
}
