/**
 * AEO tracker mutations: the pure decision logic is PARITY-TESTED against live
 * Python (scrapper/web/services.py), Prisma/queue are mocked.
 *
 * The GOLDEN was captured by running production core/aeo.py + the extracted
 * pure part of services.mutate_aeo_prompts / set_aeo_competitors on the VPS
 * reference server (.venv/bin/python, AEO_PROMPTS not set) — see
 * scratchpad/oracle.py. Each `mut`/`np`/`comp`/`ps`/`pc` case is the verbatim
 * Python output, so the test is self-contained and doesn't SSH into the run.
 *
 * The money fixes ([$1] length cap, [$2] overall record-count cap, [$3] run
 * dedup) are checked in separate blocks — they didn't exist in Python, so no
 * reference is needed.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

// The queue is mocked: the tests don't spin up Redis/bullmq. enqueueRun is the
// only thing mutations.ts takes from queue.ts. The `mock`-prefixed name is a
// jest requirement for referencing it from the jest.mock factory (otherwise
// out-of-scope).
const mockEnqueueRun = jest.fn();
jest.mock('./queue/queue', () => ({
  enqueueRun: (...a: unknown[]) => mockEnqueueRun(...a),
}));

import {
  AeoMutationsService,
  mutatePanel,
  capPanel,
  sanitizePanel,
  normalizeCompetitors,
  parsePromptsLimit,
  MAX_PROMPT_LEN,
  MAX_TOPIC_LEN,
  type MutateArgs,
} from './mutations';
import { normalizePanel, promptStatus, promptCount, type PanelEntry } from './panel';

// ── GOLDEN (live Python) ──────────────────────────────────────────────────────

const ACT = { prompt: 'Active one' };
const SUG = { prompt: 'Suggested one', status: 'suggested', suggested_at: '2026-01-01T00:00:00' };
const INA = { prompt: 'Archived one', status: 'inactive' };

const GOLDEN = {
  np: {
    dedup_strings: [
      { prompt: 'Best CRM', topic: null, volume: null, intent: 'best', source: 'manual' },
      { prompt: 'Other', topic: null, volume: null, intent: 'use_case', source: 'manual' },
    ],
    rich: [
      {
        prompt: 'Best CRM for sales', topic: 'Sales', volume: 120, intent: 'best',
        source: 'generated', status: 'suggested', suggested_at: '2026-01-02T00:00:00',
      },
    ],
    empties: [],
    vol_bad: [{ prompt: 'vol test', topic: null, volume: null, intent: 'use_case', source: 'manual' }],
    vol_float_str: [{ prompt: 'vol2', topic: null, volume: null, intent: 'use_case', source: 'manual' }],
    topic_falsy: [{ prompt: 'tp', topic: null, volume: null, intent: 'use_case', source: 'manual' }],
  },
  ps: { suggested: 'suggested', inactive: 'inactive', string: 'active', empty_dict: 'active', bad: 'active' },
  pc: { pro: 50, free: 10, lite: 25, scale: 125, none: 50, unknown: 50, empty: 50 },
  mut: {
    add_new: { panel: [
      { prompt: 'Active one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'Fresh prompt', topic: 'Growth', volume: null, intent: 'use_case', source: 'manual' },
    ] },
    add_existing_suggested: { panel: [
      { prompt: 'Active one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'Suggested one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
    ] },
    add_over_quota: { __error__: { status: 409, error: 'quota', cap: 1 } },
    add_empty: { __error__: { status: 400, detail: 'text required' } },
    accept: { panel: [
      { prompt: 'Active one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'Suggested one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'Archived one', topic: null, volume: null, intent: 'use_case', source: 'manual', status: 'inactive' },
    ] },
    accept_over_quota: { __error__: { status: 409, error: 'quota', cap: 1 } },
    reject: { panel: [
      { prompt: 'Active one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'Archived one', topic: null, volume: null, intent: 'use_case', source: 'manual', status: 'inactive' },
    ] },
    archive: { panel: [
      { prompt: 'Active one', topic: null, volume: null, intent: 'use_case', source: 'manual', status: 'inactive' },
      { prompt: 'Suggested one', topic: null, volume: null, intent: 'use_case', source: 'manual', status: 'suggested', suggested_at: '2026-01-01T00:00:00' },
      { prompt: 'Archived one', topic: null, volume: null, intent: 'use_case', source: 'manual', status: 'inactive' },
    ] },
    reactivate: { panel: [
      { prompt: 'Active one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'Suggested one', topic: null, volume: null, intent: 'use_case', source: 'manual', status: 'suggested', suggested_at: '2026-01-01T00:00:00' },
      { prompt: 'Archived one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
    ] },
    reactivate_over_quota: { __error__: { status: 409, error: 'quota', cap: 1 } },
    delete: { panel: [
      { prompt: 'Active one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'Suggested one', topic: null, volume: null, intent: 'use_case', source: 'manual', status: 'suggested', suggested_at: '2026-01-01T00:00:00' },
    ] },
    set_topic: { panel: [
      { prompt: 'Active one', topic: 'Marketing', volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'Suggested one', topic: 'Marketing', volume: null, intent: 'use_case', source: 'manual', status: 'suggested', suggested_at: '2026-01-01T00:00:00' },
      { prompt: 'Archived one', topic: null, volume: null, intent: 'use_case', source: 'manual', status: 'inactive' },
    ] },
    set_topic_clear: { panel: [
      { prompt: 'p1', topic: null, volume: null, intent: 'use_case', source: 'manual' },
    ] },
    rename_topic: { panel: [
      { prompt: 'p1', topic: 'Revenue', volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'p2', topic: 'Revenue', volume: null, intent: 'use_case', source: 'manual' },
    ] },
    rename_topic_empty_new: { __error__: { status: 400, detail: 'new_topic required' } },
    rename_topic_no_src: { __error__: { status: 400, detail: 'topic required' } },
    rename_topic_too_long: { __error__: { status: 400, detail: 'new_topic too long' } },
    clear_topic: { panel: [
      { prompt: 'p1', topic: null, volume: null, intent: 'use_case', source: 'manual' },
      { prompt: 'p2', topic: 'Ops', volume: null, intent: 'use_case', source: 'manual' },
    ] },
    unknown_action: { __error__: { status: 400, detail: 'unknown action: frobnicate' } },
    add_dup_active_noquota: { panel: [
      { prompt: 'Active one', topic: null, volume: null, intent: 'use_case', source: 'manual' },
    ] },
  },
  comp: {
    basic: { competitors: ['a.com', 'b.com'] },
    cap10: { competitors: ['d0.com', 'd1.com', 'd2.com', 'd3.com', 'd4.com', 'd5.com', 'd6.com', 'd7.com', 'd8.com', 'd9.com'] },
    empty: { competitors: [] },
  },
} as const;

// [name, inputPanel, action, args, cap]
const MUT_CASES: Array<[keyof typeof GOLDEN.mut, unknown[], string, MutateArgs, number]> = [
  ['add_new', [ACT], 'add', { text: 'Fresh prompt', topic: 'Growth' }, 50],
  ['add_existing_suggested', [ACT, SUG], 'add', { text: 'Suggested one' }, 50],
  ['add_over_quota', [ACT], 'add', { text: 'Second active' }, 1],
  ['add_empty', [ACT], 'add', { text: '   ' }, 50],
  ['accept', [ACT, SUG, INA], 'accept', { texts: ['Suggested one'] }, 50],
  ['accept_over_quota', [ACT, SUG, INA], 'accept', { texts: ['Suggested one'] }, 1],
  ['reject', [ACT, SUG, INA], 'reject', { texts: ['Suggested one'] }, 50],
  ['archive', [ACT, SUG, INA], 'archive', { texts: ['Active one'] }, 50],
  ['reactivate', [ACT, SUG, INA], 'reactivate', { texts: ['Archived one'] }, 50],
  ['reactivate_over_quota', [ACT, SUG, INA], 'reactivate', { texts: ['Archived one'] }, 1],
  ['delete', [ACT, SUG, INA], 'delete', { texts: ['Archived one'] }, 50],
  ['set_topic', [ACT, SUG, INA], 'set_topic', { texts: ['Active one', 'Suggested one'], topic: '  Marketing ' }, 50],
  ['set_topic_clear', [{ prompt: 'p1', topic: 'Old' }], 'set_topic', { texts: ['p1'], topic: '' }, 50],
  ['rename_topic', [{ prompt: 'p1', topic: 'Sales' }, { prompt: 'p2', topic: 'sales' }], 'rename_topic', { topic: 'SALES', newTopic: 'Revenue' }, 50],
  ['rename_topic_empty_new', [{ prompt: 'p1', topic: 'Sales' }], 'rename_topic', { topic: 'Sales', newTopic: '  ' }, 50],
  ['rename_topic_no_src', [{ prompt: 'p1', topic: 'Sales' }], 'rename_topic', { topic: '  ', newTopic: 'Revenue' }, 50],
  ['rename_topic_too_long', [{ prompt: 'p1', topic: 'Sales' }], 'rename_topic', { topic: 'Sales', newTopic: 'R'.repeat(61) }, 50],
  ['clear_topic', [{ prompt: 'p1', topic: 'Sales' }, { prompt: 'p2', topic: 'Ops' }], 'clear_topic', { topic: 'sales' }, 50],
  ['unknown_action', [ACT, SUG, INA], 'frobnicate', {}, 50],
  ['add_dup_active_noquota', [ACT], 'add', { text: 'Active one' }, 1],
];

function expectHttp(fn: () => unknown, status: number): HttpException {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(status);
    return e as HttpException;
  }
  throw new Error(`expected HttpException(${status}), got none`);
}

// ── pure decision logic: parity with Python ──────────────────────────────────

describe('mutatePanel — parity with mutate_aeo_prompts decision logic (services.py:771)', () => {
  it.each(MUT_CASES)('%s', (name, input, action, args, cap) => {
    const g = GOLDEN.mut[name] as { panel?: PanelEntry[]; __error__?: { status: number; detail?: string; error?: string; cap?: number } };
    if (g.__error__) {
      const err = expectHttp(() => mutatePanel(input, action, args, cap), g.__error__.status);
      const body = err.getResponse();
      if (g.__error__.error === 'quota') {
        expect(body).toEqual({ error: 'quota', cap: g.__error__.cap });
      } else {
        expect((body as { message: string }).message).toBe(g.__error__.detail);
      }
    } else {
      expect(mutatePanel(input, action, args, cap)).toEqual(g.panel);
    }
  });

  it('adding an already-active prompt is a no-op and does NOT touch the quota (cap=1)', () => {
    // add_dup_active_noquota: active already exists → the "status != active"
    // branch isn't taken, _quota is NOT called, the panel is unchanged
    // (important: not a 409).
    expect(mutatePanel([ACT], 'add', { text: 'Active one' }, 1)).toEqual(GOLDEN.mut.add_dup_active_noquota.panel);
  });

  it('input is not mutated (fresh copies inside)', () => {
    const input = [{ prompt: 'Active one' }];
    mutatePanel(input, 'archive', { texts: ['Active one'] }, 50);
    expect(input).toEqual([{ prompt: 'Active one' }]); // no status:inactive
  });
});

describe('normalizePanel / promptStatus / promptCount — parity (panel.ts)', () => {
  it('normalize_panel goldens', () => {
    expect(normalizePanel(['Best CRM', 'best crm', '  BEST   crm ', 'Other'])).toEqual(GOLDEN.np.dedup_strings);
    expect(normalizePanel([{ prompt: 'Best CRM for sales', topic: '  Sales  ', volume: '120', source: 'generated', status: 'suggested', suggested_at: '2026-01-02T00:00:00' }])).toEqual(GOLDEN.np.rich);
    expect(normalizePanel(['  ', '', null, { prompt: '  ' }])).toEqual(GOLDEN.np.empties);
    expect(normalizePanel([{ prompt: 'vol test', volume: 'abc' }])).toEqual(GOLDEN.np.vol_bad);
    expect(normalizePanel([{ prompt: 'vol2', volume: '5.0' }])).toEqual(GOLDEN.np.vol_float_str);
    expect(normalizePanel([{ prompt: 'tp', topic: 0 }])).toEqual(GOLDEN.np.topic_falsy);
  });
  it('prompt_status goldens', () => {
    expect(promptStatus({ status: 'suggested' })).toBe(GOLDEN.ps.suggested);
    expect(promptStatus({ status: 'inactive' })).toBe(GOLDEN.ps.inactive);
    expect(promptStatus('hello')).toBe(GOLDEN.ps.string);
    expect(promptStatus({})).toBe(GOLDEN.ps.empty_dict);
    expect(promptStatus({ status: 'nope' })).toBe(GOLDEN.ps.bad);
  });
  it('prompt_count goldens (AEO_PROMPTS not set)', () => {
    expect(promptCount('pro', null)).toBe(GOLDEN.pc.pro);
    expect(promptCount('free', null)).toBe(GOLDEN.pc.free);
    expect(promptCount('lite', null)).toBe(GOLDEN.pc.lite);
    expect(promptCount('scale', null)).toBe(GOLDEN.pc.scale);
    expect(promptCount(null, null)).toBe(GOLDEN.pc.none);
    expect(promptCount('enterprise', null)).toBe(GOLDEN.pc.unknown);
    expect(promptCount('', null)).toBe(GOLDEN.pc.empty);
  });
});

describe('normalizeCompetitors — parity with set_aeo_competitors (services.py:557)', () => {
  it('cleanup/dedup/own domain/cap of 10', () => {
    expect(normalizeCompetitors(['A.com', 'https://www.B.com/path', 'a.com', 'selfd.com', ''], 'www.selfd.com')).toEqual(GOLDEN.comp.basic.competitors);
    expect(normalizeCompetitors(Array.from({ length: 13 }, (_, i) => `d${i}.com`), 'self.com')).toEqual(GOLDEN.comp.cap10.competitors);
    expect(normalizeCompetitors([], 'self.com')).toEqual(GOLDEN.comp.empty.competitors);
  });
  it('not a list → 400', () => {
    const err = expectHttp(() => normalizeCompetitors('nope', 'self.com'), 400);
    expect((err.getResponse() as { message: string }).message).toBe('competitors must be a list');
  });
});

describe('parsePromptsLimit — parity with set_aeo_prompts_limit (services.py:596)', () => {
  it('None → null; clamp [5,cap]; invalid → 400', () => {
    expect(parsePromptsLimit(null, 50)).toBeNull();
    expect(parsePromptsLimit(undefined, 50)).toBeNull();
    expect(parsePromptsLimit(40, 50)).toBe(40);
    expect(parsePromptsLimit(999, 50)).toBe(50); // min(cap)
    expect(parsePromptsLimit(3, 50)).toBe(5); // max(5)
    expect(parsePromptsLimit(true, 50)).toBe(5); // int(True)=1 → max(5,1)=5
    expect(parsePromptsLimit('12', 50)).toBe(12);
    expectHttp(() => parsePromptsLimit('5.0', 50), 400); // int("5.0") ValueError
    expectHttp(() => parsePromptsLimit({}, 50), 400);
    expectHttp(() => parsePromptsLimit('abc', 50), 400);
  });
});

// ── [$1] money length cap ─────────────────────────────────────────────────────

describe('[$1] capPanel — record length cap (not in Python)', () => {
  it('prompt is trimmed to 300, topic to 60 code points', () => {
    const [e] = capPanel(normalizePanel([{ prompt: 'x'.repeat(500), topic: 'y'.repeat(200) }]));
    expect(Array.from(e.prompt).length).toBe(MAX_PROMPT_LEN);
    expect(Array.from(e.topic as string).length).toBe(MAX_TOPIC_LEN);
  });
  it('trimming collapses different long prompts into one key (re-dedup)', () => {
    // 'a'×320 and 'a'×310 — different texts (normalize into 2 records), but both → 300 'a'.
    const out = capPanel(normalizePanel([{ prompt: 'a'.repeat(320) }, { prompt: 'a'.repeat(310) }]));
    expect(out.length).toBe(1);
    expect(Array.from(out[0].prompt).length).toBe(MAX_PROMPT_LEN);
  });
  it('short records are unchanged — sanitizePanel == normalizePanel', () => {
    const input = [{ prompt: 'Best CRM for sales', topic: 'Sales' }, 'plain'];
    expect(sanitizePanel(input)).toEqual(normalizePanel(input));
  });
});

// ── service (Prisma/queue are mocked) ─────────────────────────────────────────

interface Mocks {
  svc: AeoMutationsService;
  prisma: {
    aeoTracker: { findUnique: jest.Mock; update: jest.Mock };
    user: { findUnique: jest.Mock };
    $queryRawUnsafe: jest.Mock;
  };
  plans: { resolveLimits: jest.Mock };
  aeoRead: { assertCanMutate: jest.Mock; effectivePlan: jest.Mock; readAeoPromptsSetting: jest.Mock };
}

function makeService(tracker: unknown = { id: 1, userId: 7, domain: 'brand.com', prompts: null }): Mocks {
  const prisma = {
    aeoTracker: {
      findUnique: jest.fn().mockResolvedValue(tracker),
      update: jest.fn().mockResolvedValue({}),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ isAdmin: false }) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ n: 0 }]),
  };
  const plans = { resolveLimits: jest.fn().mockResolvedValue({ prompts: 50, title: 'Бестселлер' }) };
  const aeoRead = {
    assertCanMutate: jest.fn().mockResolvedValue(undefined),
    effectivePlan: jest.fn().mockResolvedValue('pro'),
    readAeoPromptsSetting: jest.fn().mockResolvedValue(null),
  };
  // dfs/keysso are only needed by the constructor for suggestAeoPrompts (not tested here).
  const dfs = {
    domainKeywords: jest.fn().mockResolvedValue([]),
    keywordSuggestions: jest.fn().mockResolvedValue(null),
  };
  const keysso = { domainKeywords: jest.fn().mockResolvedValue([]) };
  const svc = new AeoMutationsService(
    prisma as never,
    plans as never,
    aeoRead as never,
    dfs as never,
    keysso as never,
  );
  return { svc, prisma, plans, aeoRead };
}

beforeEach(() => {
  mockEnqueueRun.mockReset();
  mockEnqueueRun.mockResolvedValue({ scrapeJobId: 99, enqueued: true });
});

describe('AeoMutationsService.setAeoPrompts', () => {
  it('happy: writes the canon panel, enqueues a run, {id, prompts, job_id}', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.setAeoPrompts(1, ['Best CRM', 'best crm', 'Other'], 7);
    expect(res).toEqual({ id: 1, prompts: GOLDEN.np.dedup_strings, job_id: 99 });
    expect(prisma.aeoTracker.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { prompts: GOLDEN.np.dedup_strings },
    });
    expect(mockEnqueueRun).toHaveBeenCalledTimes(1);
    expect(mockEnqueueRun).toHaveBeenCalledWith({ trackerId: 1, domain: 'brand.com', userId: 7, source: 'manual' });
  });

  it('empty panel → 400 prompts required', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setAeoPrompts(1, ['  ', ''], 7)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.aeoTracker.update).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('[$1] a long prompt is trimmed to 300 before writing', async () => {
    const { svc, prisma } = makeService();
    await svc.setAeoPrompts(1, [{ prompt: 'z'.repeat(1000) }], 7);
    const written = prisma.aeoTracker.update.mock.calls[0][0].data.prompts as PanelEntry[];
    expect(Array.from(written[0].prompt).length).toBe(MAX_PROMPT_LEN);
  });

  it('[$2] suggested does NOT bypass the overall 3×pool cap → 400, no run is enqueued', async () => {
    const { svc, prisma, plans } = makeService();
    plans.resolveLimits.mockResolvedValue({ prompts: 10, title: 'Free' }); // pool 10 → cap 30
    const many = Array.from({ length: 31 }, (_, i) => ({ prompt: `p${i}`, status: 'suggested' }));
    await expect(svc.setAeoPrompts(1, many, 7)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.aeoTracker.update).not.toHaveBeenCalled();
    expect(mockEnqueueRun).not.toHaveBeenCalled();
  });

  it('active quota: active_new + others > cap → 402', async () => {
    const { svc, plans, prisma } = makeService();
    plans.resolveLimits.mockResolvedValue({ prompts: 3, title: 'Старт' });
    prisma.$queryRawUnsafe.mockResolvedValue([{ n: 2 }]); // 2 active in other trackers
    const err = await svc.setAeoPrompts(1, ['a', 'b'], 7).catch((e) => e); // 2 + 2 > 3
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(402);
    expect(prisma.aeoTracker.update).not.toHaveBeenCalled();
  });

  it('[$3] an active job (enqueued=false) → NOT a second run, returns the existing job_id WITHOUT an error', async () => {
    const { svc, prisma } = makeService();
    mockEnqueueRun.mockResolvedValue({ scrapeJobId: 77, enqueued: false });
    const res = await svc.setAeoPrompts(1, ['a'], 7);
    expect(res.job_id).toBe(77); // rode along on the active run, didn't spawn a new one
    expect(prisma.aeoTracker.update).toHaveBeenCalledTimes(1); // panel was updated
    expect(mockEnqueueRun).toHaveBeenCalledTimes(1);
  });

  it('no tracker → 404; viewer → 403 (gate before the write)', async () => {
    const missing = makeService(null);
    await expect(missing.svc.setAeoPrompts(1, ['a'], 7)).rejects.toBeInstanceOf(NotFoundException);

    const viewer = makeService();
    viewer.aeoRead.assertCanMutate.mockRejectedValue(new ForbiddenException('viewer'));
    await expect(viewer.svc.setAeoPrompts(1, ['a'], 7)).rejects.toBeInstanceOf(ForbiddenException);
    expect(viewer.prisma.aeoTracker.update).not.toHaveBeenCalled();
  });
});

describe('AeoMutationsService.refreshAeoTracker', () => {
  it('happy: enqueues a run for the owner, 202 {status:queued, job_id}', async () => {
    const { svc, prisma } = makeService();
    const res = await svc.refreshAeoTracker(1, 7);
    expect(res).toEqual({ status: 'queued', job_id: 99 });
    expect(mockEnqueueRun).toHaveBeenCalledWith({ trackerId: 1, domain: 'brand.com', userId: 7, source: 'manual' });
    expect(prisma.aeoTracker.update).not.toHaveBeenCalled(); // refresh doesn't write the panel
  });

  it('[$3] active job → 409 {status:running}, no second run is enqueued', async () => {
    const { svc } = makeService();
    mockEnqueueRun.mockResolvedValue({ scrapeJobId: 5, enqueued: false });
    const err = await svc.refreshAeoTracker(1, 7).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toEqual({ status: 'running' });
    expect(mockEnqueueRun).toHaveBeenCalledTimes(1); // exactly one attempt, no dupe
  });
});

describe('AeoMutationsService.setAeoCompetitors', () => {
  it('cleans the list, writes it, {id, competitors}', async () => {
    const { svc, prisma } = makeService({ id: 1, userId: 7, domain: 'selfd.com', prompts: null });
    const res = await svc.setAeoCompetitors(1, ['A.com', 'a.com', 'selfd.com', 'b.com'], 7);
    expect(res).toEqual({ id: 1, competitors: ['a.com', 'b.com'] });
    expect(prisma.aeoTracker.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { competitors: ['a.com', 'b.com'] } });
  });
  it('not a list → 400', async () => {
    const { svc } = makeService();
    await expect(svc.setAeoCompetitors(1, 'nope', 7)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AeoMutationsService.setAeoPromptsLimit', () => {
  it('null → plan cap; a number gets clamped; {id, promptsLimit, promptCap}', async () => {
    const { svc, prisma } = makeService(); // effectivePlan=pro → cap=50
    expect(await svc.setAeoPromptsLimit(1, null, 7)).toEqual({ id: 1, promptsLimit: null, promptCap: 50 });
    expect(await svc.setAeoPromptsLimit(1, 999, 7)).toEqual({ id: 1, promptsLimit: 50, promptCap: 50 });
    expect(await svc.setAeoPromptsLimit(1, 30, 7)).toEqual({ id: 1, promptsLimit: 30, promptCap: 50 });
    expect(prisma.aeoTracker.update).toHaveBeenLastCalledWith({ where: { id: 1 }, data: { promptsLimit: 30 } });
  });
  it('invalid integer → 400', async () => {
    const { svc } = makeService();
    await expect(svc.setAeoPromptsLimit(1, '5.5', 7)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AeoMutationsService.mutateAeoPrompts', () => {
  it('happy add: cap = pool_left, writes the panel, {ok, panel}', async () => {
    const { svc, prisma } = makeService({ id: 1, userId: 7, domain: 'b.com', prompts: [{ prompt: 'Active one' }] });
    const res = await svc.mutateAeoPrompts(1, 'add', { text: 'Fresh prompt', topic: 'Growth' }, 7);
    expect(res).toEqual({ ok: true, panel: GOLDEN.mut.add_new.panel });
    expect(prisma.aeoTracker.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { prompts: GOLDEN.mut.add_new.panel } });
  });

  it('unknown action → 400 BEFORE the owner gate', async () => {
    const { svc, aeoRead, prisma } = makeService();
    await expect(svc.mutateAeoPrompts(1, 'frobnicate', {}, 7)).rejects.toBeInstanceOf(BadRequestException);
    expect(aeoRead.assertCanMutate).not.toHaveBeenCalled(); // the tracker isn't even loaded
    expect(prisma.aeoTracker.update).not.toHaveBeenCalled();
  });

  it('quota (pool_left) → 409 {error:quota, cap}, the panel is not written', async () => {
    const { svc, plans, prisma } = makeService({ id: 1, userId: 7, domain: 'b.com', prompts: [{ prompt: 'Active one' }] });
    plans.resolveLimits.mockResolvedValue({ prompts: 1, title: 'Free' }); // pool_left = 1 - used(0) = 1
    const err = await svc.mutateAeoPrompts(1, 'add', { text: 'Second' }, 7).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({ error: 'quota', cap: 1 });
    expect(prisma.aeoTracker.update).not.toHaveBeenCalled();
  });

  it('[$1] long text in add is trimmed to 300 before writing', async () => {
    const { svc, prisma } = makeService({ id: 1, userId: 7, domain: 'b.com', prompts: [] });
    await svc.mutateAeoPrompts(1, 'add', { text: 'q'.repeat(600) }, 7);
    const written = prisma.aeoTracker.update.mock.calls[0][0].data.prompts as PanelEntry[];
    expect(Array.from(written[0].prompt).length).toBe(MAX_PROMPT_LEN);
  });
});
