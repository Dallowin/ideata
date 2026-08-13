/** Data structures that flow through the pipeline (port of blog_agent/schemas.py). */
import type { SlopReport } from '../../../shared/antislop/patterns'

export interface Keyword {
  query: string
  intent: string // informational|comparison|howto|best|alternatives|definition
  cluster: string
  aeoScore: number // 0..10 — how "answerable" the query is for AI
  rationale: string
}

/** Search query generated for a topic to find similar posts. */
export interface SearchQuery {
  query: string
  angle: string // a short note on the angle this query searches under
}

/** Attributed fact from a source: specifics (number/date/name) + a supporting quote. */
export interface SourceFact {
  claim: string // the fact in our own words, with numbers/dates/names preserved
  quote?: string // a short verbatim quote from the source (backing for fact-check)
}

export interface Source {
  url: string
  title: string
  text: string
  keyPoints: string[]
  facts?: SourceFact[] // facts with numbers/dates — raw material for E-E-A-T citations
  author?: string // byline from Readability (an E-E-A-T signal for the source)
  publishedAt?: string // the source's publication date, if it could be extracted
  siteName?: string // name of the publication/site
  authority?: number // 0..10 domain-authority heuristic
  query?: string // which search query found this post
  snippet?: string // excerpt from the search results
  fetched?: boolean // whether the full text was fetched (false = a candidate from search results)
}

export interface Perspective {
  name: string
  rationale: string
  questions: string[]
}

/** A section keyword with a required flag (req = must appear in the text). */
export interface SectionKeyword {
  word: string
  required: boolean
}

export interface OutlineSection {
  heading: string
  intent: string
  points: string[]
  keywords: SectionKeyword[] // section keywords (req = required, opt = nice-to-have)
  topics: string[] // adjacent subtopics the section must touch on
  estWords: number
}

export interface Outline {
  title: string
  angle: string
  audience: string
  sections: OutlineSection[]
}

/** E-E-A-T gate report: citations, stripped hallucinations, structural blocks. */
export interface EeatReport {
  citations: number // unique sources cited in the text
  citedUrls: string[]
  removedLinks: string[] // model-hallucinated URLs stripped from the text
  hasLead: boolean // a direct answer before the first H2
  hasFaq: boolean
  fixApplied: boolean // whether the LLM link-weaving fix pass ran
  issues: string[]
}

export interface Draft {
  outline: Outline
  bodyMd: string
  slop?: SlopReport
  eeat?: EeatReport
  rewrites: number
}

export interface Article {
  title: string
  bodyMd: string
  outline: Outline
  sources: Source[]
  slop: SlopReport
  eeat?: EeatReport
  wordCount: number
  notes: string[]
}

export interface VisibilityRow {
  domain: string
  citedQueries: number
  totalQueries: number
  bestRank: number | null
  score: number
  shareOfVoice: number
  coverage: number
  examples: string[]
}

export interface VisibilityReport {
  queries: string[]
  rows: VisibilityRow[]
  engine: string
}
