import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';
import { seatsLimitError } from '../plans/plan-limits';

/**
 * Account team (stage 5a). Account = owner (users.id). Members with the
 * editor/viewer role live in scraper-owned tables account_members /
 * account_invites (bootstrapped by the scrapper's Storage — the same
 * Postgres). This is team management over RAW SQL via PrismaService (these
 * tables are intentionally not in the Prisma schema, same as user_plans is
 * read raw in PlanGuard).
 *
 * All methods are scoped by OWNER = the current user: myTeam/mutations work
 * with the caller's own account. The seats gate follows the owner's plan:
 * free/lite (seats=1) can't invite at all, pro/scale (seats=null) have no
 * limit. Admin bypasses the seats gate.
 */
const ROLES = new Set(['editor', 'viewer']);

type MemberRow = {
  userId: number;
  name: string | null;
  email: string | null;
  role: string;
  createdAt: Date | string;
};
type InviteRow = {
  id: number;
  token: string;
  role: string;
  email: string | null;
  status: string;
  createdAt: Date | string;
};
type AccountRow = {
  ownerUserId: number;
  ownerName: string | null;
  role: string;
};

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  private iso(v: any): string {
    return v instanceof Date ? v.toISOString() : String(v ?? '');
  }

  /** Owner account members + their profile. */
  async members(ownerUserId: number): Promise<MemberRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT m.member_user_id AS "userId",
              COALESCE(NULLIF(u.name,''), NULLIF(u.username,''), u.email) AS name,
              u.email AS email, m.role AS role, m.created_at AS "createdAt"
         FROM account_members m
         LEFT JOIN users u ON u.id = m.member_user_id
        WHERE m.owner_user_id = $1
        ORDER BY m.created_at, m.member_user_id`,
      ownerUserId,
    );
    return rows.map((r) => ({ ...r, userId: Number(r.userId) }));
  }

  /** Active (pending) invites for the owner account. */
  async invites(ownerUserId: number): Promise<InviteRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, token, role, email, status, created_at AS "createdAt"
         FROM account_invites
        WHERE owner_user_id = $1 AND status = 'pending'
        ORDER BY id DESC`,
      ownerUserId,
    );
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  /** Accounts where the current user is a member (not the owner). */
  async myAccounts(userId: number): Promise<AccountRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT m.owner_user_id AS "ownerUserId",
              COALESCE(NULLIF(u.name,''), NULLIF(u.username,''), u.email) AS "ownerName",
              m.role AS role
         FROM account_members m
         LEFT JOIN users u ON u.id = m.owner_user_id
        WHERE m.member_user_id = $1
        ORDER BY m.owner_user_id`,
      userId,
    );
    return rows.map((r) => ({ ...r, ownerUserId: Number(r.ownerUserId) }));
  }

  /** Full owner team summary: seat limit + members + invites + my accounts. */
  async myTeam(ownerUserId: number) {
    const limits = await this.plans.resolveLimits(ownerUserId);
    const [members, invites, myAccounts] = await Promise.all([
      this.members(ownerUserId),
      this.invites(ownerUserId),
      this.myAccounts(ownerUserId),
    ]);
    return {
      seatsLimit: limits.seats ?? null,
      members: members.map((m) => ({ ...m, createdAt: this.iso(m.createdAt) })),
      invites: invites.map((i) => ({ ...i, createdAt: this.iso(i.createdAt) })),
      myAccounts,
    };
  }

  /**
   * Create an invite to the owner's team. Seats gate: free/lite (seats=1) →
   * PLAN_LIMIT_SEATS error; paid plans with a finite limit (not in the
   * defaults, but same code path) → "seats are full". Admin bypasses the
   * gate. token = 32 hex chars (single-use).
   */
  async createInvite(
    ownerUserId: number,
    role: string,
    email: string | null,
    opts: { isAdmin?: boolean } = {},
  ): Promise<InviteRow> {
    const r = String(role || '')
      .trim()
      .toLowerCase();
    if (!ROLES.has(r)) throw new BadRequestException('Role: editor or viewer');

    if (!opts.isAdmin) {
      const limits = await this.plans.resolveLimits(ownerUserId);
      const seats = limits.seats; // number | null (null = unlimited)
      if (seats !== null && seats !== undefined) {
        if (seats <= 1) {
          throw seatsLimitError();
        }
        // The owner takes up 1 seat; members + active invites must not
        // exceed the remaining seats.
        const [mCnt, iCnt] = await Promise.all([
          this.countMembers(ownerUserId),
          this.countPendingInvites(ownerUserId),
        ]);
        if (1 + mCnt + iCnt >= seats) {
          throw seatsLimitError(`All ${seats} seats on the plan are taken`);
        }
      }
    }

    const token = randomBytes(16).toString('hex'); // 32 hex chars
    const cleanEmail = (email || '').trim().toLowerCase() || null;
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `INSERT INTO account_invites (owner_user_id, token, role, email, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, token, role, email, status, created_at AS "createdAt"`,
      ownerUserId,
      token,
      r,
      cleanEmail,
    );
    const row = rows[0];
    return { ...row, id: Number(row.id), createdAt: this.iso(row.createdAt) };
  }

  /** Revoke (cancel) a pending invite by id. Owner-scoped. */
  async revokeInvite(ownerUserId: number, id: number): Promise<boolean> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE account_invites SET status = 'revoked'
        WHERE id = $1 AND owner_user_id = $2 AND status = 'pending'`,
      id,
      ownerUserId,
    );
    return true;
  }

  /**
   * Accept an invite by token (login required — the caller is already
   * authenticated). Can't accept your own invite; idempotent (already a
   * member → ok); single-use via status.
   * Returns the joined account {ownerUserId, ownerName, role}.
   */
  async acceptInvite(userId: number, token: string): Promise<AccountRow> {
    const t = String(token || '').trim();
    if (!t) throw new BadRequestException('Invite token is required');
    const invRows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id, owner_user_id AS "ownerUserId", role, status
         FROM account_invites WHERE token = $1`,
      t,
    );
    const inv = invRows[0];
    if (!inv || inv.status !== 'pending') {
      throw new NotFoundException(
        'Invite is invalid or already used',
      );
    }
    const ownerUserId = Number(inv.ownerUserId);
    if (ownerUserId === userId) {
      throw new BadRequestException('Cannot accept your own invite');
    }
    // membership (idempotent: already a member → update the role to match the invite)
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO account_members (owner_user_id, member_user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_user_id, member_user_id) DO UPDATE SET role = EXCLUDED.role`,
      ownerUserId,
      userId,
      inv.role,
    );
    // cancel the invite (single-use)
    await this.prisma.$executeRawUnsafe(
      `UPDATE account_invites
          SET status = 'accepted', accepted_by = $2, accepted_at = now()
        WHERE id = $1 AND status = 'pending'`,
      Number(inv.id),
      userId,
    );
    const nameRows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COALESCE(NULLIF(u.name,''), NULLIF(u.username,''), u.email) AS "ownerName"
         FROM users u WHERE u.id = $1`,
      ownerUserId,
    );
    return {
      ownerUserId,
      ownerName: nameRows[0]?.ownerName ?? null,
      role: inv.role,
    };
  }

  /** Remove a member from your team. Owner-scoped. */
  async removeMember(
    ownerUserId: number,
    memberUserId: number,
  ): Promise<boolean> {
    await this.prisma.$executeRawUnsafe(
      `DELETE FROM account_members
        WHERE owner_user_id = $1 AND member_user_id = $2`,
      ownerUserId,
      memberUserId,
    );
    return true;
  }

  /** Change a member's role. Owner-scoped; unknown member → 404. */
  async setMemberRole(
    ownerUserId: number,
    memberUserId: number,
    role: string,
  ): Promise<MemberRow> {
    const r = String(role || '')
      .trim()
      .toLowerCase();
    if (!ROLES.has(r)) throw new BadRequestException('Role: editor or viewer');
    const affected = await this.prisma.$executeRawUnsafe(
      `UPDATE account_members SET role = $3
        WHERE owner_user_id = $1 AND member_user_id = $2`,
      ownerUserId,
      memberUserId,
      r,
    );
    if (!affected) throw new NotFoundException('Member not found');
    const members = await this.members(ownerUserId);
    const m = members.find((x) => x.userId === memberUserId);
    if (!m) throw new NotFoundException('Member not found');
    return { ...m, createdAt: this.iso(m.createdAt) };
  }

  private async countMembers(ownerUserId: number): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM account_members WHERE owner_user_id = $1`,
      ownerUserId,
    );
    return Number(rows[0]?.n ?? 0);
  }
  private async countPendingInvites(ownerUserId: number): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM account_invites
        WHERE owner_user_id = $1 AND status = 'pending'`,
      ownerUserId,
    );
    return Number(rows[0]?.n ?? 0);
  }
}
