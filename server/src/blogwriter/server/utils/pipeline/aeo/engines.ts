/**
 * "Answer engines" for checking AEO visibility (port of blog_agent/aeo/engines.py).
 * AnswerEngine.ask(query) -> Answer with cited sources (URLs by rank).
 *
 * - SearchAnswerEngine — proxies through DDG search (top results ≈ AI's retrieval layer).
 * - MockAnswerEngine — deterministic citations (tests/demo without network).
 */
import { ddgSearch } from '../../search'

export interface Answer {
  query: string
  citations: string[] // URLs by citation rank
  answerText: string
}

export interface AnswerEngine {
  name: string
  ask: (query: string, limit?: number) => Promise<Answer>
}

export class SearchAnswerEngine implements AnswerEngine {
  name = 'search-proxy'

  async ask(query: string, limit = 8): Promise<Answer> {
    const hits = await ddgSearch(query, limit)
    return { query, citations: hits.map(h => h.url).filter(Boolean).slice(0, limit), answerText: '' }
  }
}

export class MockAnswerEngine implements AnswerEngine {
  name = 'mock'
  fixtures: Record<string, string[]>
  pool: string[]

  constructor(fixtures?: Record<string, string[]>, pool?: string[]) {
    this.fixtures = fixtures || {}
    this.pool = pool || [
      'https://competitor-a.com/blog/{}',
      'https://yoursite.com/guide/{}',
      'https://competitor-b.io/post/{}',
      'https://wikipedia.org/wiki/{}',
    ]
  }

  async ask(query: string, limit = 8): Promise<Answer> {
    if (this.fixtures[query]) {
      return { query, citations: this.fixtures[query].slice(0, limit), answerText: '' }
    }
    // Deterministic pool rotation by query length (no random).
    const slug = query.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'q'
    const shift = query.length % this.pool.length
    const rotated = [...this.pool.slice(shift), ...this.pool.slice(0, shift)]
    return { query, citations: rotated.map(tpl => tpl.replace('{}', slug)).slice(0, limit), answerText: '' }
  }
}

/** Registrable domain without www (rough, no public-suffix list). */
export function domainOf(url: string): string {
  try {
    let host = new URL(url).hostname.toLowerCase()
    if (host.startsWith('www.')) host = host.slice(4)
    return host
  } catch {
    return ''
  }
}

export function domainMatches(url: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '')
  const host = domainOf(url)
  return host === d || host.endsWith('.' + d)
}
