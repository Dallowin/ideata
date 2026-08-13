/**
 * Building a tracker's report from the DB (buildWeeklyReport), weekly idempotency
 * (report_log), and delivery (runWeeklyReports/sendUserReports). blogPrisma is
 * mocked (DB untouched), mail is an injectable mock transport (network untouched).
 * Gates: REPORTS_ENABLED, plan (channelsFor), "once a week" (reportAlreadySent).
 */
const mockPrisma = {
  aeoAnswer: { findMany: jest.fn() },
  brand: { findUnique: jest.fn() },
  reportLog: { findFirst: jest.fn(), upsert: jest.fn() },
  user: { findUnique: jest.fn() },
  aeoTracker: { findMany: jest.fn() },
};
jest.mock('../blogwriter/server/utils/prisma', () => ({
  blogPrisma: () => mockPrisma,
  setBlogPrisma: jest.fn(),
}));

import {
  buildWeeklyReport,
  reportAlreadySent,
  markReportSent,
  sendUserReports,
  runWeeklyReports,
  weekKey,
  type WeeklyReportTracker,
} from './reports';
import type { MailTransport, MailMessage, MailResult } from './mail';

const NOW = new Date(Date.UTC(2026, 7, 10, 12, 0, 0)); // 2026-08-10, ISO week 33
const WK = weekKey(NOW);

/** Window answers: 2 runs in the last week, brand acme.com is mentioned. */
function windowRows() {
  return [
    { runAt: new Date(Date.UTC(2026, 7, 5, 6, 0)), platform: 'claude', prompt: 'p1', rawText: 'a', brandsFound: [{ brand: 'acme.com', pos: 1 }], citations: [{ url: 'https://acme.com/x' }], sentiment: null, judge: null },
    { runAt: new Date(Date.UTC(2026, 7, 5, 6, 0)), platform: 'claude', prompt: 'p2', rawText: 'b', brandsFound: [], citations: [{ url: 'https://rival.com/y' }], sentiment: null, judge: null },
    { runAt: new Date(Date.UTC(2026, 7, 9, 6, 0)), platform: 'claude', prompt: 'p1', rawText: 'c', brandsFound: [{ brand: 'acme.com', pos: 1 }], citations: [{ url: 'https://acme.com/x' }, { url: 'https://other.com/z' }], sentiment: null, judge: null },
  ];
}

const TRACKER: WeeklyReportTracker = {
  id: 7,
  domain: 'acme.com',
  competitors: ['rival.com'],
  platforms: null,
  brandId: 3,
  lang: null,
  runMeta: null,
};

/** Mock mail transport: counts successful sends, sends nothing. */
function okTransport(): { transport: MailTransport; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  const rec = async (msg: MailMessage): Promise<MailResult> => {
    sent.push(msg);
    return { sent: true };
  };
  return { sent, transport: { resend: rec, brevo: rec, smtp: rec } };
}

const MAIL_KEYS = ['MAIL_DRIVER', 'RESEND_API_KEY', 'REPORTS_ENABLED', 'REPORTS_DASHBOARD_URL'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  jest.clearAllMocks();
  saved = {};
  for (const k of MAIL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Mail is configured by default (resend) — so we reach the transport.
  process.env.RESEND_API_KEY = 'k';
});
afterEach(() => {
  for (const k of MAIL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('buildWeeklyReport — building a tracker report', () => {
  it('window with runs → report: domain, week, brand language, 7-day citations', async () => {
    mockPrisma.aeoAnswer.findMany.mockResolvedValue(windowRows());
    mockPrisma.brand.findUnique.mockResolvedValue({ language: 'en' });

    const r = await buildWeeklyReport(TRACKER, { now: NOW, dashUrl: 'https://ideata.io/app' });
    expect(r).not.toBeNull();
    expect(r!.domain).toBe('acme.com');
    expect(r!.weekLabel).toBe(WK);
    expect(r!.lang).toBe('en'); // brands.language = en
    // week's citations: acme/x, rival/y, acme/x, other/z → 4 urls, 3 hosts
    expect(r!.newCitations).toBe(4);
    expect(r!.newSources).toBe(3);
    expect(r!.subject).toBe('Ideata: weekly report for acme.com');
    expect(r!.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(r!.html).toContain('<html lang="en"');
    // the window was read over 8 weeks, sorted by runAt asc
    expect(mockPrisma.aeoAnswer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ trackerId: 7 }), orderBy: { runAt: 'asc' } }),
    );
  });

  it('empty window (no answers) → null (report not sent)', async () => {
    mockPrisma.aeoAnswer.findMany.mockResolvedValue([]);
    const r = await buildWeeklyReport(TRACKER, { now: NOW });
    expect(r).toBeNull();
  });

  it('language: brands.language missing → tracker.lang → ru (fallback)', async () => {
    mockPrisma.aeoAnswer.findMany.mockResolvedValue(windowRows());
    mockPrisma.brand.findUnique.mockResolvedValue({ language: null });
    const r = await buildWeeklyReport({ ...TRACKER, lang: 'ru' }, { now: NOW });
    expect(r!.lang).toBe('ru');
  });

  it('brand.findUnique throws → language ru, report still built', async () => {
    mockPrisma.aeoAnswer.findMany.mockResolvedValue(windowRows());
    mockPrisma.brand.findUnique.mockRejectedValue(new Error('db'));
    const r = await buildWeeklyReport({ ...TRACKER, lang: null }, { now: NOW });
    expect(r).not.toBeNull();
    expect(r!.lang).toBe('ru');
  });
});

