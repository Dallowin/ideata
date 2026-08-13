import { TeamService } from './team.service';
import { PLAN_LIMIT_SEATS_CODE } from '../plans/plan-limits';

/**
 * Mock PrismaService: $queryRawUnsafe/$executeRawUnsafe are routed by SQL substring.
 * routes.query/exec are arrays of [needle, (params, sql) => result].
 */
function mkPrisma(
  routes: {
    query?: [string, (p: any[], sql: string) => any][];
    exec?: [string, (p: any[], sql: string) => number][];
  } = {},
) {
  const $queryRawUnsafe = jest.fn(async (sql: string, ...params: any[]) => {
    for (const [needle, fn] of routes.query || [])
      if (sql.includes(needle)) return fn(params, sql);
    return [];
  });
  const $executeRawUnsafe = jest.fn(async (sql: string, ...params: any[]) => {
    for (const [needle, fn] of routes.exec || [])
      if (sql.includes(needle)) return fn(params, sql);
    return 1;
  });
  return { $queryRawUnsafe, $executeRawUnsafe } as any;
}

function mkPlans(seats: number | null) {
  return { resolveLimits: jest.fn(async () => ({ seats }) as any) } as any;
}

describe('TeamService.createInvite — seats gate by plan', () => {
  it('free/lite (seats=1) → PLAN_LIMIT_SEATS, invite is not created', async () => {
    const prisma = mkPrisma();
    const plans = mkPlans(1);
    const svc = new TeamService(prisma, plans);
    expect.assertions(2);
    try {
      await svc.createInvite(1, 'editor', null);
    } catch (e: any) {
      expect(e.extensions?.code).toBe(PLAN_LIMIT_SEATS_CODE);
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled(); // never reached the INSERT
    }
  });

  it('pro/scale (seats=null) → creates an invite with a 32-hex token', async () => {
    const prisma = mkPrisma({
      query: [
        [
          'INSERT INTO account_invites',
          (p) => [
            {
              id: 5,
              token: p[1],
              role: p[2],
              email: p[3],
              status: 'pending',
              createdAt: new Date('2026-07-19T00:00:00.000Z'),
            },
          ],
        ],
      ],
    });
    const plans = mkPlans(null);
    const svc = new TeamService(prisma, plans);
    const inv = await svc.createInvite(1, 'editor', 'A@B.com');
    expect(inv.role).toBe('editor');
    expect(inv.email).toBe('a@b.com'); // normalized
    expect(inv.token).toMatch(/^[0-9a-f]{32}$/);
    expect(inv.status).toBe('pending');
  });

  it('admin bypasses the seats gate even on free', async () => {
    const prisma = mkPrisma({
      query: [
        [
          'INSERT INTO account_invites',
          (p) => [
            {
              id: 1,
              token: p[1],
              role: p[2],
              email: p[3],
              status: 'pending',
              createdAt: new Date(),
            },
          ],
        ],
      ],
    });
    const plans = mkPlans(1);
    const svc = new TeamService(prisma, plans);
    const inv = await svc.createInvite(1, 'viewer', null, { isAdmin: true });
    expect(inv.role).toBe('viewer');
    expect(plans.resolveLimits).not.toHaveBeenCalled();
  });

  it('invalid role → 400', async () => {
    const svc = new TeamService(mkPrisma(), mkPlans(null));
    await expect(svc.createInvite(1, 'boss', null)).rejects.toThrow();
  });
});

