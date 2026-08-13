/**
 * kie.ai client for AEO — port of scrapper/core/kie.py. Two response formats:
 *   - Claude slugs (`claude-*`) → Anthropic Messages API (/claude/v1/messages),
 *     the web_search tool gives real citations (grounded — the "claude" engine);
 *   - everything else (`gemini-*`) → per-model OpenAI endpoint
 *     /<slug>/v1/chat/completions (mentions without citations).
 *
 * PURE VERIFIABLE CORE — `parseKie(envelope, {claude})` (port of `_parse_claude`
 * kie.py:120 / `_parse_openai` kie.py:156 + `_usage_tokens` kie.py:269): envelope →
 * {text, citations, tokensIn, tokensOut}. The `kieChat` transport is network + usage
 * accounting on top of the core; not exercised in tests (needs a live call).
 */
import { isDict, pyStrOrEmpty, pyStrip } from '../parse';
import {
  citationsFrom,
  intOrNull,
  joinContent,
  type ParsedAnswer,
  type RawSource,
} from './shared';
import { recordUsage, shortError } from '../usage';

export const KIE_CLAUDE_URL = 'https://api.kie.ai/claude/v1/messages';
export const kieOpenaiUrl = (slug: string): string =>
  `https://api.kie.ai/${slug}/v1/chat/completions`;

/** Anthropic web-search tool (grounding); max_uses keeps the price in check (kie.py:42). */
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 4,
} as const;

const DEFAULT_TIMEOUT_MS = 90_000;
const GROUNDED_TIMEOUT_MS = 120_000;

/** OpenRouter-style vendor prefixes that kie doesn't understand (kie.py:50). */
const VENDOR_PREFIXES = [
  'anthropic/',
  'openai/',
  'google/',
  'x-ai/',
  'qwen/',
  'deepseek/',
  'perplexity/',
  'mistralai/',
  'meta-llama/',
];

/** kie call error; `status` — HTTP/body code (for the fallback retry logic). */
export class KieError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'KieError';
    this.status = status;
  }
}

/**
 * `to_kie_model` (kie.py:67): OpenRouter-style → kie slug. Drop
 * `:online`/`:free`/`:nitro` suffixes; `anthropic/claude-opus-4.8` →
 * `claude-opus-4-8` (version dots → dashes); strip other vendor prefixes;
 * already-kie slugs pass through unchanged.
 */
export function toKieModel(model: string): string {
  let m = (model || '').trim();
  for (const suf of [':online', ':free', ':nitro']) {
    if (m.endsWith(suf)) m = m.slice(0, -suf.length);
  }
  if (m.startsWith('anthropic/')) {
    return m.slice('anthropic/'.length).replace(/\./g, '-');
  }
  for (const p of VENDOR_PREFIXES) {
    if (m.startsWith(p)) {
      m = m.slice(p.length);
      break;
    }
  }
  return m;
}

/** `is_claude` (kie.py:87). */
export function isClaudeSlug(slug: string): boolean {
  return slug.startsWith('claude');
}

/** `_parse_claude` (kie.py:120): Anthropic envelope → (text, raw sources). */
function parseClaudeEnvelope(data: unknown): { text: string; srcs: RawSource[] } {
  const blocks = isDict(data) ? (data as Record<string, unknown>).content : undefined;
  if (!Array.isArray(blocks)) return { text: '', srcs: [] };
  const texts: string[] = [];
  const srcs: RawSource[] = [];
  for (const b of blocks) {
    if (!isDict(b)) continue;
    const t = b.type;
    if (t === 'text' && b.text) {
      texts.push(String(b.text));
    } else if (t === 'web_search_tool_result' || t === 'tool_result') {
      const inner = b.content;
      if (Array.isArray(inner)) {
        for (const item of inner) {
          if (isDict(item) && item.url) {
            srcs.push({ url: item.url, title: item.title || '' });
          }
        }
      }
    }
    // Citations inside text blocks (Anthropic citations API) — for EVERY block.
    const cs = (b as Record<string, unknown>).citations;
    if (Array.isArray(cs)) {
      for (const c of cs) {
        if (!isDict(c) || !c.url) continue;
        srcs.push({ url: c.url, title: c.title || c.document_title || '' });
      }
    }
  }
  // Python: " ".join(texts).strip()
  return { text: pyStrip(texts.join(' ')), srcs };
}

