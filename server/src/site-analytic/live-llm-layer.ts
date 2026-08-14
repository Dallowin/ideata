/**
 * The live LLM layer of the AI analytic (port of aa_agents.run_llm_layer +
 * _run_aeo_snapshot + content_guide, site_analytic.py:662-705) on top of the
 * native aeo/*. A gating wrapper:
 *   • runLlmLayer   -> aa-agents.runLlmLayer (FLASH clusters/plan + number guard);
 *   • runAeoSnapshot-> aeo-snapshot.runAeoSnapshotCore (AEO recon during analysis);
 *   • contentGuide  -> aa-agents.contentGuide (full AEO guide over the AI answers).
 *
 * The gates mirror Python: with no LLM key at all run_llm_layer returns an empty
 * merge (facts stay as they were after NORMALIZE) and the snapshot/guide return
 * null (site_analytic.py:696,731); AEO_SNAPSHOT=0 disables the snapshot separately.
 * Keys are read via getSettingKey (app_settings -> env, live admin override).
 * Providers/store are injected: in production askFlashJson + the Prisma store +
 * dataforseo.keyword_suggestions, in tests mocks (no live LLM/SERP/DB is used).
 */
import { Injectable } from '@nestjs/common';
import { askFlashJson } from '../aeo/run';
import { getSettingKey } from '../aeo/providers/settings';
import {
  runLlmLayer as aaRunLlmLayer,
  contentGuide as aaContentGuide,
  type AskJson,
} from './aa-agents';
import { runAeoSnapshotCore, type AeoSnapshotDeps } from './aeo-snapshot';
import type { AeoSnapshotResult, LlmLayer, LlmLayerOpts, LlmLayerResult } from './llm-layer';
import type { Facts, Raw } from './types';

/** LiveLlmLayer injections (the provider/store/gate seam for tests). */
export interface LiveLlmDeps {
  /** flash-JSON caller for the agents and the guide (askFlashJson by default). */
  askJson?: AskJson;
  /** the "is an LLM key available" gate (Anthropic or OpenRouter); app_settings->env by default. */
  llmKeyPresent?: () => Promise<boolean>;
  /** the AEO_SNAPSHOT gate (Python env; 0/false/no -> off). */
  aeoSnapshotEnabled?: () => Promise<boolean>;
  /** the snapshot provider/store seam (runSnapshot/generatePrompts/buildCompetitors/store…). */
  snapshot?: AeoSnapshotDeps;
}

@Injectable()
export class LiveLlmLayer implements LlmLayer {
  private readonly askJson: AskJson;
  private readonly llmKeyPresent: () => Promise<boolean>;
  private readonly aeoSnapshotEnabled: () => Promise<boolean>;
  private readonly snapshotDeps: AeoSnapshotDeps;

  constructor(deps: LiveLlmDeps = {}) {
    this.askJson = deps.askJson ?? askFlashJson;
    this.llmKeyPresent =
      deps.llmKeyPresent ??
      (async () =>
        !!(await getSettingKey('ANTHROPIC_API_KEY')) ||
        !!(await getSettingKey('OPENROUTER_API_KEY')));
    this.aeoSnapshotEnabled =
      deps.aeoSnapshotEnabled ??
      (async () => {
        const v = ((await getSettingKey('AEO_SNAPSHOT')) || '1').toLowerCase();
        return v !== '0' && v !== 'false' && v !== 'no';
      });
    // askJson is shared with the snapshot (buildCompetitors +
    // generatePrompts.deps.ask), but an explicit snapshot.askJson (test) wins.
    this.snapshotDeps = { askJson: this.askJson, ...deps.snapshot };
  }

  async runLlmLayer(facts: Facts, keywords: any[], opts: LlmLayerOpts): Promise<LlmLayerResult> {
    // Python: with no LLM key run_llm_layer -> {} (facts are left alone).
    if (!(await this.llmKeyPresent())) return { merge: {}, outputs: {} };
    const r = await aaRunLlmLayer(facts as unknown as Record<string, unknown>, keywords ?? [], {
      ask: this.askJson,
      progress: opts.progress,
    });
    return { merge: r.merge as Partial<Facts>, outputs: r.outputs };
  }

  async runAeoSnapshot(
    domain: string,
    facts: Facts,
    raw: Raw,
    opts: LlmLayerOpts,
  ): Promise<AeoSnapshotResult | null> {
    if (!(await this.llmKeyPresent())) return null;
    if (!(await this.aeoSnapshotEnabled())) return null;
    const res = await runAeoSnapshotCore(
      domain,
      facts,
      raw,
      { userId: opts.userId ?? null, lite: !!opts.lite, progress: opts.progress },
      this.snapshotDeps,
    );
    return {
      block: res.block as Partial<Facts>,
      run: res.run,
      competitors: res.competitors ?? null,
    };
  }

  async contentGuide(facts: Facts, opts: LlmLayerOpts): Promise<any | null> {
    // LLM key gate - as in run_site_analytic (site_analytic.py:696).
    if (!(await this.llmKeyPresent())) return null;
    return aaContentGuide(this.askJson, facts as unknown as Record<string, unknown>, opts.progress);
  }
}
