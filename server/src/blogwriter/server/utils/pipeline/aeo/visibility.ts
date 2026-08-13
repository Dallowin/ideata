/**
 * AEO visibility check (port of blog_agent/aeo/visibility.py): for each query
 * we ask the engine, then compute per-domain coverage, best rank, weighted
 * visibility (weight = 1/rank), and share of voice.
 */
import type { VisibilityReport, VisibilityRow } from '../types'
import { type AnswerEngine, domainMatches } from './engines'

export async function checkVisibility(
  queries: string[],
  domains: string[],
  engine: AnswerEngine,
  limit = 8,
): Promise<VisibilityReport> {
  const clean = domains.map(d => d.toLowerCase().trim()).filter(Boolean)
  const acc = new Map<string, VisibilityRow>()
  for (const d of clean) {
    acc.set(d, {
      domain: d, citedQueries: 0, totalQueries: queries.length,
      bestRank: null, score: 0, shareOfVoice: 0, coverage: 0, examples: [],
    })
  }

  for (const q of queries) {
    const answer = await engine.ask(q, limit)
    for (const domain of clean) {
      const rank = firstRank(answer.citations, domain)
      if (rank === null) continue
      const row = acc.get(domain)!
      row.citedQueries++
      row.score += 1 / rank
      row.bestRank = row.bestRank === null ? rank : Math.min(row.bestRank, rank)
      if (row.examples.length < 5) row.examples.push(q)
    }
  }

  const rows = [...acc.values()]
  const total = rows.reduce((s, r) => s + r.score, 0)
  for (const r of rows) {
    r.shareOfVoice = total ? Math.round((100 * r.score / total) * 10) / 10 : 0
    r.coverage = r.totalQueries ? Math.round((100 * r.citedQueries / r.totalQueries) * 10) / 10 : 0
    r.score = Math.round(r.score * 1000) / 1000
  }
  return { queries: [...queries], rows, engine: engine.name }
}

function firstRank(citations: string[], domain: string): number | null {
  for (let i = 0; i < citations.length; i++) {
    if (domainMatches(citations[i], domain)) return i + 1
  }
  return null
}
