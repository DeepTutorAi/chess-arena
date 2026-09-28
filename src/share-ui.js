// Browser plumbing for getting a game out of the app: save a PGN file, copy text
// or a share link. Every dependency is injectable so this is testable without a
// real browser, and every failure is reported to the caller instead of thrown.

/** "Alice-vs-Stockfish-2026-09-28.pgn" — safe on every filesystem. ASCII only:
 *  browsers replace a download name containing other scripts with plain "download". */
export function pgnFilename(record, date = new Date()) {
  const clean = (s, fallback) => String(s ?? '').normalize('NFKD').replace(/[^A-Za-z0-9-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || fallback;
  const white = clean(record.players?.white?.name, 'white');
  const black = clean(record.players?.black?.name, 'black');
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${white}-vs-${black}-${day}.pgn`;
}

/**
 * Offer `text` as a downloaded file. Resolves true when the download was started.
 */
export function downloadTextFile(filename, text, { doc = globalThis.document, urlApi = globalThis.URL, BlobImpl = globalThis.Blob } = {}) {
  try {
    const blob = new BlobImpl([text], { type: 'application/x-chess-pgn;charset=utf-8' });
    const url = urlApi.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    doc.body.appendChild(link);
    link.click();
    link.remove();
    // Revoke later: some browsers cancel the download if the URL dies at once.
    setTimeout(() => urlApi.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text to the clipboard: the async API when the page may use it, otherwise
 * the old selection trick. Resolves true when something was copied.
 */
export async function copyText(text, { nav = globalThis.navigator, doc = globalThis.document } = {}) {
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch { /* permission denied / insecure context: try the fallback */ }
  try {
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    doc.body.appendChild(area);
    area.select();
    const ok = doc.execCommand?.('copy') === true;
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** The page's own address with the token in the hash — no server involved. */
export function shareUrl(token, loc = globalThis.location) {
  return `${loc.origin}${loc.pathname}#g=${token}`;
}
