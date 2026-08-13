/**
 * Deterministic suppression of em-dash "—" overuse — WITHOUT a model, ALWAYS.
 *
 * Why deterministic instead of an LLM gate: the dash is a deeply ingrained habit
 * of the model (especially Claude). Asking the same model to remove its own dashes is pointless —
 * the antislop gate proved this (dash overuse didn't clear the threshold and wasn't fixed).
 * So we cut it mechanically and always, before and after any LLM stages.
 *
 * What we do NOT touch (grammatically correct dashes in Russian):
 *  - a dash at the START of a line — a dialogue line / list item / quote ("— item");
 *  - the "— is …" construction (subject — predicate): "Provably fair — is …";
 *  - a dash WITHOUT spaces — ranges "5–10", compounds "из-за", "то-то".
 * Everything else (an inserted-clause dash "word — insert — word" and a pause dash) is changed to
 * a comma: grammatically neutral and kills the main visual "slop".
 *
 * Markdown code blocks and inline code are protected with placeholders — examples aren't broken.
 * The function is IDEMPOTENT: a repeat run changes nothing.
 */

// internal markers (control characters) — don't occur in normal text
const KEEP = String.fromCharCode(1) // "leave this dash alone" → restored as "—"
const CODE = String.fromCharCode(2) // boundary of stripped-out code

export function normalizeDashes(input: string): string {
  if (input.indexOf('—') < 0 && input.indexOf('–') < 0 && input.indexOf('--') < 0) return input

  // 1) pull out code (fenced + inline) so we don't touch dashes in examples
  const code: string[] = []
  let s = input.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, (m) => {
    code.push(m)
    return `${CODE}${code.length - 1}${CODE}`
  })

  // 2) line by line — respect a leading dash (dialogue/list/quote)
  s = s.split('\n').map((line) => {
    let l = line
    // leading dash of a line: mark the character itself, keep the space after it
    l = l.replace(/^(\s*(?:>\s*)?)[—–](?=\s)/u, `$1${KEEP}`)
    // "— is …" construction: mark the character, keep it as a dash
    l = l.replace(/[—–](?=\s+это(?![\p{L}]))/giu, KEEP)
    // remaining inserted-clause/pause dash with spaces (em "—", en "–", ascii "--") → comma;
    // but if there's already an end/pause punctuation mark to the left (.?!…,:;») — just drop the dash into a space,
    // to avoid producing "?," / ",,"
    l = l.replace(/(\S)\s+(?:—|–|--)\s+/gu, (_, prev: string) =>
      /[.!?…,:;»)]/u.test(prev) ? `${prev} ` : `${prev}, `)
    return l
  }).join('\n')

  // 3) restore protected dashes
  s = s.split(KEEP).join('—')

  // 4) light cleanup of punctuation artifacts left by the replacements
  s = s
    .replace(/ +,/g, ',') // space before a comma
    .replace(/,\s*,/g, ',') // double comma
    .replace(/,(\s*[.!?;:)])/g, '$1') // comma before a closing punctuation mark

  // 5) restore code
  s = s.replace(new RegExp(`${CODE}(\\d+)${CODE}`, 'gu'), (_, i) => code[Number(i)])
  return s
}

/** Dash density per 1000 words — for metrics/linter (unicode words). */
export function dashDensity(text: string): number {
  const dashes = (text.match(/—/g) || []).length
  const words = Math.max(1, (text.match(/[\p{L}\p{N}_]+/gu) || []).length)
  return Math.round((dashes / words) * 1000 * 10) / 10
}
