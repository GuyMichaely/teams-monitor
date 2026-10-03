// Loads configuration and the user context fed to the brain.

import { copyFile, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from 'node:crypto';
import { parseConfigYaml, configYaml } from './config-format.mjs';
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { permissionCeiling, permissions } from './agent/permissions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { CONFIG_FILE, PROFILE_FILE as USER_PROFILE_FILE } from "./local-paths.mjs";
const CONFIG_EXAMPLE_FILE = join(ROOT, "config", "config.example.yaml");
const USER_PROFILE_EXAMPLE_FILE = join(ROOT, "context", "user-profile.example.md");

async function ensureLocalFile(path, examplePath, label) {
  if (existsSync(path)) return;
  if (!existsSync(examplePath)) {
    throw new Error(`${label} not found and example file is missing: ${examplePath}`);
  }
  await copyFile(examplePath, path);
}

function validateDesktop(config) {
  if (config.desktop !== undefined && (!config.desktop || typeof config.desktop !== 'object' || Array.isArray(config.desktop)))
    throw new Error('desktop must be a mapping');
  if (config.desktop?.keepAwake !== undefined && typeof config.desktop.keepAwake !== 'boolean')
    throw new Error('desktop.keepAwake must be a boolean');
}

function validateAgent(config) {
  if (config.agent !== undefined && (!config.agent || typeof config.agent !== 'object' || Array.isArray(config.agent))) throw Error('agent must be a mapping');
  const agent = config.agent || {};
  const allowed = ['timeoutMs', 'maxTurns', 'maxMessages', 'policyTimeoutMs', 'ceiling', 'sandbox'];
  if (Object.keys(agent).some(key => !allowed.includes(key))) throw Error('Unknown agent setting');
  if (agent.ceiling !== undefined && (!agent.ceiling || typeof agent.ceiling !== 'object' || Array.isArray(agent.ceiling))) throw Error('agent.ceiling must be a mapping');
  if (Object.keys(agent.ceiling || {}).some(key => !['tools', 'readChats', 'writeChats', 'initiateActions', 'cancelIds', 'modifyIds'].includes(key))) throw Error('Unknown permission ceiling setting');
  for (const [field, min, max] of [['timeoutMs', 1, 30000], ['maxTurns', 1, 10], ['maxMessages', 0, 20], ['policyTimeoutMs', 1000, 300000]])
    if (agent[field] !== undefined && (!Number.isInteger(agent[field]) || agent[field] < min || agent[field] > max)) throw Error(`Invalid agent.${field}`);
  const ceiling = permissionCeiling(config);
  permissions(ceiling, ceiling);
}

export async function loadConfig() {
  await ensureLocalFile(CONFIG_FILE, CONFIG_EXAMPLE_FILE, "config/config.yaml");
  const config = parseConfigYaml(await readFile(CONFIG_FILE, "utf8"));
  validateDesktop(config);
  validateAgent(config);
  return config;
}

// Presence's latest-wins guard runs synchronously immediately before UI effects.
export function currentConfig() {
  const config = parseConfigYaml(readFileSync(CONFIG_FILE, 'utf8'));
  validateDesktop(config); validateAgent(config);
  return config;
}

export async function saveConfig(config) {
  validateDesktop(config);
  validateAgent(config);
  const temporary = CONFIG_FILE + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, configYaml(config));
  await rename(temporary, CONFIG_FILE);
}

/**
 * The freeform user profile (projects, tone, people) fed to the brain as its
 * context about you. The live file is intentionally gitignored so dashboard or
 * local edits survive pulls; a fresh clone starts from user-profile.example.md.
 */
export async function loadUserProfile() {
  await ensureLocalFile(USER_PROFILE_FILE, USER_PROFILE_EXAMPLE_FILE, "context/user-profile.md");
  return await readFile(USER_PROFILE_FILE, "utf8");
}
