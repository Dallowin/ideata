/**
 * Pipeline orchestrator. Interactive flow with pauses for user decisions:
 *
 *   research → [pause: pick sources] → outline → [pause: edit structure]
 *   → draft → anti-slop gate → factcheck → done
 *
 * Each phase reads its input from the DB (pending_input_json) and writes its
 * result back there — so a pause survives a server restart, and a failed phase
 * resumes from exactly the same spot. Auto mode runs straight through with no
 * pauses. (Store is now async/Prisma.)
 */
import { marked } from 'marked'
import { countWords, slopSummary } from '../../../shared/antislop/patterns'
import { resolveSettings } from '../appSettings'
import { ensureBrandVoice } from '../brandVoice'
import { chargeRunCredits } from '../credits'
import { sanitizeArticleHtml } from '../htmlSanitize'
import { LLM } from '../llm'
import { emitStage, finishRun, pauseRun, registerRun } from '../runRegistry'
import { fetchArticleFull } from '../search'
import { createRun, getRunRow, updateRun } from '../store'
import { applyGate } from './antislopGate'
import { authorityScore } from './authority'
import { writeDraft } from './draft'
import { applyEeatGate } from './eeatGate'
import { factcheck } from './factcheck'
import { buildOutline } from './outline'
import { perspectives as perspectivesStage } from './perspectives'
import { extractInsights, research as researchStage } from './research'
import type { Article, Outline, Source } from './types'

export type Phase = 'research' | 'outline' | 'draft'

const PHASE_DONE_STAGES: Record<Phase, string[]> = {
  research: [],
  outline: ['research', 'sources'],
  draft: ['research', 'sources', 'outline'],
}

/** `model` — model for this article ('' = the strong model from brand settings). */
export async function startRun(topic: string, targetQueries: string[] = [], mode = 'interactive', brandId?: number | null, model = ''): Promise<string> {
  const id = crypto.randomUUID()
  await createRun(id, topic, targetQueries, mode, brandId, model)
  void launchPhase(id, 'research')
  return id
}

/** Start/restart a phase. The phase's input comes from the run row in the DB. */
export async function launchPhase(id: string, phase: Phase): Promise<void> {
  const row = await getRunRow(id)
  if (!row) throw new Error(`run ${id} not found`)
  registerRun(id, row.topic, PHASE_DONE_STAGES[phase])
  await updateRun(id, { status: 'running', phase, error: '' })

  const runner = phase === 'research' ? researchPhase : phase === 'outline' ? outlinePhase : draftPhase
  const firstStage = phase === 'research' ? 'research' : phase
  void (async () => {
    // the brand doesn't have its own voice yet — build it from the site BEFORE
    // generation, so the article is written in this brand's voice, not a neutral default
    await ensureBrandVoice(row.brandId ?? 0, () =>
      emitStage(id, firstStage, 'running', 'составляем голос бренда по его сайту…'))
    await runner(id)
  })().catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    emitStage(id, phase === 'research' ? 'research' : phase, 'error', msg.slice(0, 200))
    await updateRun(id, { status: 'error', error: `[${phase}] ${msg}` })
    // model calls have already been paid for by us — charge the actual amount, not zero
    await chargeRunCredits(id)
    finishRun(id, 'error', `[${phase}] ${msg}`)
  })
}

const parse = (s: string, dflt: any) => { try { return s ? JSON.parse(s) : dflt } catch { return dflt } }

/**
 * Trimmed-down source for storage/UI. Text is kept up to 6000 characters: needed
 * by fact-check to verify quotes (previously trimmed to 1500 — numbers got lost
 * along the way). Facts and E-E-A-T metadata are never trimmed.
 */
function stripSource(s: Source): Source {
  return {
    url: s.url, title: s.title, text: s.text.slice(0, 6000), keyPoints: s.keyPoints,
    facts: s.facts, author: s.author, publishedAt: s.publishedAt, siteName: s.siteName,
    authority: s.authority, query: s.query, snippet: s.snippet, fetched: s.fetched,
  }
}

// --- Phase 1: research --------------------------------------------------------- //

