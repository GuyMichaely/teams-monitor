// Loads configuration and the user context fed to the brain.

import { copyFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(ROOT, "config", "config.json");
const CONFIG_EXAMPLE_FILE = join(ROOT, "config", "config.example.json");
const USER_PROFILE_FILE = join(ROOT, "context", "user-profile.md");
const USER_PROFILE_EXAMPLE_FILE = join(ROOT, "context", "user-profile.example.md");

async function ensureLocalFile(path, examplePath, label) {
  if (existsSync(path)) return;
  if (!existsSync(examplePath)) {
    throw new Error(`${label} not found and example file is missing: ${examplePath}`);
  }
  await copyFile(examplePath, path);
}

export async function loadConfig() {
  await ensureLocalFile(CONFIG_FILE, CONFIG_EXAMPLE_FILE, "config/config.json");
  return JSON.parse(await readFile(CONFIG_FILE, "utf8"));
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
