// Browser-only YAML presentation. The wire envelope remains JSON.
export function logYaml(value) {
  if (typeof value === 'string') return value;
  const plain = JSON.parse(JSON.stringify(value ?? null));
  const key = text => /^[A-Za-z_][\w.-]*$/.test(text) ? text : JSON.stringify(text);
  const scalar = item => item === null ? 'null' : JSON.stringify(item);
  const lines = (item, level) => {
    const pad = ' '.repeat(level);
    if (Array.isArray(item)) return item.length ? item.flatMap(child => {
      if (child && typeof child === 'object' && Object.keys(child).length) return [pad + '-', ...lines(child, level + 2)];
      return [pad + '- ' + (Array.isArray(child) ? '[]' : child && typeof child === 'object' ? '{}' : scalar(child))];
    }) : [pad + '[]'];
    if (item && typeof item === 'object') return Object.keys(item).length ? Object.entries(item).flatMap(([name, child]) => {
      const prefix = pad + key(name) + ':';
      if (child && typeof child === 'object' && Object.keys(child).length) return [prefix, ...lines(child, level + 2)];
      return [prefix + ' ' + (Array.isArray(child) ? '[]' : child && typeof child === 'object' ? '{}' : scalar(child))];
    }) : [pad + '{}'];
    return [pad + scalar(item)];
  };
  return lines(plain, 0).join('\n');
}
