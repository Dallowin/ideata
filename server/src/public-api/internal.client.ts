import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * Client for the scrapper's internal channel (web/internal.py): launches heavy
 * Python operations (deep product analysis, AEO, discover) after api has already
 * checked the session/plan/quota/owner. site_analytic no longer goes through
 * here — its run is native (SiteAnalyticService.runAnalysis). Talks over
 * localhost, gated by the shared INTERNAL_TOKEN secret (X-Internal-Token). The
 * scrapper's error statuses (400/404/429/503) are forwarded to the client as-is —
 * the message text is in Russian (scrapper product content).
 */
@Injectable()
export class InternalClient {
  private base(): string {
    return (
      process.env.SCRAPPER_INTERNAL_URL || 'http://127.0.0.1:8000'
    ).replace(/\/$/, '');
  }

  private token(): string {
    const t = process.env.INTERNAL_TOKEN || '';
    if (!t) {
      throw new ServiceUnavailableException(
        'internal channel not configured: INTERNAL_TOKEN is missing',
      );
    }
    return t;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.base()}/internal${path}`, {
        method,
        headers: {
          'X-Internal-Token': this.token(),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ServiceUnavailableException('scrapper unavailable');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new HttpException(data?.detail || 'scrapper error', res.status);
    }
    return data;
  }

  startAnalyzeDomain(p: { domain: string; user_id?: number | null }) {
    return this.request('POST', '/analyze_domain', p);
  }

  startAeoTrack(p: {
    domain: string;
    competitors?: string[];
    analysis_id?: number | null;
    user_id?: number | null;
  }) {
    return this.request('POST', '/aeo/track', p);
  }

  setAeoPrompts(trackerId: number, p: { prompts: unknown; user_id?: number }) {
    return this.request('POST', `/aeo/${trackerId}/prompts`, p);
  }

  /**
   * LLM generation of candidate prompts (services.suggest_aeo_prompts) is NOT
   * ported to Nest (external LLM/SERP) — it stays proxied. The owner is checked by
   * api before the call (the internal route runs with check_owner=False).
   */
  suggestAeoPrompts(trackerId: number, p: { n?: number; keywords?: unknown }) {
    return this.request('POST', `/aeo/${trackerId}/prompts/suggest`, p);
  }

  aeoAggregates(trackerId: number, weeks: number) {
    return this.request('GET', `/aeo/${trackerId}/aggregates?weeks=${weeks}`);
  }

  discover(kind: 'competitors' | 'keywords' | 'traffic' | 'domain', qs: string) {
    return this.request('GET', `/discover/${kind}?${qs}`);
  }
}
