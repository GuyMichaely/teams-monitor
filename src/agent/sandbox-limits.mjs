import { AgentRuntimeError } from './errors.mjs';

export const SANDBOX_DEFAULTS = Object.freeze({ timeoutMs: 10000, memoryMb: 512, cpuPercent: 10, maxProcesses: 4, outputBytes: 65536 });
const ranges = { timeoutMs: [100, 30000], memoryMb: [256, 2048], cpuPercent: [1, 25], maxProcesses: [1, 8], outputBytes: [4096, 262144] };
export function sandboxLimits(value = {}, ...ceilings) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(ranges, key)))
    throw new AgentRuntimeError('INVALID_CONFIG', 'Invalid sandbox limits.');
  const result = {};
  const defaults = ceilings[0] ? sandboxLimits(ceilings[0]) : SANDBOX_DEFAULTS;
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const number = value[key] ?? defaults[key];
    if (!Number.isInteger(number) || number < min || number > max) throw new AgentRuntimeError('INVALID_CONFIG', `Invalid sandbox ${key}.`);
    result[key] = Math.min(number, ...ceilings.map(c => sandboxLimits(c || {})[key]));
  }
  return result;
}