/** `_parse_openai` (kie.py:156): OpenAI envelope → (text, raw sources). */
function parseOpenaiEnvelope(data: unknown): { text: string; srcs: RawSource[] } {
  const msg = isDict(data)
    ? ((data as Record<string, unknown>).choices as unknown[] | undefined)?.[0]
    : undefined;
  const message = isDict(msg) ? (msg as Record<string, unknown>).message : undefined;
  if (!isDict(message)) return { text: '', srcs: [] };
  const text = joinContent(message.content);
  const srcs: RawSource[] = [];
  const cites = isDict(data) ? (data as Record<string, unknown>).citations : undefined;
  if (Array.isArray(cites)) {
    for (const u of cites) {
      if (typeof u === 'string') srcs.push({ url: u, title: '' });
      else if (isDict(u) && u.url) srcs.push({ url: String(u.url), title: u.title || '' });
    }
  }
  const anns = (message as Record<string, unknown>).annotations;
  if (Array.isArray(anns)) {
    for (const a of anns) {
      const uc = (isDict(a) ? a.url_citation : undefined) as Record<string, unknown> | undefined;
      if (isDict(uc) && uc.url) srcs.push({ url: uc.url, title: uc.title || '' });
    }
  }
  return { text, srcs };
}

/** `_usage_tokens` (kie.py:269): Anthropic input/output_tokens or OpenAI prompt/completion. */
function usageTokens(data: unknown, claude: boolean): [number | null, number | null] {
  const u = isDict(data) ? (data as Record<string, unknown>).usage : undefined;
  if (!isDict(u)) return [null, null];
  return claude
    ? [intOrNull(u.input_tokens), intOrNull(u.output_tokens)]
    : [intOrNull(u.prompt_tokens), intOrNull(u.completion_tokens)];
}

/**
 * PURE CORE: kie envelope → {text, citations, tokensIn, tokensOut}. `claude`
 * picks the format (Anthropic vs OpenAI). Citations — canonical `[{url,title}]` via
 * dedup + `citeItems` (like Python `_res_cites`). Empty/malformed envelope → text=''
 * (the transport treats this as an "empty response" error, below).
 */
export function parseKie(data: unknown, opts: { claude: boolean }): ParsedAnswer {
  const { text, srcs } = opts.claude
    ? parseClaudeEnvelope(data)
    : parseOpenaiEnvelope(data);
  const [tokensIn, tokensOut] = usageTokens(data, opts.claude);
  return { text, citations: citationsFrom(srcs), tokensIn, tokensOut };
}

/** kie response body carries an error code-in-body on HTTP 200 (kie.py:243-255). */
function bodyError(data: unknown): { status: number; message: string } | null {
  if (!isDict(data)) return null;
  if (data.type === 'error') {
    const err = (isDict(data.error) ? data.error : {}) as Record<string, unknown>;
    return { status: 529, message: pyStrOrEmpty(err.message) || 'kie error' };
  }
  const code = data.code;
  if (typeof code === 'number' && code !== 200 && !('choices' in data) && !('content' in data)) {
    return { status: code, message: pyStrOrEmpty(data.msg) || 'kie error' };
  }
  return null;
}

export interface KieChatOpts {
  apiKey: string;
  grounded?: boolean;
  maxTokens?: number;
  system?: string;
}

/**
 * Transport (port of kie.chat, kie.py:178): one call → ParsedAnswer + usage accounting.
 * `grounded=true` turns on web_search ONLY for Claude slugs (kie.py:191).
 * Throws `KieError` (with `status`) on network/HTTP/body-error/empty response —
 * symmetric with Python, so the kie→OpenRouter fallback can tell the reason apart.
 */
export async function kieChat(
  model: string,
  prompt: string,
  { apiKey, grounded = false, maxTokens = 2000, system }: KieChatOpts,
): Promise<ParsedAnswer & { model: string; grounded: boolean }> {
  const slug = toKieModel(model);
  const claude = isClaudeSlug(slug);
  const g = grounded && claude;
  const url = claude ? KIE_CLAUDE_URL : kieOpenaiUrl(slug);
  const body: Record<string, unknown> = claude
    ? {
        model: slug,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
        ...(system ? { system } : {}),
        ...(g ? { tools: [WEB_SEARCH_TOOL] } : {}),
      }
    : {
        model: slug,
        max_tokens: maxTokens,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      };
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(g ? GROUNDED_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'kie', model: slug, status: 'error', error: shortError(exc), latencyMs: lat(), grounded: g });
    throw new KieError(`${slug}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'kie', model: slug, status: 'error', error: String(res.status), latencyMs: lat(), grounded: g });
    throw new KieError(`${slug}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'kie', model: slug, status: 'error', error: 'non_json', latencyMs: lat(), grounded: g });
    throw new KieError(`${slug}: non-JSON response`);
  }

  const parsed = parseKie(data, { claude });
  const be = bodyError(data);
  if (be) {
    recordUsage({ provider: 'kie', model: slug, status: 'error', error: String(be.status), latencyMs: lat(), grounded: g });
    throw new KieError(`${slug}: ${be.message}`, be.status);
  }
  if (!parsed.text) {
    recordUsage({ provider: 'kie', model: slug, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded: g });
    throw new KieError(`${slug}: empty response from model`);
  }
  recordUsage({ provider: 'kie', model: slug, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded: g });
  return { ...parsed, model: slug, grounded: g };
}
