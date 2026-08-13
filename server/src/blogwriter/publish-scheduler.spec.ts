/**
 * Autoposting scheduler on mocks: what goes out, what doesn't, and what happens twice.
 *
 * The main invariant — a double tick does NOT publish an entry a second time: the cost
 * of a bug here isn't a red test, it's a duplicate article on someone else's platform and
 * wasted money on adaptation. The connectors themselves (dev.to, Telegram, X...) are mocked:
 * they're covered by their own tests, this one checks the orchestration of them.
 */
import { PublishScheduler } from './publish-scheduler';
import { parseSchedule } from './server/utils/publishSchedule';

// In-memory runs: getRunRow/updateRun and listRunSchedules look at one map,
// the way they'd look at one table.
const runs = new Map<string, any>();
jest.mock('./server/utils/store', () => ({
  getRunRow: jest.fn(async (id: string) => runs.get(id)),
  updateRun: jest.fn(async (id: string, fields: Record<string, unknown>) => {
    const row = runs.get(id);
    if (row) Object.assign(row, fields);
  }),
  listRunSchedules: jest.fn(async () =>
    [...runs.values()].filter((r) => r.publish_schedule_json).map((r) => ({
      id: r.id, brandId: r.brandId ?? null, title: r.title || '', topic: r.topic || '',
      locale: r.locale || '', publish_schedule_json: r.publish_schedule_json,
    })),
  ),
}));

const publishRunToBlog = jest.fn(async () => ({ postId: 0, devto: { attempted: true, ok: true } }) as any);
jest.mock('./publish', () => ({ publishRunToBlog: (...a: any[]) => publishRunToBlog(...(a as [])) }));

jest.mock('./server/utils/appSettings', () => ({
  resolveSettings: jest.fn(async () => ({ brand: 'Ideata', usage: {} })),
}));

const publishAdaptedTelegram = jest.fn(async () => ({ platform: 'tg', ok: true }) as any);
const adaptForPlatform = jest.fn(async () => ({ posts: ['post generated on the fly'] }) as any);
jest.mock('./server/utils/crosspost', () => ({
  adaptForPlatform: (...a: any[]) => adaptForPlatform(...(a as [])),
  crosspostDrafts: jest.requireActual('./server/utils/crosspost').crosspostDrafts,
  publishAdaptedTelegram: (...a: any[]) => publishAdaptedTelegram(...(a as [])),
  publishAdaptedBluesky: jest.fn(async () => ({ ok: true })),
  publishAdaptedMastodon: jest.fn(async () => ({ ok: true })),
  publishAdaptedX: jest.fn(async () => ({ ok: true })),
  publishAdaptedLinkedin: jest.fn(async () => ({ ok: true })),
}));

jest.mock('./server/utils/llm', () => ({ LLM: class { isMock = true } }));

const PAST = '2026-08-10T10:00:00.000Z';
const FUTURE = '2026-08-20T10:00:00.000Z';
const NOW = new Date('2026-08-11T12:00:00.000Z');

function mkRun(id: string, entries: any[], extra: Record<string, unknown> = {}) {
  const row = {
    id, brandId: 7, title: 'Статья', topic: 'тема', locale: 'ru',
    body_md: 'текст', body_html: '<p>текст</p>', crosspost_drafts_json: '',
    publish_schedule_json: entries.length ? JSON.stringify(entries) : '',
    ...extra,
  };
  runs.set(id, row);
  return row;
}

const schedulerOf = () => new PublishScheduler({} as any, {} as any);
const entriesOf = (id: string) => parseSchedule(runs.get(id).publish_schedule_json);

