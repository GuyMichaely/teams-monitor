const MAX_KEYS = 32;
const MAX_KEY_BYTES = 64;
const MAX_STRING_BYTES = 512;
const MAX_JSON_BYTES = 4096;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const invalid = () => { throw new TypeError('Policy attributes must be a bounded map of scalar values.'); };

function validateMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS) invalid();
  for (const [key, item] of entries) {
    if (!KEY.test(key) || Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) invalid();
    if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' &&
        !(typeof item === 'number' && Number.isFinite(item))) invalid();
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > MAX_STRING_BYTES) invalid();
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JSON_BYTES) invalid();
  return Object.fromEntries(entries);
}

/** Validate a patch and merge it over the previous invocation snapshot. */
export function mergePolicyAttributes(current, patch) {
  const before = validateMap(current || {});
  const update = validateMap(patch);
  const merged = { ...before, ...update };
  return validateMap(merged);
}
