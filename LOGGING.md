# Logs

Structured application logs use YAML documents separated by a line containing
`---`. Each document is one record. YAML strings retain their original values;
timestamps are strings, not converted dates.

- `data/activity.yaml`: message handling and delivery audit.
- `data/gui-diagnostics.yaml`: GUI/WebSocket connection diagnostics.
- `data/agent/activity.yaml`: model execution diagnostics, bounded and rotated.
- `data/lifecycle/run-*.yaml` and supervisor run folders: process lifecycle evidence.
- `data/supervisor/session-*/supervisor.yaml`: supervisor health and exits.
- `data/agent/store.sqlite`, `records.body`: YAML policy/model execution records.
  Message/model/conversation links are separate indexed columns.

The dashboard displays structured log details as YAML. Model requests, Teams CDP,
HTTP/WebSocket envelopes, Firebase files and operational state still use their
existing formats. SQLite message/action/session state is not an audit-log file.
Plain process output and Android's existing text diagnostics remain plain text.

## Existing installations

Stop the system, run the explicit migration, then start it:

```powershell
bun run system:stop
bun scripts/migrate-logs-yaml.mjs
bun run system:start
```

The migration refuses to run while GUI/supervisor/executor ports are occupied.
Only application-owned JSONL logs and agent execution records are converted.
Original file logs remain as `.jsonl.migrated.bak`; the original database is saved
as `store.sqlite.pre-yaml.bak`. These are ignored private files. Parsed records
are verified before replacement; corrupt records remain invalid-log evidence.
The database conversion is transactional and preserves record IDs, timestamps,
message dedupe, sessions, action states and pending work. Rerunning is safe.
Runtime readers do not include a JSON-log compatibility path.

## Actions

Actions shows committed queued/scheduled, running and finished effects, with
pending cancellation. It is not a list of model tool calls or proposals that
were never committed. The selected message's Actions panel reads the same
records, including downstream effects from its wakes/result handlers. Manual
schedules have no originating message. Terminal results are bounded to the
latest retained entries in the UI; records remain in the database.

Selecting a message also shows its agent invocations and handling trace. The
collapsed Execution log retains recent raw diagnostics for runs without a
message, such as manual interventions.
