// TFS / Azure DevOps Server REST client — the primitives, transport-agnostic.
// Runs on the VM that has TFS access. The PAT lives here (env), never on the laptop.
//
// Assumes on-prem TFS / Azure DevOps Server. Uses broadly-compatible calls:
//  - comments are added via the System.History field (works on older TFS), and read
//    via the comments endpoint with a revision-history fallback.
// Adjust apiVersion in config if your server needs it.

const DEFAULTS = { apiVersion: "6.0", commentsApiVersion: "6.0-preview.3" };

export function loadTfsConfig(env = process.env) {
  const cfg = {
    baseUrl: env.TFS_BASE_URL, // e.g. https://tfs.company.com/tfs
    collection: env.TFS_COLLECTION || "", // e.g. DefaultCollection
    project: env.TFS_PROJECT, // e.g. MyProject
    pat: env.TFS_PAT,
    apiVersion: env.TFS_API_VERSION || DEFAULTS.apiVersion,
    commentsApiVersion: env.TFS_COMMENTS_API_VERSION || DEFAULTS.commentsApiVersion,
  };
  if (!cfg.baseUrl || !cfg.project) {
    throw new Error("TFS config missing: set TFS_BASE_URL and TFS_PROJECT (and TFS_PAT).");
  }
  if (!cfg.pat) throw new Error("TFS config missing: set TFS_PAT.");
  return cfg;
}

function authHeader(pat) {
  return "Basic " + Buffer.from(":" + pat).toString("base64");
}

function projectBase(cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const coll = cfg.collection ? `/${encodeURIComponent(cfg.collection)}` : "";
  return `${base}${coll}/${encodeURIComponent(cfg.project)}`;
}
function collectionBase(cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const coll = cfg.collection ? `/${encodeURIComponent(cfg.collection)}` : "";
  return `${base}${coll}`;
}

async function req(cfg, url, { method = "GET", headers = {}, body, raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: authHeader(cfg.pat), Accept: "application/json", ...headers },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`TFS ${method} ${res.status} ${url.split("/_apis")[1] || url}: ${t.slice(0, 300)}`);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

// Escape a value for safe embedding in a WIQL string literal.
const wiqlStr = (s) => String(s).replace(/'/g, "''");

// ---- Search ---------------------------------------------------------------

/**
 * search_tickets — find work items via WIQL.
 * args: { state?, assignedToMe=true, assignedTo?, types?: string[], top=50, extraWhere? }
 * Returns [{ id, title, state, type, assignedTo, url }].
 */
export async function searchTickets(cfg, args = {}) {
  const { state, assignedToMe = true, assignedTo, types, top = 50, extraWhere } = args;
  const where = [`[System.TeamProject] = @project`];
  if (assignedTo) where.push(`[System.AssignedTo] = '${wiqlStr(assignedTo)}'`);
  else if (assignedToMe) where.push(`[System.AssignedTo] = @Me`);
  if (state) where.push(`[System.State] = '${wiqlStr(state)}'`);
  if (types?.length) {
    where.push("(" + types.map((t) => `[System.WorkItemType] = '${wiqlStr(t)}'`).join(" OR ") + ")");
  }
  if (extraWhere) where.push(`(${extraWhere})`); // caller-supplied, advanced use

  const query =
    `SELECT [System.Id] FROM WorkItems WHERE ${where.join(" AND ")} ` +
    `ORDER BY [System.ChangedDate] DESC`;

  const wiqlUrl = `${projectBase(cfg)}/_apis/wit/wiql?api-version=${cfg.apiVersion}`;
  const result = await req(cfg, wiqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const ids = (result.workItems || []).slice(0, top).map((w) => w.id);
  if (!ids.length) return [];

  const fields = [
    "System.Id",
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.AssignedTo",
  ];
  const batchUrl = `${collectionBase(cfg)}/_apis/wit/workitemsbatch?api-version=${cfg.apiVersion}`;
  const batch = await req(cfg, batchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, fields }),
  });
  return (batch.value || []).map((wi) => ({
    id: wi.id,
    title: wi.fields["System.Title"],
    state: wi.fields["System.State"],
    type: wi.fields["System.WorkItemType"],
    assignedTo: displayName(wi.fields["System.AssignedTo"]),
    url: wi._links?.html?.href || wi.url,
  }));
}

// ---- Read -----------------------------------------------------------------

/** read_ticket — full fields + relations. */
export async function readTicket(cfg, { id }) {
  const url = `${collectionBase(cfg)}/_apis/wit/workitems/${id}?$expand=all&api-version=${cfg.apiVersion}`;
  const wi = await req(cfg, url);
  const f = wi.fields || {};
  return {
    id: wi.id,
    title: f["System.Title"],
    type: f["System.WorkItemType"],
    state: f["System.State"],
    assignedTo: displayName(f["System.AssignedTo"]),
    tags: f["System.Tags"] ? f["System.Tags"].split(";").map((s) => s.trim()) : [],
    description: stripHtml(f["System.Description"]),
    reproSteps: stripHtml(f["Microsoft.VSTS.TCM.ReproSteps"]),
    areaPath: f["System.AreaPath"],
    iterationPath: f["System.IterationPath"],
    changedDate: f["System.ChangedDate"],
    relations: (wi.relations || []).map((r) => ({ rel: r.rel, url: r.url, name: r.attributes?.name })),
    url: wi._links?.html?.href || wi.url,
  };
}

