import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';
import { brandLimitError } from '../plans/plan-limits';

function normDomain(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0];
}

function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Brand language by region when not chosen explicitly: Russian only for CIS
// markets, English for the rest of the world. Exactly two languages are
// supported — the scraper can generate prompts and emails are written in them.
const CIS_REGIONS = new Set([
  'ru',
  'kz',
  'by',
  'ua',
  'uz',
  'kg',
  'am',
  'az',
  'ge',
  'md',
]);
function langForGeo(geo: string): string {
  return CIS_REGIONS.has((geo || '').trim().toLowerCase()) ? 'ru' : 'en';
}

function asList(v: any): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

// Current user's role for the brand and the owner — layered on top of the
// brand row. ownerUserId is always Brand.userId (the account owner the brand
// belongs to). myRole is the caller's role ('owner'|'editor'|'viewer').
// isActive comes from the current user's user_active_brand (falls back to
// Brand.isActive for the owner).
function toBrand(
  b: any,
  extra: {
    ownerName?: string | null;
    myRole?: string;
    isActive?: boolean;
  } = {},
) {
  return {
    id: b.id,
    domain: b.domain,
    name: b.name || null,
    description: b.description || null,
    competitors: asList(b.competitors),
    geo: b.geo || 'us',
    language: b.language || 'ru',
    topics: asList(b.topics),
    aliases: asList(b.aliases),
    isActive: extra.isActive !== undefined ? extra.isActive : !!b.isActive,
    createdAt:
      b.createdAt instanceof Date
        ? b.createdAt.toISOString()
        : String(b.createdAt),
    ownerUserId: b.userId,
    ownerName: extra.ownerName ?? null,
    myRole: extra.myRole ?? 'owner',
  };
}