describe('weekly idempotency — report_log', () => {
  it('reportAlreadySent: ok=TRUE row → true; none → false; throw → false', async () => {
    mockPrisma.reportLog.findFirst.mockResolvedValueOnce({ id: 1 });
    expect(await reportAlreadySent(1, 'email', WK)).toBe(true);
    // filter is strictly ok:true (a failed attempt does not block a retry)
    expect(mockPrisma.reportLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 1, kind: 'email', weekKey: WK, ok: true } }),
    );
    mockPrisma.reportLog.findFirst.mockResolvedValueOnce(null);
    expect(await reportAlreadySent(1, 'email', WK)).toBe(false);
    mockPrisma.reportLog.findFirst.mockRejectedValueOnce(new Error('no table'));
    expect(await reportAlreadySent(1, 'email', WK)).toBe(false);
  });

  it('markReportSent: upserts on (userId,kind,weekKey); detail truncated to 500', async () => {
    mockPrisma.reportLog.upsert.mockResolvedValue({});
    await markReportSent(2, 'email', WK, { ok: false, detail: 'x'.repeat(900) });
    const arg = mockPrisma.reportLog.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ userId_kind_weekKey: { userId: 2, kind: 'email', weekKey: WK } });
    expect(arg.create).toMatchObject({ userId: 2, kind: 'email', weekKey: WK, ok: false });
    expect(arg.create.detail.length).toBe(500);
    expect(arg.update.ok).toBe(false);
  });

  it('markReportSent does not throw on DB failure', async () => {
    mockPrisma.reportLog.upsert.mockRejectedValue(new Error('db down'));
    await expect(markReportSent(2, 'email', WK, {})).resolves.toBeUndefined();
  });
});

describe('sendUserReports — delivery to a single user (email channel)', () => {
  const channels = (email: boolean) => async () => ({ email, telegram: false });

  beforeEach(() => {
    mockPrisma.user.findUnique.mockResolvedValue({ email: 'owner@x.io' });
    mockPrisma.aeoTracker.findMany.mockResolvedValue([TRACKER]); // user's active trackers
    mockPrisma.aeoAnswer.findMany.mockResolvedValue(windowRows());
    mockPrisma.brand.findUnique.mockResolvedValue({ language: 'ru' });
    mockPrisma.reportLog.findFirst.mockResolvedValue(null); // not sent yet
    mockPrisma.reportLog.upsert.mockResolvedValue({});
  });

  it('email plan + not yet sent + mail configured → email sent, marked ok', async () => {
    const spy = okTransport();
    const res = await sendUserReports(1, { channelsFor: channels(true), now: NOW, transport: spy.transport });
    expect(res).toEqual({ userId: 1, email: true, telegram: false });
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0].to).toBe('owner@x.io');
    expect(mockPrisma.reportLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_kind_weekKey: { userId: 1, kind: 'email', weekKey: WK } } }),
    );
  });

  it('free plan (email:false) → nothing sent, DB not read', async () => {
    const spy = okTransport();
    const res = await sendUserReports(1, { channelsFor: channels(false), now: NOW, transport: spy.transport });
    expect(res.email).toBe(false);
    expect(spy.sent).toHaveLength(0);
    expect(mockPrisma.aeoTracker.findMany).not.toHaveBeenCalled();
  });

  it('already sent this week (ok=TRUE) → retry not sent', async () => {
    mockPrisma.reportLog.findFirst.mockResolvedValue({ id: 9 });
    const spy = okTransport();
    const res = await sendUserReports(1, { channelsFor: channels(true), now: NOW, transport: spy.transport });
    expect(spy.sent).toHaveLength(0);
    expect(res.email).toBe(false);
  });

  it('force bypasses idempotency (sends even with an ok=TRUE row)', async () => {
    mockPrisma.reportLog.findFirst.mockResolvedValue({ id: 9 });
    const spy = okTransport();
    const res = await sendUserReports(1, { channelsFor: channels(true), now: NOW, force: true, transport: spy.transport });
    expect(spy.sent).toHaveLength(1);
    expect(res.email).toBe(true);
  });

  it('mail not configured → nothing sent, mark not written', async () => {
    delete process.env.RESEND_API_KEY; // mailConfigured() → false
    const spy = okTransport();
    const res = await sendUserReports(1, { channelsFor: channels(true), now: NOW, transport: spy.transport });
    expect(spy.sent).toHaveLength(0);
    expect(res.email).toBe(false);
    expect(mockPrisma.reportLog.upsert).not.toHaveBeenCalled();
  });

  it('no active trackers → empty result', async () => {
    mockPrisma.aeoTracker.findMany.mockResolvedValue([]);
    const spy = okTransport();
    const res = await sendUserReports(1, { channelsFor: channels(true), now: NOW, transport: spy.transport });
    expect(res.email).toBe(false);
    expect(spy.sent).toHaveLength(0);
  });
});

