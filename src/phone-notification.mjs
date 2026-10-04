// Leave room for FCM delivery metadata within its 4096-byte data limit.
export const NOTIFICATION_TITLE_BYTES = 256;
export const NOTIFICATION_BODY_BYTES = 3000;
export class NotificationPayloadError extends Error {
  constructor() {
    super('Notification needs a nonempty title (up to 256 UTF-8 bytes) and body (up to 3000 UTF-8 bytes); JSON-encoded content must fit 3500 bytes.');
    this.code = 'INVALID_ACTION';
  }
}

export function notificationPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['title', 'body'].includes(key)) ||
      typeof value.title !== 'string' || !value.title.trim() ||
      typeof value.body !== 'string' || !value.body.trim() ||
      Buffer.byteLength(value.title, 'utf8') > NOTIFICATION_TITLE_BYTES ||
      Buffer.byteLength(value.body, 'utf8') > NOTIFICATION_BODY_BYTES ||
      Buffer.byteLength(JSON.stringify({ title: value.title, body: value.body }), 'utf8') > 3500) {
    throw new NotificationPayloadError();
  }
  return { title: value.title, body: value.body };
}

export function messageNotification(context) {
  const text = String(context.message?.text ?? '').replace(/\s+/g, ' ').trim();
  return notificationPayload({
    title: `${context.authorName || context.message?.author || 'TM'} · ${context.chatName || 'TM'}`,
    body: text.length > 200 ? text.slice(0, 199) + '…' : text,
  });
}