// Normalizes a list of domains (competitors/alias domains) the same way as
// the main domain. For topics/name-aliases we just trim, no domain check.
function cleanDomains(list?: string[]): string[] {
  return (list || [])
    .map(normDomain)
    .filter((d) => d && d.includes('.'))
    .slice(0, 8);
}
function cleanStrings(list?: string[], max = 20): string[] {
  return (list || [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

@Injectable()
export class BrandsService {
  constructor(
    private prisma: PrismaService,
    private plans: PlanService,
  ) {}

  // ── membership: raw SQL over scraper-owned tables (not in the Prisma schema) ────
  /** Owners→role, where userId is a member (editor/viewer). Fail-soft → empty. */
  private async membershipOwners(userId: number): Promise<Map<number, string>> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT owner_user_id AS "ownerId", role
           FROM account_members WHERE member_user_id = $1`,
        userId,
      );
      const m = new Map<number, string>();
      for (const r of rows) m.set(Number(r.ownerId), String(r.role));
      return m;
    } catch {
      return new Map();
    }
  }

  /** Personal pointer to the active brand (or null). */
  private async activeBrandId(userId: number): Promise<number | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT brand_id AS "brandId" FROM user_active_brand WHERE user_id = $1`,
        userId,
      );
      return rows[0] ? Number(rows[0].brandId) : null;
    } catch {
      return null;
    }
  }

  /** Write the active brand pointer (best-effort: don't break the main operation). */
  private async setActivePointer(
    userId: number,
    brandId: number,
  ): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO user_active_brand (user_id, brand_id, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE
           SET brand_id = EXCLUDED.brand_id, updated_at = now()`,
        userId,
        brandId,
      );
    } catch {
      /* table doesn't exist yet / DB unavailable — fall back to Brand.isActive */
    }
  }

  /** User's role for the brand: 'owner' (own) | 'editor'/'viewer' (member) | null. */
  async roleForBrand(
    userId: number,
    b: { userId: number },
  ): Promise<string | null> {
    if (b.userId === userId) return 'owner';
    const owners = await this.membershipOwners(userId);
    return owners.get(b.userId) ?? null;
  }

  /** Own brand row by id (ownership check) or null. Legacy helper. */
  async getForUser(userId: number, id: number) {
    const b = await this.prisma.brand.findFirst({ where: { id, userId } });
    return b ? toBrand(b) : null;
  }

  /**
   * Accessible brand by id: own OR an owner's brand where the user is a member.
   * Returns {brand(Prisma row), role} or null (no access).
   */
  async getAccessible(
    userId: number,
    id: number,
  ): Promise<{ brand: any; role: string } | null> {
    const b = await this.prisma.brand.findUnique({ where: { id } });
    if (!b) return null;
    if (b.userId === userId) return { brand: b, role: 'owner' };
    const owners = await this.membershipOwners(userId);
    const role = owners.get(b.userId);
    return role ? { brand: b, role } : null;
  }

  /**
   * Brands accessible to the user: own + brands of account owners where they're
   * a member. Each gets ownerUserId/ownerName/myRole; isActive from
   * user_active_brand (falls back to Brand.isActive for an owner with no
   * pointer). Own brands come first.
   */
  async accessibleForUser(userId: number) {
    const owners = await this.membershipOwners(userId);
    const ownerIds = [...owners.keys()];
    const where =
      ownerIds.length > 0
        ? { OR: [{ userId }, { userId: { in: ownerIds } }] }
        : { userId };
    const rows = await this.prisma.brand.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });
    const activePtr = await this.activeBrandId(userId);

    const uids = [...new Set(rows.map((r) => r.userId))];
    const nameMap = new Map<number, string | null>();
    if (uids.length) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: uids } },
        select: { id: true, name: true, username: true, email: true },
      });
      for (const u of users)
        nameMap.set(u.id, u.name || u.username || u.email || null);
    }

    const out = rows.map((b) => {
      const mine = b.userId === userId;
      const myRole = mine ? 'owner' : (owners.get(b.userId) ?? 'viewer');
      const isActive =
        activePtr != null ? b.id === activePtr : mine && !!b.isActive;
      return toBrand(b, {
        ownerName: nameMap.get(b.userId) ?? null,
        myRole,
        isActive,
      });
    });
    // own brands first (order within — by createdAt, stable sort)
    out.sort(
      (a, b) => (a.myRole === 'owner' ? 0 : 1) - (b.myRole === 'owner' ? 0 : 1),
    );
    return out;
  }

  /** Alias kept for backward compatibility (listForUser used to mean own-only). */
  async listForUser(userId: number) {
    return this.accessibleForUser(userId);
  }

  /**
   * User's active brand workspace: from user_active_brand (if it points to an
   * accessible brand), else their own Brand.isActive, else their earliest own
   * brand, else null. A member sees an owner's brand as active if the pointer
   * points to it.
   */
  async activeForUser(userId: number) {
    const activePtr = await this.activeBrandId(userId);
    if (activePtr != null) {
      const acc = await this.getAccessible(userId, activePtr);
      if (acc) return toBrand(acc.brand, { myRole: acc.role, isActive: true });
    }
    const active = await this.prisma.brand.findFirst({
      where: { userId, isActive: true },
    });
    if (active) return toBrand(active, { isActive: true });
    const first = await this.prisma.brand.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return first ? toBrand(first, { isActive: true }) : null;
  }

  async create(
    userId: number,
    input: {
      domain: string;
      name?: string;
      competitors?: string[];
      description?: string;
      geo?: string;
      language?: string;
      topics?: string[];
      aliases?: string[];
    },
    opts: { isAdmin?: boolean } = {},
  ) {
    const domain = normDomain(input.domain);
    if (!domain || !domain.includes('.'))
      throw new BadRequestException('Invalid domain');

    // Adding an existing brand just re-activates it (idempotent). Reactivation
    // isn't a new brand, so the limit is NOT checked before this branch.
    const existing = await this.prisma.brand.findUnique({
      where: { userId_domain: { userId, domain } },
    });
    if (existing) {
      await this.setActive(userId, existing.id);
      return toBrand(
        await this.prisma.brand.findUnique({ where: { id: existing.id } }),
      );
    }

    // Plan limit on the number of brands (free/lite=1, pro=2, scale=5 + the
    // extra_brands add-on). Only for a NEW brand; admin bypasses the limit.
    // Limit and usage are for the caller's OWN account (a member never creates
    // brands in someone else's account: createBrand always creates the brand
    // for itself).
    if (!opts.isAdmin) {
      const limits = await this.plans.resolveLimits(userId);
      const count = await this.prisma.brand.count({ where: { userId } });
      if (count >= limits.brands) {
        throw brandLimitError(limits.title, limits.brands);
      }
    }

    const competitors = cleanDomains(input.competitors);
    const name = (input.name || '').trim() || titleCase(domain.split('.')[0]);
    const geo = (input.geo || 'us').trim() || 'us';
    // Language wasn't passed (brand created outside onboarding) — derive it
    // from the region: Russian only for CIS, English for the rest of the
    // world. A hard-coded default of 'ru' used to set up English-speaking
    // brands with a Russian report/email language.
    const language = (input.language || '').trim() || langForGeo(geo);

    // New brand becomes the active one; exactly one active per user.
    const created = await this.prisma.$transaction(async (tx) => {
      const b = await tx.brand.create({
        data: {
          userId,
          domain,
          name,
          description: (input.description || '').trim() || null,
          competitors,
          geo,
          language,
          topics: cleanStrings(input.topics),
          aliases: cleanStrings(input.aliases),
          isActive: true,
        },
      });
      await tx.brand.updateMany({
        where: { userId, id: { not: b.id } },
        data: { isActive: false },
      });
      return b;
    });
    // The personal pointer is also moved to the new brand (best-effort).
    await this.setActivePointer(userId, created.id);
    return toBrand(created, { myRole: 'owner', isActive: true });
  }

  /**
   * Patch brand fields. Access: brand owner, editor (member of the owner's
   * account), or admin. viewer → 403 "View only…"; someone else's → 404.
   */
  async update(
    userId: number,
    id: number,
    patch: {
      name?: string;
      description?: string;
      competitors?: string[];
      geo?: string;
      language?: string;
      topics?: string[];
      aliases?: string[];
    },
    opts: { isAdmin?: boolean } = {},
  ) {
    const b = await this.prisma.brand.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Brand not found');
    let myRole = 'owner';
    if (b.userId !== userId) {
      if (opts.isAdmin) {
        myRole = 'owner';
      } else {
        const owners = await this.membershipOwners(userId);
        const role = owners.get(b.userId);
        if (role === 'editor') {
          myRole = 'editor';
        } else if (role === 'viewer') {
          throw new ForbiddenException(
            'View only — ask the owner to grant editor access',
          );
        } else {
          throw new NotFoundException('Brand not found');
        }
      }
    }

    const data: Record<string, any> = {};
    if (patch.name !== undefined) data.name = patch.name.trim() || b.name;
    if (patch.description !== undefined)
      data.description = patch.description.trim() || null;
    if (patch.competitors !== undefined)
      data.competitors = cleanDomains(patch.competitors);
    if (patch.geo !== undefined) data.geo = patch.geo.trim() || 'us';
    if (patch.language !== undefined)
      data.language = patch.language.trim() || 'ru';
    if (patch.topics !== undefined) data.topics = cleanStrings(patch.topics);
    if (patch.aliases !== undefined) data.aliases = cleanStrings(patch.aliases);

    const updated = await this.prisma.brand.update({ where: { id }, data });
    return toBrand(updated, { myRole });
  }

  /**
   * Delete a brand. Only the brand OWNER (or admin): a member-editor/viewer
   * cannot delete the owner's brands (create/delete = owner only). Member →
   * 403, someone else's → 404.
   */
  async remove(userId: number, id: number, opts: { isAdmin?: boolean } = {}) {
    const b = await this.prisma.brand.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Brand not found');
    if (b.userId !== userId && !opts.isAdmin) {
      const owners = await this.membershipOwners(userId);
      if (owners.has(b.userId))
        throw new ForbiddenException(
          'Only the account owner can delete brands',
        );
      throw new NotFoundException('Brand not found');
    }
    await this.prisma.brand.delete({ where: { id } });
    // Promote the most-recent remaining brand of the OWNER if we removed active.
    if (b.isActive) {
      const next = await this.prisma.brand.findFirst({
        where: { userId: b.userId },
        orderBy: { createdAt: 'desc' },
      });
      if (next)
        await this.prisma.brand.update({
          where: { id: next.id },
          data: { isActive: true },
        });
    }
    return true;
  }

  /**
   * Switch the current user's active brand — writes to user_active_brand
   * (a personal pointer, doesn't touch the owner's Brand.isActive). Allowed
   * for ANY accessible brand (own or an owner's brand where the user is a
   * member).
   */
  async setActive(userId: number, id: number) {
    const acc = await this.getAccessible(userId, id);
    if (!acc) throw new NotFoundException('Brand not found');
    await this.setActivePointer(userId, id);
    return true;
  }
}