async function researchPhase(id: string): Promise<void> {
  const row = (await getRunRow(id))!
  const s = await resolveSettings(row.brandId ?? 0, { modelStrong: row.model })
  const llm = new LLM({ ...s, usage: { ...s.usage, runId: id } })

  emitStage(id, 'research', 'running', llm.isMock ? 'mock-режим (без ключа) · генерим запросы…' : 'генерим поисковые запросы под тему…')
  // target AEO queries also go into the search fan-out: they need sources too
  const targetQueries = parse(row.queries_json, []) as string[]
  const { queries, sources } = await researchStage(row.topic, llm, s, targetQueries)
  const fetched = sources.filter(x => x.fetched)
  await updateRun(id, {
    sources_json: JSON.stringify(sources.map(stripSource)),
    search_queries_json: JSON.stringify(queries),
  })
  emitStage(id, 'research', 'done',
    `запросов: ${queries.length} · спарсено постов: ${fetched.length} (+${sources.length - fetched.length} кандидатов из выдачи)`)

  if (row.mode === 'auto' && !fetched.length && !llm.isMock) {
    // guard: writing an article "off the top of the head" with zero sources
    // is a filler generator; pause the run and let the owner add sources manually
    await updateRun(id, { status: 'awaiting_sources' })
    emitStage(id, 'sources', 'waiting', 'поиск не дал ни одного источника — добавь URL вручную')
    pauseRun(id, 'awaiting_sources')
  } else if (row.mode === 'auto') {
    emitStage(id, 'sources', 'done', `автовыбор: ${fetched.length} спарсенных`)
    await updateRun(id, {
      phase: 'outline',
      pending_input_json: JSON.stringify({ selectedUrls: fetched.map(x => x.url), extraUrls: [] }),
    })
    await outlinePhase(id)
  } else {
    await updateRun(id, { status: 'awaiting_sources' })
    emitStage(id, 'sources', 'waiting', 'выбери источники-референсы')
    pauseRun(id, 'awaiting_sources')
  }
}

// --- Phase 2: source selection → structure ------------------------------------- //

