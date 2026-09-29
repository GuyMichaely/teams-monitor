// Bun's built-in YAML keeps application configuration dependency-free.
export function parseConfigYaml(text) {
  const value = Bun.YAML.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('YAML config must be a mapping');
  const active = new Set();
  function check(node) {
    if (typeof node === 'number' && !Number.isFinite(node)) throw new Error('Config numbers must be finite');
    if (!node || typeof node !== 'object') return;
    if (active.has(node)) throw new Error('Cyclic YAML aliases are not supported');
    active.add(node);
    for (const child of Object.values(node)) check(child);
    active.delete(node);
  }
  check(value);
  return value;
}

export function configYaml(value) {
  return Bun.YAML.stringify(value, null, 2).trimEnd() + '\n';
}
