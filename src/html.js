// Tiny HTML-escaping helper. Anything that came from another player (display
// names) or from stored data (opening names) must pass through here before it
// is interpolated into an innerHTML template.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}
