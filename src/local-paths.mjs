import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Tests supply a private home before importing application modules.
export const LOCAL_HOME = process.env.TEAMS_MONITOR_HOME ? resolve(process.env.TEAMS_MONITOR_HOME) : ROOT;
export const CONFIG_FILE = join(LOCAL_HOME, "config", "config.yaml");
export const PROFILE_FILE = join(LOCAL_HOME, "context", "user-profile.md");
export const DATA_DIR = join(LOCAL_HOME, "data");
