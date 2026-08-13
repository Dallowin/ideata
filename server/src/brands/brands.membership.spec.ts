import { BrandsService } from './brands.service';

/**
 * Prisma mock for membership scenarios. brand.findUnique is programmable by id;
 * brand.findMany goes by where; user.findMany returns owner names; $queryRawUnsafe
 * covers account_members / user_active_brand; $executeRawUnsafe writes the pointer.
 */
function brandRow(over: Partial<any> = {}) {
  return {
    id: 1,
    userId: 42,
    domain: 'acme.com',
    name: 'Acme',
    description: null,
    competitors: [],
    geo: 'us',
    language: 'ru',
    topics: [],
    aliases: [],
    isActive: false,
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
    ...over,
  };
}

function mkPrisma(opts: {
  brands?: any[];
  members?: { ownerId: number; role: string }[];
  activeBrandId?: number | null;
  users?: any[];
}) {
  const brands = opts.brands ?? [];
  const byId = new Map(brands.map((b) => [b.id, b]));
  return {
    _updated: null as any,
    _deleted: null as any,
    brand: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(byId.get(where.id) ?? null),
      ),
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve(brands)),
      count: jest.fn(() => Promise.resolve(brands.length)),
      update: jest.fn(({ where, data }: any) => {
        const b = { ...byId.get(where.id), ...data };
        return Promise.resolve(b);
      }),
      delete: jest.fn(() => Promise.resolve(true)),
    },
    user: {
      findMany: jest.fn(() =>
        Promise.resolve(
          opts.users ?? [
            { id: 42, name: 'Owner', username: null, email: 'o@x' },
          ],
        ),
      ),
    },
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('FROM account_members'))
        return (opts.members ?? []).map((m) => ({
          ownerId: m.ownerId,
          role: m.role,
        }));
      if (sql.includes('FROM user_active_brand'))
        return opts.activeBrandId != null
          ? [{ brandId: opts.activeBrandId }]
          : [];
      return [];
    }),
    $executeRawUnsafe: jest.fn(async () => 1),
  } as any;
}

const plans = { resolveLimits: jest.fn() } as any;

describe('BrandsService.accessibleForUser — own + owners\' brands', () => {
  it('merges the owner\'s brands, sets myRole/ownerName, and active from the pointer', async () => {
    const prisma = mkPrisma({
      brands: [
        brandRow({ id: 1, userId: 42, domain: 'mine.com' }), // own
        brandRow({ id: 2, userId: 7, domain: 'owner.com', isActive: true }), // owner's
      ],
      members: [{ ownerId: 7, role: 'editor' }],
      activeBrandId: 2,
      users: [
        { id: 42, name: 'Me', username: null, email: 'me@x' },
        { id: 7, name: 'Owner Seven', username: null, email: 'o7@x' },
      ],
    });
    const svc = new BrandsService(prisma, plans);
    const list = await svc.accessibleForUser(42);
    const byDom = Object.fromEntries(list.map((b) => [b.domain, b]));
    expect(byDom['mine.com'].myRole).toBe('owner');
    expect(byDom['mine.com'].ownerUserId).toBe(42);
    expect(byDom['owner.com'].myRole).toBe('editor');
    expect(byDom['owner.com'].ownerUserId).toBe(7);
    expect(byDom['owner.com'].ownerName).toBe('Owner Seven');
    // active — from the pointer (brand_id=2), not from Brand.isActive
    expect(byDom['owner.com'].isActive).toBe(true);
    expect(byDom['mine.com'].isActive).toBe(false);
    // own brands first
    expect(list[0].myRole).toBe('owner');
  });
});

describe('BrandsService.update — access by role', () => {
  it('an editor of the owner\'s account edits the brand', async () => {
    const prisma = mkPrisma({
      brands: [brandRow({ id: 2, userId: 7 })],
      members: [{ ownerId: 7, role: 'editor' }],
    });
    const svc = new BrandsService(prisma, plans);
    const b = await svc.update(42, 2, { name: 'New' });
    expect(b.myRole).toBe('editor');
    expect(prisma.brand.update).toHaveBeenCalled();
  });

  it('viewer → 403 (view only)', async () => {
    const prisma = mkPrisma({
      brands: [brandRow({ id: 2, userId: 7 })],
      members: [{ ownerId: 7, role: 'viewer' }],
    });
    const svc = new BrandsService(prisma, plans);
    await expect(svc.update(42, 2, { name: 'X' })).rejects.toThrow(
      'View only',
    );
    expect(prisma.brand.update).not.toHaveBeenCalled();
  });

  it('not a member → 404', async () => {
    const prisma = mkPrisma({
      brands: [brandRow({ id: 2, userId: 7 })],
      members: [],
    });
    const svc = new BrandsService(prisma, plans);
    await expect(svc.update(42, 2, { name: 'X' })).rejects.toThrow('not found');
  });
});

describe('BrandsService.remove — owner only', () => {
  it('an editor-member cannot delete someone else\'s brand → 403', async () => {
    const prisma = mkPrisma({
      brands: [brandRow({ id: 2, userId: 7 })],
      members: [{ ownerId: 7, role: 'editor' }],
    });
    const svc = new BrandsService(prisma, plans);
    await expect(svc.remove(42, 2)).rejects.toThrow('owner');
    expect(prisma.brand.delete).not.toHaveBeenCalled();
  });

  it('the owner deletes their own brand', async () => {
    const prisma = mkPrisma({ brands: [brandRow({ id: 1, userId: 42 })] });
    const svc = new BrandsService(prisma, plans);
    await expect(svc.remove(42, 1)).resolves.toBe(true);
    expect(prisma.brand.delete).toHaveBeenCalled();
  });
});

describe('BrandsService.setActive — pointer for an accessible brand', () => {
  it('writes user_active_brand for an accessible brand of the owner', async () => {
    const prisma = mkPrisma({
      brands: [brandRow({ id: 2, userId: 7 })],
      members: [{ ownerId: 7, role: 'viewer' }], // even a viewer can switch workspace
    });
    const svc = new BrandsService(prisma, plans);
    await expect(svc.setActive(42, 2)).resolves.toBe(true);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('inaccessible brand → 404', async () => {
    const prisma = mkPrisma({
      brands: [brandRow({ id: 2, userId: 7 })],
      members: [],
    });
    const svc = new BrandsService(prisma, plans);
    await expect(svc.setActive(42, 2)).rejects.toThrow('not found');
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});