beforeEach(() => {
  runs.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('scheduler tick', () => {
  it('a due blog-channel entry goes out on a single channel and closes as done', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: PAST, status: 'planned' }]);
    await schedulerOf().tick(NOW);

    expect(publishRunToBlog).toHaveBeenCalledTimes(1);
    expect(publishRunToBlog).toHaveBeenCalledWith('r1', { status: 'published', locale: 'ru', channels: ['devto'] });
    const e = entriesOf('r1')[0];
    expect(e.status).toBe('done');
    expect(e.doneAt).toBeTruthy();
  });

  it('does not touch a future entry', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: FUTURE, status: 'planned' }]);
    await schedulerOf().tick(NOW);
    expect(publishRunToBlog).not.toHaveBeenCalled();
    expect(entriesOf('r1')[0].status).toBe('planned');
  });

  it('a run with no schedule is not picked up', async () => {
    mkRun('r1', []);
    await schedulerOf().tick(NOW);
    expect(publishRunToBlog).not.toHaveBeenCalled();
  });

  it('a second tick does not republish the same entry', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: PAST, status: 'planned' }]);
    const s = schedulerOf();
    await s.tick(NOW);
    await s.tick(NOW);
    expect(publishRunToBlog).toHaveBeenCalledTimes(1);
  });

  it('a second INSTANCE (restart, a neighboring worker) also does not publish a duplicate', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: PAST, status: 'planned' }]);
    await schedulerOf().tick(NOW);
    await schedulerOf().tick(NOW);
    expect(publishRunToBlog).toHaveBeenCalledTimes(1);
  });

  it('an interrupted tick left the entry in running — a new tick does not pick it up', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: PAST, status: 'running' }]);
    await schedulerOf().tick(NOW);
    expect(publishRunToBlog).not.toHaveBeenCalled();
  });

  it('a channel failure is stored on the entry itself and is NOT retried on the next tick', async () => {
    publishRunToBlog.mockResolvedValueOnce({ postId: 0, devto: { attempted: false, ok: false, error: 'dev.to API key not set' } } as any);
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: PAST, status: 'planned' }]);
    const s = schedulerOf();
    await s.tick(NOW);

    const e = entriesOf('r1')[0];
    expect(e.status).toBe('error');
    expect(e.error).toBe('dev.to API key not set');

    await s.tick(NOW);
    expect(publishRunToBlog).toHaveBeenCalledTimes(1);
  });

  it('a connector exception does not take down sibling entries of the same run', async () => {
    publishRunToBlog
      .mockRejectedValueOnce(new Error('network dropped'))
      .mockResolvedValueOnce({ postId: 0, ghost: { attempted: true, ok: true } } as any);
    mkRun('r1', [
      { id: 'e1', channel: 'devto', at: PAST, status: 'planned' },
      { id: 'e2', channel: 'ghost', at: PAST, status: 'planned' },
    ]);
    await schedulerOf().tick(NOW);

    const byId = Object.fromEntries(entriesOf('r1').map((e) => [e.id, e]));
    expect(byId.e1.status).toBe('error');
    expect(byId.e1.error).toBe('network dropped');
    expect(byId.e2.status).toBe('done');
  });

  it('"the site" for the native-blog brand counts as done once the post is created', async () => {
    // the brand has no external ingest, but the post was created in blog_posts — the send succeeded
    publishRunToBlog.mockResolvedValueOnce({ postId: 42, external: { attempted: false, ok: false, error: 'receiver address not set' } } as any);
    mkRun('r1', [{ id: 'e1', channel: 'external', at: PAST, status: 'planned' }]);
    await schedulerOf().tick(NOW);
    expect(entriesOf('r1')[0].status).toBe('done');
  });

  it('a failed schedule fetch does not take down the interval', async () => {
    const store = jest.requireMock('./server/utils/store');
    store.listRunSchedules.mockRejectedValueOnce(new Error('DB hiccuped'));
    await expect(schedulerOf().tick(NOW)).resolves.toBeUndefined();
  });
});

describe('social', () => {
  it('text is taken from the composer draft, the LLM is not run again', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'tg', at: PAST, status: 'planned' }], {
      crosspost_drafts_json: JSON.stringify({
        adapts: { tg: { posts: ['ready-made post from the composer'] } },
        media: { tg: [{ url: '/blogwriter/crosspost-media/a.jpg', type: 'image', postIndex: 0 }] },
      }),
    });
    await schedulerOf().tick(NOW);

    expect(adaptForPlatform).not.toHaveBeenCalled();
    const [runId, , posts, , media] = publishAdaptedTelegram.mock.calls[0] as any[];
    expect(runId).toBe('r1');
    expect(posts).toEqual(['ready-made post from the composer']);
    expect(media).toHaveLength(1);
    expect(entriesOf('r1')[0].status).toBe('done');
  });

  it('no draft for the platform — adapt on the fly, otherwise the post just would not go out', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'tg', at: PAST, status: 'planned' }]);
    await schedulerOf().tick(NOW);

    expect(adaptForPlatform).toHaveBeenCalledTimes(1);
    const [, , posts] = publishAdaptedTelegram.mock.calls[0] as any[];
    expect(posts).toEqual(['post generated on the fly']);
  });

  it('platform responded ok:false → entry goes to error with its text', async () => {
    publishAdaptedTelegram.mockResolvedValueOnce({ platform: 'tg', ok: false, error: 'bot token not set' } as any);
    mkRun('r1', [{ id: 'e1', channel: 'tg', at: PAST, status: 'planned' }]);
    await schedulerOf().tick(NOW);

    const e = entriesOf('r1')[0];
    expect(e.status).toBe('error');
    expect(e.error).toBe('bot token not set');
  });

  it('X on a run with no brand: cannot determine the account — an honest error, not a silent skip', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'x', at: PAST, status: 'planned' }], { brandId: null });
    await schedulerOf().tick(NOW);
    expect(entriesOf('r1')[0].status).toBe('error');
    expect(entriesOf('r1')[0].error).toContain('no brand attached');
  });
});
