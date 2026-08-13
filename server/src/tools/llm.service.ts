import { Injectable, ServiceUnavailableException } from '@nestjs/common';

// Port of the scraper's Analyzer._chat (core/analysis.py): one-shot OpenRouter
// completion with an ordered model-fallback list. Each pass tries every model
// once, so a rate-limited primary falls straight through to the lighter model;
// only when ALL models 429 in a pass do we wait once and retry the list.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_MODELS = (process.env.OPENROUTER_MODELS ??
  'google/gemini-2.5-flash-lite,qwen/qwen3-next-80b-a3b-instruct:free')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const TARGET_MARKET =
  process.env.TARGET_MARKET ??
  'русскоязычное ядро СНГ (Россия, Казахстан, Беларусь; шире — весь СНГ)';

@Injectable()
export class LlmService {
  async complete(
    prompt: string,
    opts: { maxTokens?: number; models?: string[]; apiKey?: string } = {},
  ): Promise<string> {
    const apiKey = opts.apiKey?.trim() || process.env.OPENROUTER_API_KEY || '';
    if (!apiKey)
      throw new ServiceUnavailableException('generation unavailable: OPENROUTER_API_KEY not set');
    const models = opts.models?.length ? opts.models : DEFAULT_MODELS;
    let lastErr = '';

    for (let pass = 0; pass < 2; pass++) {
      let all429 = true;
      let waitHintS = 0;
      for (const model of models) {
        try {
          const r = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://ideata.io',
              'X-Title': 'ideata',
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: opts.maxTokens ?? 900,
            }),
            signal: AbortSignal.timeout(90_000),
          });
          if (r.status === 200) {
            const data: any = await r.json();
            const content = (data?.choices?.[0]?.message?.content ?? '').trim();
            if (content) return content;
            all429 = false;
            lastErr = `${model}: empty content`;
          } else if (r.status === 429) {
            const ra = Number(r.headers.get('retry-after'));
            if (Number.isFinite(ra)) waitHintS = Math.max(waitHintS, ra);
            lastErr = `${model}: 429`;
          } else {
            all429 = false;
            lastErr = `${model}: HTTP ${r.status}`;
          }
        } catch (e: any) {
          all429 = false;
          lastErr = `${model}: ${e?.message ?? e}`;
        }
      }
      if (pass === 0 && all429)
        await new Promise((ok) => setTimeout(ok, Math.min(waitHintS || 8, 30) * 1000));
    }
    throw new ServiceUnavailableException(`generation unavailable: ${lastErr}`);
  }
}
