/**
 * Stage 5b: E-E-A-T gate. Deterministically checks what LLM prompts
 * can't be trusted to get right:
 *  1) every external link in the text points ONLY to real sources of the run
 *     (hallucinated URLs are stripped out, the link text stays);
 *  2) citation count is at least minCitations — otherwise one LLM fix pass
 *     that weaves in links to facts from sources;
 *  3) a lead (text before the first H2) and an FAQ are present;
 *  4) a "Sources" block built from actually-cited URLs is appended at the end.
 * Doesn't block the run: writes a report (score + issues), visible in the stage and in the store.
 */
import type { AppSettings } from '../appSettings'
import { pl } from '../lang'
import type { LLM } from '../llm'
import { normalizeDashes } from '../../../shared/antislop/normalize'
import { hasFaqBlock, sourcesContext } from './draft'
import type { Draft, EeatReport, Source } from './types'

const MD_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g

const normUrl = (u: string) => u.replace(/\/+$/, '').replace(/^http:\/\//, 'https://').toLowerCase()

const hostOf = (u: string) => {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' }
}

export interface LinkAudit {
  bodyMd: string
  citedUrls: string[] // unique source URLs actually cited in the text
  removed: string[] // hallucinated URLs stripped from the text
}

/**
 * Keep only links to known URLs (the run's sources + the brand's site).
 * A hallucinated link → its text stays, the URL is dropped.
 */
export function auditLinks(bodyMd: string, sources: Source[], siteUrl = ''): LinkAudit {
  const allowed = new Map(sources.map(s => [normUrl(s.url), s.url]))
  const brandHost = siteUrl ? hostOf(siteUrl) : ''
  const cited = new Set<string>()
  const removed: string[] = []
  const out = bodyMd.replace(MD_LINK, (whole, label: string, url: string) => {
    const norm = normUrl(url)
    if (allowed.has(norm)) {
      cited.add(allowed.get(norm)!)
      return whole
    }
    if (brandHost && hostOf(url) === brandHost) return whole // own site — allowed
    removed.push(url)
    return label // drop the link, keep the text
  })
  return { bodyMd: out, citedUrls: [...cited], removed }
}

/** Whether there's a lead: substantive text before the first '## ' (our direct answer for AEO). */
export function hasLead(bodyMd: string): boolean {
  const beforeH2 = bodyMd.split(/^## /m, 1)[0] ?? ''
  return beforeH2.replace(/^#[^\n]*\n/, '').trim().length >= 80
}

export function hasFaq(bodyMd: string): boolean {
  return hasFaqBlock(bodyMd)
}

/** "Sources" block built from actually-cited URLs (what the text vouches for). */
export function sourcesBlock(citedUrls: string[], sources: Source[], lang = 'ru'): string {
  if (!citedUrls.length) return ''
  const bySrc = new Map(sources.map(s => [s.url, s]))
  const lines = citedUrls.map((url) => {
    const s = bySrc.get(url)
    const meta = [s?.siteName, s?.publishedAt].filter(Boolean).join(', ')
    return `- [${s?.title || url}](${url})${meta ? ` — ${meta}` : ''}`
  })
  return `${pl(lang, '## Источники', '## Sources')}\n\n${lines.join('\n')}`
}

/** Remove an old "Sources" block (avoid duplicates on repeated gate runs); matches both languages. */
function stripSourcesBlock(bodyMd: string): string {
  return bodyMd.replace(/\n*^## (?:Источники|Sources)\s*$[\s\S]*?(?=^## |\s*$)/im, '\n').trimEnd()
}

export async function applyEeatGate(draft: Draft, sources: Source[], llm: LLM, s: AppSettings): Promise<Draft> {
  const minCitations = s.minCitations ?? 2
  const withFacts = sources.filter(src => src.facts?.length || src.keyPoints.length)
  let body = stripSourcesBlock(draft.bodyMd)
  let audit = auditLinks(body, sources, s.siteUrl)
  let fixApplied = false

  // citations below the minimum, but there's material for them → one fix pass
  if (audit.citedUrls.length < minCitations && withFacts.length && !llm.isMock) {
    const fixed = await weaveCitations(audit.bodyMd, withFacts, llm, s)
    if (fixed) {
      const reAudit = auditLinks(fixed, sources, s.siteUrl)
      // apply only if the link count actually went up (the LLM could have broken everything)
      if (reAudit.citedUrls.length > audit.citedUrls.length) {
        audit = reAudit
        fixApplied = true
      }
    }
  }

  body = audit.bodyMd
  const lead = hasLead(body)
  const faq = hasFaq(body)
  const block = sourcesBlock(audit.citedUrls, sources, s.language)
  if (block) body = `${body}\n\n${block}`

  const issues: string[] = []
  if (audit.removed.length) issues.push(`вырезаны выдуманные ссылки: ${audit.removed.length} (${audit.removed.slice(0, 3).join(', ')}${audit.removed.length > 3 ? '…' : ''})`)
  if (audit.citedUrls.length < minCitations) {
    issues.push(withFacts.length
      ? `цитирований ${audit.citedUrls.length} < ${minCitations} (fix-проход ${fixApplied ? 'помог частично' : 'не помог'})`
      : `цитирований ${audit.citedUrls.length} < ${minCitations}: у источников нет фактов — добери источники с данными`)
  }
  if (!lead) issues.push('нет лида с прямым ответом до первого H2')
  if (!faq) issues.push('нет блока FAQ')

  draft.bodyMd = body
  draft.eeat = {
    citations: audit.citedUrls.length,
    citedUrls: audit.citedUrls,
    removedLinks: audit.removed,
    hasLead: lead,
    hasFaq: faq,
    fixApplied,
    issues,
  }
  return draft
}

/** LLM pass: weave in links to sources wherever the text already uses their facts. */
async function weaveCitations(bodyMd: string, sources: Source[], llm: LLM, s: AppSettings): Promise<string> {
  const prompt = pl(
    s.language,
    'Ниже статья и список источников с их фактами. В статье слишком мало ссылок '
    + 'на источники. Найди места, где текст опирается на факты источников (цифры, '
    + 'данные, кейсы), и добавь туда markdown-ссылки вида [название источника](url). '
    + `Нужно минимум ${s.minCitations} ссылки. Правила:\n`
    + '- ссылайся ТОЛЬКО на URL из списка ниже, выдумывать URL запрещено;\n'
    + '- НЕ добавляй новых утверждений и цифр, НЕ переписывай текст — только вплетай ссылки;\n'
    + '- если для утверждения нет подходящего источника — не трогай его.\n'
    + 'Верни ПОЛНЫЙ текст статьи в markdown без преамбул.\n\n'
    + `ИСТОЧНИКИ:\n${sourcesContext(sources)}\n\n`
    + `СТАТЬЯ:\n${bodyMd}`,
    'Below is the article and a list of sources with their facts. The article has '
    + 'too few links to sources. Find places where the text relies on facts from the sources '
    + '(numbers, data, cases), and add markdown links there in the form [source name](url). '
    + `You need at least ${s.minCitations} links. Rules:\n`
    + '- link ONLY to URLs from the list below, making up URLs is forbidden;\n'
    + '- do NOT add new claims or numbers, do NOT rewrite the text — only weave in links;\n'
    + '- if there\'s no suitable source for a claim — leave it untouched.\n'
    + 'Return the FULL article text in markdown with no preamble.\n\n'
    + `SOURCES:\n${sourcesContext(sources)}\n\n`
    + `ARTICLE:\n${bodyMd}`,
  )
  try {
    const out = (await llm.complete(prompt, {
      system: pl(
        s.language,
        `Ты редактор блога ${s.brand}. Добавляешь атрибуцию фактов, не меняя текст. Язык: ${s.language}.`,
        `You are the editor of the ${s.brand} blog. You add fact attribution without changing the text. Language: ${s.language}.`,
      ),
      strong: true,
      maxTokens: Math.floor(bodyMd.length / 2) + 1500,
      temperature: 0.2,
    })).trim()
    // guard against degradation: the LLM must return text of comparable length
    return out.length > bodyMd.length * 0.7 ? normalizeDashes(out) : ''
  } catch {
    return '' // best-effort: the gate never fails the run
  }
}