async function outlinePhase(id: string): Promise<void> {
  const row = (await getRunRow(id))!
  const s = await resolveSettings(row.brandId ?? 0, { modelStrong: row.model })
  const llm = new LLM({ ...s, usage: { ...s.usage, runId: id } })
  const payload = parse(row.pending_input_json, { selectedUrls: [], extraUrls: [] }) as
    { selectedUrls: string[], extraUrls: string[] }
  const all = parse(row.sources_json, []) as Source[]

  emitStage(id, 'sources', 'running', 'собираем выбранные источники…')
  const chosen = all.filter(src => payload.selectedUrls.includes(src.url))
  const sources: Source[] = []
  for (const src of chosen) {
    // a fetched source with key points — take it as-is
    if (src.fetched && src.text.length >= 200 && src.keyPoints.length) { sources.push(src); continue }
    // a candidate from search results — fetch the full text, key points and facts now
    emitStage(id, 'sources', 'running', `парсим ${src.title || src.url}…`)
    const art = src.text.length >= 200
      ? { text: src.text, author: src.author, publishedAt: src.publishedAt, siteName: src.siteName }
      : await fetchArticleFull(src.url, s.fetchTimeoutMs)
    if (!art.text || art.text.length < 200) {
      emitStage(id, 'sources', 'running', `не удалось спарсить ${src.url} — пропускаем`)
      continue
    }
    const full: Source = {
      ...src, text: art.text, author: art.author, publishedAt: art.publishedAt,
      siteName: art.siteName, authority: src.authority ?? authorityScore(src.url), fetched: true,
    }
    if (!full.keyPoints.length) {
      const ins = await extractInsights(row.topic, full, llm)
      full.keyPoints = ins.keyPoints
      full.facts = ins.facts
    }
    sources.push(stripSource(full))
  }
  for (const url of payload.extraUrls.slice(0, 6)) {
    if (sources.some(src => src.url === url)) continue
    const art = await fetchArticleFull(url, s.fetchTimeoutMs)
    if (!art.text || art.text.length < 200) {
      emitStage(id, 'sources', 'running', `не удалось спарсить ${url} — пропускаем`)
      continue
    }
    const src: Source = {
      url, title: url.replace(/^https?:\/\//, '').slice(0, 80), text: art.text, keyPoints: [],
      author: art.author, publishedAt: art.publishedAt, siteName: art.siteName,
      authority: authorityScore(url), fetched: true,
    }
    const ins = await extractInsights(row.topic, src, llm)
    src.keyPoints = ins.keyPoints
    src.facts = ins.facts
    sources.push(stripSource(src))
  }
  await updateRun(id, { sources_json: JSON.stringify(sources) })
  emitStage(id, 'sources', 'done', `выбрано: ${sources.length}`)

  emitStage(id, 'outline', 'running', 'ищем углы зрения…')
  const persps = await perspectivesStage(row.topic, sources, llm, s)
  emitStage(id, 'outline', 'running', `углы: ${persps.map(p => p.name).join(', ')} · строим структуру…`)
  const outline = await buildOutline(row.topic, sources, persps, llm, s, parse(row.queries_json, []))
  await updateRun(id, {
    outline_json: JSON.stringify(outline),
    perspectives_json: JSON.stringify(persps),
  })

  if (row.mode === 'auto') {
    emitStage(id, 'outline', 'done', `«${outline.title}» — секций ${outline.sections.length}`)
    await updateRun(id, { phase: 'draft' })
    await draftPhase(id)
  } else {
    await updateRun(id, { status: 'awaiting_outline' })
    emitStage(id, 'outline', 'waiting', `«${outline.title}» — проверь структуру и утверди`)
    pauseRun(id, 'awaiting_outline')
  }
}

// --- Phase 3: text → anti-slop → fact-check ------------------------------------- //

async function draftPhase(id: string): Promise<void> {
  const row = (await getRunRow(id))!
  const s = await resolveSettings(row.brandId ?? 0, { modelStrong: row.model })
  const llm = new LLM({ ...s, usage: { ...s.usage, runId: id } })
  const outline = parse(row.outline_json, null) as Outline | null
  if (!outline?.sections?.length) throw new Error('outline is empty — go back to the outline step')
  const sources = parse(row.sources_json, []) as Source[]

  emitStage(id, 'outline', 'done', `«${outline.title}» — секций ${outline.sections.length}`)
  emitStage(id, 'draft', 'running', 'пишем текст по секциям…')
  const targetQueries = parse(row.queries_json, []) as string[]
  // Section checkpointing: body_md fills up in the DB as sections complete, and on a
  // phase retry, completed sections (matched by heading from the outline) are reused
  // instead of regenerated — previously a restart rewrote ALL sections (duplicate ~24 RUB).
  let draft = await writeDraft(outline, sources, llm, s, (heading, i, total) => {
    emitStage(id, 'draft', 'running', `секция ${i + 1}/${total}: «${heading}»`)
  }, targetQueries, {
    resumeBodyMd: row.body_md,
    save: bodyMd => updateRun(id, { body_md: bodyMd }),
  })
  emitStage(id, 'draft', 'done', `черновик: ${countWords(draft.bodyMd)} слов`, {
    wordCount: countWords(draft.bodyMd),
  })

  emitStage(id, 'antislop', 'running', 'прогоняем анти-слоп гейт…')
  draft = await applyGate(draft, llm, s)
  emitStage(id, 'antislop', 'done', `${slopSummary(draft.slop!)} | переписываний: ${draft.rewrites}`, {
    slop: draft.slop!.score,
  })

  emitStage(id, 'eeat', 'running', 'E-E-A-T: проверяем ссылки и цитирования…')
  draft = await applyEeatGate(draft, sources, llm, s)
  const eeat = draft.eeat!
  emitStage(id, 'eeat', 'done',
    `цитирований: ${eeat.citations}${eeat.removedLinks.length ? ` · вырезано выдуманных ссылок: ${eeat.removedLinks.length}` : ''}`
    + `${eeat.issues.length ? ` · проблем: ${eeat.issues.length}` : ' · ок'}`)

  emitStage(id, 'factcheck', 'running', 'факт-чек…')
  const notes = await factcheck(draft.bodyMd, sources, llm, s)
  emitStage(id, 'factcheck', 'done', `замечаний: ${notes.length}`)

  const article: Article = {
    title: outline.title,
    bodyMd: draft.bodyMd,
    outline,
    sources,
    slop: draft.slop!,
    eeat,
    wordCount: countWords(draft.bodyMd),
    notes,
  }

  await updateRun(id, {
    status: 'done',
    title: article.title,
    body_md: article.bodyMd,
    // marked passes through raw HTML from markdown by default, and this markdown
    // came from a model that was fed third-party source pages: without the
    // sanitizer, a <script> prompt injection reaches the article body in the DB
    body_html: sanitizeArticleHtml(String(marked.parse(article.bodyMd))),
    slop_json: JSON.stringify(article.slop),
    eeat_json: JSON.stringify(article.eeat),
    notes_json: JSON.stringify(article.notes),
    word_count: article.wordCount,
    // byline: author from settings if the run doesn't have one set (E-E-A-T signal on the showcase)
    ...(row.author ? {} : s.author ? { author: s.author } : {}),
  })
  // credits are charged based on what was ACTUALLY spent on this run (sum of llm_usage)
  await chargeRunCredits(id)
  finishRun(id, 'done')
}
