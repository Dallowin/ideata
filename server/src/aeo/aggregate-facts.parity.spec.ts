/**
 * Parity of aggregate_facts / panel_only_block against the LIVE Python oracle
 * (startup_scraper.core.aeo). The golden was captured on synthetic data
 * (scratchpad/gen_fixtures.py) and lives in
 * _fixtures/aggregate-facts.golden.json — three snapshot runs (a rich one with
 * judge/sentiment/prompt_meta, a brand-never-mentioned one, an empty→{} one)
 * plus panel_only_block.
 *
 * This is a DIFFERENT shape than aggregate.parity.spec (a monitoring window):
 * a single snapshot, Estimated Impressions, visibility by intent, an inventory
 * of other pages' cited materials. Key gotchas kept under control:
 * est_impressions via meta_map (normalizing the prompt text with normPrompt
 * must match exactly, otherwise vol won't attach and the sum drifts), sort
 * orders (-count / -n,url / not-mentioned,pos), `... or None` collapsing an
 * empty value to null, banker's rounding.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { aggregateFacts, panelOnlyBlock, type FactAnswer } from './aggregate';

interface Case {
  name: string;
  answers: FactAnswer[];
  domain: string;
  competitors: string[];
  platforms: string[];
  sentiment: Record<string, { score: number; themes?: unknown }> | null;
  promptMeta: Record<string, { volume?: number | null; intent?: string | null; topic?: string | null }> | null;
  out: Record<string, unknown>;
}
interface Golden {
  cases: Case[];
  panelOnly: {
    panel: Array<Record<string, unknown>>;
    platforms: string[];
    note: string;
    out: Record<string, unknown>;
  };
}

const golden: Golden = JSON.parse(
  readFileSync(join(__dirname, '_fixtures', 'aggregate-facts.golden.json'), 'utf8'),
);

describe('aggregate_facts — run answers → AEO block (aeo.py:2386)', () => {
  it.each(golden.cases.map((c) => [c.name, c] as const))('case %s', (_name, c) => {
    const got = aggregateFacts(c.answers, c.domain, c.competitors, {
      platforms: c.platforms,
      sentiment: c.sentiment,
      promptMeta: c.promptMeta,
    });
    expect(got).toEqual(c.out);
  });
});

describe('panel_only_block — fail-soft with no engine answers (aeo.py:2538)', () => {
  it('shape matches aggregate_facts + aeoStatus/aeoStatusNote', () => {
    const { panel, platforms, note, out } = golden.panelOnly;
    expect(panelOnlyBlock(panel, platforms, { note })).toEqual(out);
  });
});
