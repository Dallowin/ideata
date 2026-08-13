/**
 * Parses robots.txt into sections — port of core/robots_parse.py.
 *
 * Custom implementation instead of a regex one-liner: a naive "find Disallow: /
 * somewhere after User-agent: *" breaks on any site that blocks INDIVIDUAL
 * bots — a lazy line skip jumps the section boundary and grabs someone else's
 * Disallow. That's how Cloudflare's robots (`User-agent: *` → `Allow: /`, then
 * `User-agent: GPTBot` → `Disallow: /`) used to read as "site fully blocked".
 */

// AI engine crawlers: they're what feeds ChatGPT/Perplexity/AI Overviews answers,
// so blocking them isn't "security" — it's opting out of AI visibility.
export const AI_BOTS: Record<string, string> = {
  'gptbot': 'ChatGPT (OpenAI)',
  'oai-searchbot': 'ChatGPT Search',
  'chatgpt-user': 'ChatGPT (переходы)',
  'claudebot': 'Claude (Anthropic)',
  'anthropic-ai': 'Claude (Anthropic)',
  'perplexitybot': 'Perplexity',
  'google-extended': 'Google AI Overviews / Gemini',
  'applebot-extended': 'Apple Intelligence',
  'bingbot': 'Bing / Copilot',
  'ccbot': 'Common Crawl (обучение моделей)',
  'meta-externalagent': 'Meta AI',
  'bytespider': 'ByteDance',
  'amazonbot': 'Amazon',
};

export type RobotsGroups = Record<string, Array<[string, string]>>;

/**
 * robots.txt → {user-agent (lower): [[directive, value], ...]}.
 *
 * A single block can declare several User-agent lines in a row — the rules
 * below apply to each of them (that's what the spec requires).
 */
export function parseRobots(text: string): RobotsGroups {
  const groups: RobotsGroups = {};
  let current: string[] = [];
  // true while consecutive User-agent lines keep coming — they share one rule set.
  let collecting = false;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.split('#', 1)[0].trim();
    if (!line || !line.includes(':')) continue;
    const idx = line.indexOf(':');
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!collecting) { current = []; collecting = true; }
      const ua = value.toLowerCase();
      current.push(ua);
      if (!(ua in groups)) groups[ua] = [];
      continue;
    }

    collecting = false;
    if (!current.length) continue; // directive before the first User-agent — no-op
    for (const ua of current) groups[ua].push([field, value]);
  }
  return groups;
}

/**
 * Whether the site root is blocked for this section.
 *
 * Spec rule: on conflict, the longer (more specific) path wins, and Allow
 * wins on a tie. So `Disallow: /` + `Allow: /` = open.
 */
function blocksRoot(rules: Array<[string, string]>): boolean {
  const disallowRoot = rules.some(([f, v]) => f === 'disallow' && v === '/');
  const allowRoot = rules.some(([f, v]) => f === 'allow' && v === '/');
  return disallowRoot && !allowRoot;
}

/** Whether the whole site is blocked for ALL bots (the `User-agent: *` section). */
export function blocksAll(text: string): boolean {
  return blocksRoot(parseRobots(text)['*'] || []);
}

/**
 * Human-readable names of AI crawlers that are blocked from the root.
 *
 * Accounts for both an explicit bot section and the general `User-agent: *`:
 * if everything is blocked, then every AI bot without its own, more specific
 * section is blocked too.
 */
export function blockedAiBots(text: string): string[] {
  const groups = parseRobots(text);
  const starBlocks = blocksRoot(groups['*'] || []);
  const out: string[] = [];
  for (const [ua, label] of Object.entries(AI_BOTS)) {
    const rules = groups[ua];
    const blocked = rules !== undefined ? blocksRoot(rules) : starBlocks;
    if (blocked && !out.includes(label)) out.push(label);
  }
  return out;
}