describe('runWeeklyReports — fan-out across owners + master gate', () => {
  beforeEach(() => {
    mockPrisma.user.findUnique.mockResolvedValue({ email: 'owner@x.io' });
    mockPrisma.aeoAnswer.findMany.mockResolvedValue(windowRows());
    mockPrisma.brand.findUnique.mockResolvedValue({ language: 'ru' });
    mockPrisma.reportLog.findFirst.mockResolvedValue(null);
    mockPrisma.reportLog.upsert.mockResolvedValue({});
  });

  it('REPORTS_ENABLED=0 → empty, DB untouched', async () => {
    process.env.REPORTS_ENABLED = '0';
    const spy = okTransport();
    const res = await runWeeklyReports({ channelsFor: async () => ({ email: true, telegram: false }), now: NOW, transport: spy.transport });
    expect(res).toEqual({ sent: [] });
    expect(mockPrisma.aeoTracker.findMany).not.toHaveBeenCalled();
  });

  it('single-user mode: gathers recipients, sends, returns the sent list', async () => {
    // first findMany — user's active trackers (onlyUserId bypasses reportRecipientUserIds)
    mockPrisma.aeoTracker.findMany.mockResolvedValue([TRACKER]);
    const spy = okTransport();
    const res = await runWeeklyReports({
      channelsFor: async () => ({ email: true, telegram: false }),
      now: NOW,
      onlyUserId: 42,
      transport: spy.transport,
    });
    expect(res.sent).toEqual([{ userId: 42, email: true, telegram: false }]);
    expect(spy.sent).toHaveLength(1);
  });

  it('iterates all owners of active trackers (reportRecipientUserIds)', async () => {
    // distinct owner query, then per-user trackers
    mockPrisma.aeoTracker.findMany
      .mockResolvedValueOnce([{ userId: 5 }]) // reportRecipientUserIds
      .mockResolvedValue([TRACKER]); // activeTrackersForUser
    const spy = okTransport();
    const res = await runWeeklyReports({ channelsFor: async () => ({ email: true, telegram: false }), now: NOW, transport: spy.transport });
    expect(res.sent).toEqual([{ userId: 5, email: true, telegram: false }]);
    // first call is a distinct query by userId
    expect(mockPrisma.aeoTracker.findMany.mock.calls[0][0]).toMatchObject({ distinct: ['userId'] });
  });

  it('one user failing does not break the run', async () => {
    mockPrisma.aeoTracker.findMany
      .mockResolvedValueOnce([{ userId: 5 }, { userId: 6 }])
      .mockRejectedValueOnce(new Error('boom')) // user 5 fails at activeTrackersForUser
      .mockResolvedValue([TRACKER]); // user 6 ok
    const spy = okTransport();
    const res = await runWeeklyReports({ channelsFor: async () => ({ email: true, telegram: false }), now: NOW, transport: spy.transport });
    expect(res.sent).toEqual([{ userId: 6, email: true, telegram: false }]);
  });
});
