'use strict';
/**
 * Parse an HTTP Range header for a file of `size` bytes.
 * Returns null (no/ignored range -> send whole file), {start,end} (inclusive), or 'invalid' (-> 416).
 * Only the first range of a multi-range request is honoured (players send one).
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(String(header).trim());
  if (!m) return null; // unknown unit: ignore, serve 200
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start, end;
  if (a === '') { // suffix: last N bytes
    const n = Number(b);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
module.exports = { parseRange };