describe('TeamService.acceptInvite — accepting an invite', () => {
  const okRoutes = (invite: any) => ({
    query: [
      ['FROM account_invites WHERE token', () => (invite ? [invite] : [])] as [
        string,
        (p: any[]) => any,
      ],
      ['FROM users u WHERE u.id', () => [{ ownerName: 'Owner One' }]] as [
        string,
        (p: any[]) => any,
      ],
    ],
    exec: [
      ['INSERT INTO account_members', () => 1] as [string, () => number],
      ['UPDATE account_invites', () => 1] as [string, () => number],
    ],
  });

  it('accepts a pending invite: writes membership and cancels the invite', async () => {
    const prisma = mkPrisma(
      okRoutes({ id: 9, ownerUserId: 1, role: 'editor', status: 'pending' }),
    );
    const svc = new TeamService(prisma, mkPlans(null));
    const res = await svc.acceptInvite(2, 'tok');
    expect(res).toEqual({
      ownerUserId: 1,
      ownerName: 'Owner One',
      role: 'editor',
    });
    // membership + invite cancellation
    const execSqls = prisma.$executeRawUnsafe.mock.calls.map(
      (c: any[]) => c[0],
    );
    expect(
      execSqls.some((s: string) => s.includes('INSERT INTO account_members')),
    ).toBe(true);
    expect(
      execSqls.some((s: string) => s.includes("status = 'accepted'")),
    ).toBe(true);
  });

  it('cannot accept your own invite → 400', async () => {
    const prisma = mkPrisma(
      okRoutes({ id: 9, ownerUserId: 2, role: 'editor', status: 'pending' }),
    );
    const svc = new TeamService(prisma, mkPlans(null));
    await expect(svc.acceptInvite(2, 'tok')).rejects.toThrow();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('unknown/used token → 404', async () => {
    const prisma = mkPrisma(okRoutes(null));
    const svc = new TeamService(prisma, mkPlans(null));
    await expect(svc.acceptInvite(2, 'nope')).rejects.toThrow();
  });

  it('already used (status!=pending) → 404', async () => {
    const prisma = mkPrisma(
      okRoutes({ id: 9, ownerUserId: 1, role: 'editor', status: 'accepted' }),
    );
    const svc = new TeamService(prisma, mkPlans(null));
    await expect(svc.acceptInvite(2, 'tok')).rejects.toThrow();
  });
});

describe('TeamService.setMemberRole / removeMember', () => {
  it('invalid role → 400', async () => {
    const svc = new TeamService(mkPrisma(), mkPlans(null));
    await expect(svc.setMemberRole(1, 2, 'god')).rejects.toThrow();
  });

  it('unknown member (0 rows updated) → 404', async () => {
    const prisma = mkPrisma({ exec: [['UPDATE account_members', () => 0]] });
    const svc = new TeamService(prisma, mkPlans(null));
    await expect(svc.setMemberRole(1, 999, 'viewer')).rejects.toThrow();
  });

  it('removeMember returns true (owner-scoped)', async () => {
    const prisma = mkPrisma({
      exec: [['DELETE FROM account_members', () => 1]],
    });
    const svc = new TeamService(prisma, mkPlans(null));
    await expect(svc.removeMember(1, 2)).resolves.toBe(true);
  });
});

describe('TeamService.myTeam — team summary', () => {
  it('assembles seatsLimit + members + invites + myAccounts', async () => {
    const prisma = mkPrisma({
      query: [
        [
          'm.member_user_id AS "userId"',
          () => [
            {
              userId: 2,
              name: 'Two',
              email: 't@x',
              role: 'editor',
              createdAt: new Date('2026-07-19T00:00:00.000Z'),
            },
          ],
        ],
        [
          'FROM account_invites',
          () => [
            {
              id: 5,
              token: 'abc',
              role: 'viewer',
              email: null,
              status: 'pending',
              createdAt: new Date('2026-07-19T00:00:00.000Z'),
            },
          ],
        ],
        [
          'm.owner_user_id AS "ownerUserId"',
          () => [{ ownerUserId: 9, ownerName: 'Nine', role: 'viewer' }],
        ],
      ],
    });
    const svc = new TeamService(prisma, mkPlans(null));
    const t = await svc.myTeam(1);
    expect(t.seatsLimit).toBeNull();
    expect(t.members).toHaveLength(1);
    expect(t.members[0].userId).toBe(2);
    expect(typeof t.members[0].createdAt).toBe('string');
    expect(t.invites[0].id).toBe(5);
    expect(t.myAccounts[0].ownerUserId).toBe(9);
  });
});
