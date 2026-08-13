// Domain normalization — matches the normDomain (brands.service.ts) and
// _clean_domain (scrapper/web/api_v1.py) contracts: without it, the privacy
// predicate for site_analyses↔brands silently fails to match.
export function cleanDomain(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0];
}