/** read_ticket_comments — comment thread (newest APIs) with revision fallback. */
export async function readTicketComments(cfg, { id }) {
  const url = `${projectBase(cfg)}/_apis/wit/workItems/${id}/comments?api-version=${cfg.commentsApiVersion}`;
  try {
    const data = await req(cfg, url);
    return (data.comments || data.value || []).map((c) => ({
      author: displayName(c.createdBy),
      date: c.createdDate,
      text: stripHtml(c.text),
    }));
  } catch {
    // Fallback: reconstruct from revision history (System.History field).
    const updates = await req(
      cfg,
      `${collectionBase(cfg)}/_apis/wit/workItems/${id}/updates?api-version=${cfg.apiVersion}`
    );
    return (updates.value || [])
      .filter((u) => u.fields?.["System.History"]?.newValue)
      .map((u) => ({
        author: displayName(u.revisedBy),
        date: u.revisedDate,
        text: stripHtml(u.fields["System.History"].newValue),
      }));
  }
}

/** list_attachments — attachments linked to a work item. */
export async function listAttachments(cfg, { id }) {
  const wi = await readTicket(cfg, { id });
  return wi.relations
    .filter((r) => r.rel === "AttachedFile")
    .map((r) => ({ name: r.name, url: r.url }));
}

/** download_attachment — returns { name, base64 }. */
export async function downloadAttachment(cfg, { url, name }) {
  const res = await req(cfg, url, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  return { name: name || "attachment", base64: buf.toString("base64") };
}

/** list_states — valid states for a work item type (avoids illegal transitions). */
export async function listStates(cfg, { type }) {
  const url =
    `${projectBase(cfg)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states` +
    `?api-version=${cfg.apiVersion}`;
  const data = await req(cfg, url);
  return (data.value || []).map((s) => ({ name: s.name, category: s.category, color: s.color }));
}

// ---- Write ----------------------------------------------------------------

async function patchWorkItem(cfg, id, ops) {
  const url = `${collectionBase(cfg)}/_apis/wit/workitems/${id}?api-version=${cfg.apiVersion}`;
  const wi = await req(cfg, url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json-patch+json" },
    body: JSON.stringify(ops),
  });
  return { id: wi.id, state: wi.fields?.["System.State"], url: wi._links?.html?.href || wi.url };
}

const addOp = (path, value) => ({ op: "add", path: `/fields/${path}`, value });

/** change_state */
export function changeState(cfg, { id, state }) {
  if (!state) throw new Error("change_state: missing state");
  return patchWorkItem(cfg, id, [addOp("System.State", state)]);
}

/** modify_ticket — title / description / arbitrary fields. */
export function modifyTicket(cfg, { id, title, description, fields = {} }) {
  const all = { ...fields };
  if (title != null) all["System.Title"] = title;
  if (description != null) all["System.Description"] = description;
  const ops = Object.entries(all).map(([p, v]) => addOp(p, v));
  if (!ops.length) throw new Error("modify_ticket: nothing to change");
  return patchWorkItem(cfg, id, ops);
}

/** assign_ticket */
export function assignTicket(cfg, { id, assignee }) {
  return patchWorkItem(cfg, id, [addOp("System.AssignedTo", assignee)]);
}

/** comment_ticket — via System.History for on-prem compatibility. */
export function commentTicket(cfg, { id, text }) {
  if (!text) throw new Error("comment_ticket: missing text");
  return patchWorkItem(cfg, id, [addOp("System.History", text)]);
}

/** link_tickets — relate two work items (rel e.g. System.LinkTypes.Hierarchy-Forward). */
export function linkTickets(cfg, { id, targetId, rel = "System.LinkTypes.Related" }) {
  const targetUrl = `${collectionBase(cfg)}/_apis/wit/workItems/${targetId}`;
  const op = { op: "add", path: "/relations/-", value: { rel, url: targetUrl } };
  return patchWorkItem(cfg, id, [op]);
}

/** add_attachment — upload bytes, then link to the work item. */
export async function addAttachment(cfg, { id, fileName, base64, comment }) {
  if (!fileName || !base64) throw new Error("add_attachment: need fileName and base64");
  const upUrl =
    `${collectionBase(cfg)}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}` +
    `&api-version=${cfg.apiVersion}`;
  const up = await req(cfg, upUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(base64, "base64"),
  });
  const op = {
    op: "add",
    path: "/relations/-",
    value: { rel: "AttachedFile", url: up.url, attributes: { comment: comment || "" } },
  };
  return patchWorkItem(cfg, id, [op]);
}

// ---- helpers --------------------------------------------------------------

function displayName(identity) {
  if (!identity) return null;
  if (typeof identity === "string") return identity;
  return identity.displayName || identity.uniqueName || identity.name || null;
}

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}
