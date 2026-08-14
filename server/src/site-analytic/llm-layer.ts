/**
 * Contract of the analysis LLM layer (site_analytic.py:662-705). After NORMALIZE,
 * run_site_analytic merges three non-deterministic blocks into facts: the LLM
 * layer (clusters/plan/priorities - aa_agents.run_llm_layer), the AEO snapshot
 * (prompts x engines -> the AEO block + validated competitors + a monitoring
 * seed) and the full AEO guide (aa_agents.content_guide). This file holds ONLY
 * the interface and the composition points; the live implementation is
 * LiveLlmLayer (live-llm-layer.ts) on top of aa-agents/aeo-snapshot.
 *
 * NoopLlmLayer is the degradation to Python's behaviour with no LLM key:
 * run_llm_layer -> {}, no snapshot/guide; the same facts fields stay null while
 * the deterministic report is still complete.
 */
import { Injectable } from '@nestjs/common';
import type { Facts, Raw } from './types';

export interface LlmLayerOpts {
  userId?: number | null;
  lite?: boolean;
  progress?: (label: string) => void;
}

/** Result of run_llm_layer: what to merge into facts + the raw llm_outputs. */
export interface LlmLayerResult {
  merge: Partial<Facts>;
  outputs: Record<string, any>;
}

/** Result of the AEO snapshot (site_analytic.py:833-834, 910). */
export interface AeoSnapshotResult {
  block: Partial<Facts>;
  run?: any | null;
  competitors?: any[] | null;
}

export interface LlmLayer {
  /** aa_agents.run_llm_layer - clusters/thinCluster/priorities/plan. */
  runLlmLayer(facts: Facts, keywords: any[], opts: LlmLayerOpts): Promise<LlmLayerResult>;
  /** _run_aeo_snapshot - the AEO facts block + run + validated competitors. */
  runAeoSnapshot(domain: string, facts: Facts, raw: Raw, opts: LlmLayerOpts): Promise<AeoSnapshotResult | null>;
  /** aa_agents.content_guide - the full AEO guide over the real AI answers. */
  contentGuide(facts: Facts, opts: LlmLayerOpts): Promise<any | null>;
}

export const LLM_LAYER = Symbol('LLM_LAYER');

/**
 * No-op layer: the pipeline composes end to end, but the LLM fields stay null -
 * Python's behaviour with neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY
 * (run_llm_layer -> {}, no snapshot/guide).
 */
@Injectable()
export class NoopLlmLayer implements LlmLayer {
  async runLlmLayer(): Promise<LlmLayerResult> {
    return { merge: {}, outputs: {} };
  }
  async runAeoSnapshot(): Promise<AeoSnapshotResult | null> {
    return null;
  }
  async contentGuide(): Promise<any | null> {
    return null;
  }
}
