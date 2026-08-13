/**
 * Small XML-text parsing helpers shared by SERP-XML (demand.py) and Google News
 * RSS (rss_mentions.py). Python gets them for free: `html.unescape` plus
 * automatic entity decoding in ElementTree. Node has neither, so we keep a
 * compact decoder for named (5 XML entities + nbsp) and numeric (&#NN;/&#xHH;)
 * entities plus `stripTags` (`_TAG_RE.sub`). Coverage is real SERP/news bodies;
 * parity runs on synthetic data over the same entity set.
 */

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * `html.unescape` (trimmed down): the named entities above + numeric ones
 * (decimal `&#160;` and hexadecimal `&#xA0;`). An invalid code point or broken
 * reference is left as-is (just like Python on an unknown entity).
 */
export function htmlUnescape(s: string): string {
  if (!s || s.indexOf('&') === -1) return s || '';
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const hex = ent[1] === 'x' || ent[1] === 'X';
      const code = parseInt(hex ? ent.slice(2) : ent.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** `_TAG_RE.sub("", s)` — strip inline markup such as `<hlword>` and other tags. */
export function stripTags(s: string): string {
  return (s || '').replace(/<[^>]+>/g, '');
}

/** `re.sub(r"\s+", " ", …).strip()` — collapse whitespace runs and trim the edges. */
export function collapseWs(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}
