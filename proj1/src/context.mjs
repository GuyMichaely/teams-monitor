// Loads configuration and the user context fed to the brain.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadConfig() {
  const path = join(ROOT, "config", "config.json");
  if (!existsSync(path)) {
    throw new Error("config/config.json not found. Copy config/config.example.json to config/config.json.");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * The freeform user profile (projects, tone, people) fed to the brain as its
 * context about you. Edit context/user-profile.md — everything in it goes to
 * the model, so keep it focused.
 */
export async function loadUserProfile() {
  const path = join(ROOT, "context", "user-profile.md");
  if (!existsSync(path)) return "";
  return await readFile(path, "utf8");
}
