// Loads configuration and the user context fed to the brain.

import { copyFile, readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from 'node:crypto';
import { parseConfigYaml, configYaml } from './config-format.mjs';
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAutomation } from "./deterministic-rules.mjs";

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

export async function loadConfig() {
  await ensureLocalFile(CONFIG_FILE, CONFIG_EXAMPLE_FILE, "config/config.yaml");
  const config = parseConfigYaml(await readFile(CONFIG_FILE, "utf8"));
  validateAutomation(config.automation);
  return config;
}

export async function saveConfig(config) {
  validateAutomation(config.automation);
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
