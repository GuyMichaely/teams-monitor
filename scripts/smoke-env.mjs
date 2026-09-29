import { existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Set before application imports: never borrow the real registration/config.
const home = mkdtempSync(join(tmpdir(), "teams-monitor-smoke-"));
process.env.TEAMS_MONITOR_HOME = home;
for (const dir of ["data", "config", "context"]) mkdirSync(join(home, dir));
// The isolated fixture follows whichever config format this checkout uses.
const format = existsSync(join(root, "config", "config.example.yaml")) ? "yaml" : "json";
copyFileSync(join(root, "config", `config.example.${format}`), join(home, "config", `config.${format}`));
copyFileSync(join(root, "context", "user-profile.example.md"), join(home, "context", "user-profile.md"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
