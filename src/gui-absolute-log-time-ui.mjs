const ABSOLUTE_LOG_TIME_SCRIPT = `<script id="absoluteLogTimeScript">
(function() {
  function logDateTime(iso) {
    if (!iso) return "?";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "?";
    return d.toLocaleString([], {
      year:"numeric",
      month:"short",
      day:"numeric",
      hour:"numeric",
      minute:"2-digit",
      second:"2-digit",
      timeZoneName:"short",
    });
  }

  // Message-pipeline flow headers previously used the core relative `ago()`
  // helper through obsAgo(). Keep stage deltas (+120ms, +1.2s) unchanged since
  // those are durations, not wall-clock timestamps.
  if (typeof obsAgo === "function") obsAgo = logDateTime;

  // The legacy activity/escalation feeds call the core lexical `ago()` helper,
  // which cannot be reassigned from an injected script. Replace their renderer
  // instead so every visible event timestamp is an absolute local datetime.
  if (typeof renderActivity === "function") {
    renderActivity = function(items) {
      const escFeed = document.getElementById("escalations");
      const actFeed = document.getElementById("activity");
      if (!escFeed || !actFeed) return;
      const escItems = items.filter(function(r) { return r.kind === "escalation"; }).slice(0, 20);
      escFeed.innerHTML = escItems.length ? escItems.map(function(r) {
        return '<div class="item escalation"><div class="meta">' + esc(r.payload?.chat) + ' · ' + logDateTime(r.at) + '</div>' +
          '<div class="body">' + esc(r.payload?.latest?.author ?? "?") + ': ' + esc(r.payload?.latest?.text ?? "") + '</div>' +
          '<div class="meta">' + esc(r.payload?.reason ?? "") + '</div></div>';
      }).join("") : '<span style="color:var(--dim)">none yet</span>';

      actFeed.innerHTML = items.length ? items.slice(0, 40).map(function(r) {
        if (r.kind === "decision") return '<div class="item"><div class="meta">' + esc(r.chat) + ' · ' + logDateTime(r.at) + ' · <b>' + esc(r.action) + '</b></div><div class="body">' + esc(r.reason ?? "") + '</div></div>';
        if (r.kind === "send") return '<div class="item send"><div class="meta">' + esc(r.chat) + ' · ' + logDateTime(r.at) + ' · sent' + (r.hold ? " (hold msg)" : "") + '</div><div class="body">' + esc(r.text ?? "") + '</div></div>';
        if (r.kind === "escalation") return '<div class="item escalation"><div class="meta">' + esc(r.payload?.chat) + ' · ' + logDateTime(r.at) + ' · escalation</div></div>';
        return '<div class="item"><div class="meta">' + esc(r.kind) + ' · ' + logDateTime(r.at) + '</div><div class="body">' + esc(JSON.stringify(r).slice(0,200)) + '</div></div>';
      }).join("") : '<span style="color:var(--dim)">none yet</span>';
    };
  }
})();
</script>`;

export function injectAbsoluteLogTime(page) {
  if (page.includes('id="absoluteLogTimeScript"')) return page;
  return page.replace("</body>", ABSOLUTE_LOG_TIME_SCRIPT + "\n</body>");
}
