import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { cleanDomain } from '../public-api/clean-domain';
import { PROFILE_PLATFORMS } from './engines';
import { normalizeRunMeta, writeAnswers } from './run-job';
import type { SentimentEntry, SnapshotAnswer } from './run';

type JsonRecord = Record<string, unknown>;

interface SnapshotRun {
  prompts: unknown[];
  answers: SnapshotAnswer[];
  platforms: string[];
  competitors: string[];
  sentiment: Record<string, SentimentEntry> | null;
}

export interface NativeTrackerProvisioningResult {
  id: number;
  tracker_id: number;
  analysis_id: number;
  created: boolean;
  materialized_answers: number;
  status: 'done';
}

function record(value: unknown): JsonRecord | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown, limit = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list(value)) {
    const text = String(item ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function domains(value: unknown, ownDomain: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of strings(value)) {
    const domain = cleanDomain(item);
    if (
      !domain ||
      !domain.includes('.') ||
      domain === ownDomain ||
      seen.has(domain)
    ) {
      continue;
    }
    seen.add(domain);
    out.push(domain);
    if (out.length >= 8) break;
  }
  return out;
}

function snapshotAnswer(value: unknown): SnapshotAnswer | null {
  const row = record(value);
  if (!row) return null;
  const platform = String(row.platform ?? '').trim();
  const prompt = String(row.prompt ?? '').trim();
  if (!platform || !prompt || platform === '_sentiment') return null;

  const answer: SnapshotAnswer = {
    platform,
    prompt,
    text: String(row.text ?? row.raw_text ?? ''),
    citations: list(row.citations) as SnapshotAnswer['citations'],
    brands_found: list(row.brands_found) as SnapshotAnswer['brands_found'],
  };
  const judge = record(row.judge);
  if (judge)
    answer.judge = judge as unknown as NonNullable<SnapshotAnswer['judge']>;
  return answer;
}

function parseSnapshot(
  llmOutputs: unknown,
  ownDomain: string,
): SnapshotRun | null {
  const outputs = record(llmOutputs);
  const raw = record(outputs?.aeo_snapshot);
  if (!raw) return null;

  const answerMap = new Map<string, SnapshotAnswer>();
  for (const item of list(raw.answers)) {
    const answer = snapshotAnswer(item);
    if (!answer) continue;
    answerMap.set(`${answer.platform}\u0000${answer.prompt}`, answer);
  }

  const sentiment = record(raw.sentiment) as Record<
    string,
    SentimentEntry
  > | null;
  const answerPlatforms = [...answerMap.values()].map(
    (answer) => answer.platform,
  );
  return {
    prompts: list(raw.prompts),
    answers: [...answerMap.values()],
    platforms: strings(
      list(raw.platforms).length ? raw.platforms : answerPlatforms,
    ),
    competitors: domains(raw.competitors, ownDomain),
    sentiment,
  };
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

@Injectable()
export class AeoTrackerProvisioningService {
  constructor(private readonly prisma: PrismaService) {}

  /** Explicit native replacement for the legacy Python /internal/aeo/track. */
  async provisionForUser(input: {
    userId: number;
    domain?: string | null;
    analysisId?: unknown;
    competitors?: unknown;
  }): Promise<NativeTrackerProvisioningResult> {
    const hasAnalysisId =
      input.analysisId !== null && input.analysisId !== undefined;
    if (
      hasAnalysisId &&
      (typeof input.analysisId !== 'number' ||
        !Number.isInteger(input.analysisId) ||
        input.analysisId <= 0)
    ) {
      throw new BadRequestException('analysis_id must be a positive integer');
    }
    const analysisId = hasAnalysisId ? (input.analysisId as number) : null;
    const domain = cleanDomain(input.domain || '');
    if (input.domain && (!domain || !domain.includes('.'))) {
      throw new BadRequestException('invalid domain');
    }
    if (!domain && !analysisId) {
      throw new BadRequestException('domain or analysis_id required');
    }

    const analysis = analysisId
      ? await this.prisma.siteAnalysis.findFirst({
          where: { id: analysisId, userId: input.userId, status: 'done' },
        })
      : await this.prisma.siteAnalysis.findFirst({
          where: { userId: input.userId, domain, status: 'done' },
          orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
        });

    if (!analysis || (domain && cleanDomain(analysis.domain) !== domain)) {
      throw new NotFoundException('finished analysis not found');
    }

    const result = await this.materialize(analysis, input.competitors);
    if (!result) {
      throw new UnprocessableEntityException(
        'analysis has no completed AEO snapshot',
      );
    }
    return result;
  }

  /** Automatic completion/cache hook. System analyses without an owner are ignored. */
  async provisionFromAnalysis(
    analysisId: number,
  ): Promise<NativeTrackerProvisioningResult | null> {
    const analysis = await this.prisma.siteAnalysis.findUnique({
      where: { id: analysisId },
    });
    if (!analysis || analysis.status !== 'done' || !analysis.userId)
      return null;
    return this.materialize(analysis);
  }

  private async materialize(
    analysis: {
      id: number;
      userId: number | null;
      brandId: number | null;
      domain: string;
      geo: string;
      llmOutputs: unknown;
      createdAt: Date;
      finishedAt: Date | null;
    },
    competitorsOverride?: unknown,
  ): Promise<NativeTrackerProvisioningResult | null> {
    const userId = analysis.userId;
    const domain = cleanDomain(analysis.domain);
    if (!userId || !domain) return null;

    const snapshot = parseSnapshot(analysis.llmOutputs, domain);
    if (!snapshot || !snapshot.prompts.length || !snapshot.answers.length) {
      return null;
    }
    const runAt = analysis.finishedAt || analysis.createdAt;

    return this.prisma.$transaction(
      async (tx) => {
        // Two-key transaction lock makes find-or-create safe without imposing a
        // new unique constraint on databases that may contain legacy duplicates.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(${userId}::int, hashtext(${domain}))::text AS lock`;

        const brand = await tx.brand.findFirst({
          where: { userId, domain },
          orderBy: [{ isActive: 'desc' }, { id: 'desc' }],
        });
        const existing = await tx.aeoTracker.findFirst({
          where: { userId, domain },
          orderBy: [{ active: 'desc' }, { id: 'desc' }],
        });

        const overrideCompetitors =
          competitorsOverride === undefined
            ? []
            : domains(competitorsOverride, domain);
        const brandCompetitors = domains(brand?.competitors, domain);
        const fallbackCompetitors = domains(existing?.competitors, domain);
        const competitors = fallbackCompetitors.length
          ? fallbackCompetitors
          : overrideCompetitors.length
            ? overrideCompetitors
            : snapshot.competitors.length
              ? snapshot.competitors
              : brandCompetitors.length
                ? brandCompetitors
                : [];
        const prompts = hasItems(existing?.prompts)
          ? existing!.prompts
          : snapshot.prompts.length
            ? snapshot.prompts
            : [];
        const platforms = hasItems(existing?.platforms)
          ? existing!.platforms
          : snapshot.platforms.length
            ? snapshot.platforms
            : [];
        const geo = brand?.geo || analysis.geo || existing?.geo || 'us';
        const lang =
          brand?.language || existing?.lang || (geo === 'ru' ? 'ru' : 'en');
        const brandId =
          brand?.id || analysis.brandId || existing?.brandId || null;
        const trackerData = {
          brandId,
          competitors: competitors as unknown as Prisma.InputJsonValue,
          prompts: prompts as Prisma.InputJsonValue,
          platforms: platforms as Prisma.InputJsonValue,
          geo,
          lang,
          active: true,
        };

        const tracker = existing
          ? await tx.aeoTracker.update({
              where: { id: existing.id },
              data: trackerData,
            })
          : await tx.aeoTracker.create({
              data: { userId, domain, ...trackerData },
            });

        const rows = await tx.aeoAnswer.findMany({
          where: { trackerId: tracker.id, runAt },
          select: { platform: true, prompt: true },
        });
        const present = new Set(
          rows.map((row) => `${row.platform}\u0000${row.prompt}`),
        );
        const missing = snapshot.answers.filter(
          (answer) => !present.has(`${answer.platform}\u0000${answer.prompt}`),
        );
        const needsSentiment =
          !!snapshot.sentiment && !present.has('_sentiment\u0000');
        const materialized = await writeAnswers(
          tracker.id,
          runAt,
          missing,
          needsSentiment ? snapshot.sentiment : null,
          tx,
        );
        const runMeta = normalizeRunMeta(tracker.runMeta);
        const iso = runAt.toISOString();
        const snapshotPlatforms = new Set(snapshot.platforms);
        for (const profile of ['micro', 'mid', 'full', 'yandex']) {
          if (!PROFILE_PLATFORMS[profile]?.some((platform) => snapshotPlatforms.has(platform))) {
            continue;
          }
          const key = `${profile}_at`;
          const current = new Date(String(runMeta[key] || ''));
          if (Number.isNaN(current.getTime()) || current < runAt)
            runMeta[key] = iso;
        }
        await tx.aeoTracker.update({
          where: { id: tracker.id },
          data: {
            lastRunAt:
              tracker.lastRunAt && tracker.lastRunAt > runAt
                ? tracker.lastRunAt
                : runAt,
            runMeta: runMeta as Prisma.InputJsonValue,
          },
        });

        return {
          id: tracker.id,
          tracker_id: tracker.id,
          analysis_id: analysis.id,
          created: !existing,
          materialized_answers: materialized,
          status: 'done' as const,
        };
      },
      { timeout: 30_000 },
    );
  }
}
