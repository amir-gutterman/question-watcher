// Builds the subject/body for an update email. Kept separate from the
// sending code so the copy can change without touching provider wiring.

export const EMAIL_SUBJECT = "Question Watcher - Updates Found";

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildEmailHtml(updates) {
  const sections = updates
    .map((u) => {
      const sourcesHtml = u.sources.length
        ? `<ul>${u.sources
            .map((s) => `<li><a href="${escapeHtml(s.url)}">${escapeHtml(s.title || s.url)}</a></li>`)
            .join("")}</ul>`
        : "<p><em>No sources listed.</em></p>";

      return `
        <div style="margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #e5e7eb;">
          <h2 style="font-size:16px;margin:0 0 12px;">${escapeHtml(u.questionText)}</h2>
          <p style="margin:0 0 8px;"><strong>Previous answer:</strong> ${escapeHtml(u.previousAnswer ?? "(none)")}</p>
          <p style="margin:0 0 8px;"><strong>New answer:</strong> ${escapeHtml(u.newAnswer)}</p>
          <p style="margin:0 0 8px;color:#4b5563;"><strong>Why this counts as an update:</strong> ${escapeHtml(u.changeReason)}</p>
          <p style="margin:12px 0 4px;"><strong>Sources:</strong></p>
          ${sourcesHtml}
          <p style="margin:8px 0 0;color:#6b7280;font-size:12px;">Found on ${u.foundAt.slice(0, 10)}</p>
        </div>`;
    })
    .join("");

  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:640px;margin:0 auto;padding:24px;">
    <h1 style="font-size:20px;">Question Watcher found updates</h1>
    <p style="color:#4b5563;">${updates.length} question${updates.length === 1 ? "" : "s"} changed since the last check.</p>
    ${sections}
  </body>
</html>`;
}

export function buildEmailText(updates) {
  return updates
    .map((u) =>
      [
        `Question: ${u.questionText}`,
        `Previous answer: ${u.previousAnswer ?? "(none)"}`,
        `New answer: ${u.newAnswer}`,
        `Why this counts as an update: ${u.changeReason}`,
        `Sources:`,
        ...(u.sources.length ? u.sources.map((s) => `  - ${s.title || s.url}: ${s.url}`) : ["  (none listed)"]),
        `Date found: ${u.foundAt.slice(0, 10)}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}
