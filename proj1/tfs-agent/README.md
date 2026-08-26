# tfs-agent

Runs **on the VM with TFS access**. In the pull model (Protocol v2), this is a **worker**:
it makes only **outbound** connections — long-polling the dispatcher (on the personal
machine) for jobs, executing them against the TFS REST API, and posting results back.
The **PAT stays on the VM**; the VM never accepts inbound connections.

See `PROTOCOL.md` for the wire contract. Entry point: `src/worker.mjs`.

## Why a separate app + pull model

TFS access lives on a separate, locked-down Windows VM (outbound internet only; likely
can't open ports or install a mesh VPN). So the personal machine hosts the endpoint and
the VM pulls work from it. `src/worker.mjs` is a reference worker — use, adapt, or replace.

## Primitives (see `src/handlers.mjs`)

Reads: `search_tickets`, `list_states`, `read_ticket`, `read_ticket_comments`,
`list_attachments`, `download_attachment`.
Writes: `change_state`, `modify_ticket`, `comment_ticket`, `add_attachment`,
`assign_ticket`, `link_tickets`.
Escape hatch: `run_agent_task` (hand an open-ended task to Claude Code on the VM — TODO).

## Config (environment on the VM)

```
DISPATCHER_URL=https://you.example.com       # public URL of the dispatcher (personal machine)
TFS_AGENT_TOKEN=<long random shared token>   # must match the dispatcher; NOT the PAT

TFS_BASE_URL=https://tfs.company.com/tfs      # TFS server root
TFS_COLLECTION=DefaultCollection              # optional
TFS_PROJECT=MyProject
TFS_PAT=<personal access token, Work Items Read & Write>
# optional:
TFS_API_VERSION=6.0
TFS_WRITES_ENABLED=false                       # run read-only
```

Run: `node src/worker.mjs`

Assumes **on-prem TFS / Azure DevOps Server**; comments are written via `System.History`
for compatibility. Adjust for cloud (dev.azure.com) if needed.

## Status / TODO

- [x] Core REST primitives (`src/tfs.mjs`) — loads clean.
- [x] Contract + dispatch with read-only guard (`src/handlers.mjs`).
- [x] Protocol v2 (pull model) speced (`PROTOCOL.md`); dispatcher end built + tested on the
      personal machine (`../src/integrations/tfs-server.mjs`, `tfs-queue.mjs`).
- [x] Reference worker (`src/worker.mjs`).
- [ ] Deploy worker on the VM; set env; point `DISPATCHER_URL` at the published dispatcher.
- [ ] `run_agent_task` bridge to Claude Code on the VM.
- [ ] **Not yet tested against a live TFS instance** (needs the VM + PAT) — the primitives
      in `tfs.mjs` are the untested part.
