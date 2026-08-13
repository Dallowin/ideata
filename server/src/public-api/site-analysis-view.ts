import type { SiteAnalysis } from '@prisma/client';

// Public view of a site_analyses row — matches the scrapper's _site_analysis_view
// contract (useAaApi/useAaMock expect it): snake_case, no cost/user_id.
export function siteAnalysisView(sa: SiteAnalysis) {
  return {
    id: sa.id,
    job_id: sa.jobId,
    domain: sa.domain,
    compare: sa.compareDomain,
    geo: sa.geo,
    status: sa.status,
    progress: sa.progress,
    facts: sa.facts,
    error: sa.errorText,
    created_at: sa.createdAt,
    finished_at: sa.finishedAt,
  };
}

// Lightweight "My analyses" list row (no facts) — matches the
// api_public_site_analytic_list contract.
export function siteAnalysisListItem(sa: SiteAnalysis) {
  return {
    id: sa.id,
    domain: sa.domain,
    compare: sa.compareDomain,
    geo: sa.geo,
    status: sa.status,
    created_at: sa.createdAt,
    finished_at: sa.finishedAt,
  };
}

// View for the token API v1 (_analysis_view in api_v1.py): additionally
// includes llm_outputs.
export function siteAnalysisV1View(sa: SiteAnalysis) {
  return {
    id: sa.id,
    domain: sa.domain,
    compare: sa.compareDomain,
    geo: sa.geo,
    status: sa.status,
    progress: sa.progress,
    facts: sa.facts,
    llm_outputs: sa.llmOutputs,
    error: sa.errorText,
    created_at: sa.createdAt,
    finished_at: sa.finishedAt,
  };
}
