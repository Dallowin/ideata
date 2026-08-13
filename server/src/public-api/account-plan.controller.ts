import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { LoginGuard } from '../auth/login.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { effectivePlan as effectivePlanFor } from '../auth/plan.guard';
import { HttpDetailFilter } from '../common/http-detail.filter';

// Plans with access to the public AI API — Scale only (matches the scrapper's
// _API_PLANS_WITH_ACCESS contract). An admin is treated as scale.
const API_PLANS_WITH_ACCESS = new Set(['scale']);

/**
 * Plan info and API key self-service — a port of api_public_me_plan /
 * api_public_keys_* from FastAPI. The raw token is returned only once;
 * the DB stores only the sha256 hash (+ a non-secret prefix for listing).
 */
@UseFilters(HttpDetailFilter)
@Controller('api/public')
@UseGuards(LoginGuard)
export class AccountPlanController {
  constructor(private readonly prisma: PrismaService) {}

  private effectivePlan(user: SessionUser): Promise<string> {
    return effectivePlanFor(this.prisma, user);
  }

  @Get('me/plan')
  async myPlan(@CurrentUser() user: SessionUser) {
    const plan = await this.effectivePlan(user);
    return {
      plan,
      isAdmin: user.a === true,
      apiAccess: API_PLANS_WITH_ACCESS.has(plan),
    };
  }

  @Get('keys')
  async listKeys(@CurrentUser() user: SessionUser) {
    const plan = await this.effectivePlan(user);
    const apiAccess = API_PLANS_WITH_ACCESS.has(plan);
    if (!user.i) return { items: [], apiAccess };
    const rows = await this.prisma.apiKey.findMany({
      where: { userId: user.i },
      orderBy: { id: 'desc' },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        active: r.active,
        created_at: r.createdAt,
        last_used: r.lastUsed,
      })),
      apiAccess,
    };
  }

  @Post('keys')
  async createKey(
    @Body() payload: { name?: string } | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    const plan = await this.effectivePlan(user);
    if (!API_PLANS_WITH_ACCESS.has(plan)) {
      throw new ForbiddenException(
        'API key generation is available on the Scale plan',
      );
    }
    if (!user.i) {
      throw new BadRequestException('could not identify the user');
    }
    const name = String(payload?.name || '')
      .trim()
      .slice(0, 80);
    const token = 'sk_ideata_' + randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const prefix = token.slice(0, 14);
    const key = await this.prisma.apiKey.create({
      data: { tokenHash, name, userId: user.i, plan: 'scale', prefix },
    });
    return { id: key.id, name, prefix, token };
  }

  @Post('keys/:id/revoke')
  async revokeKey(
    @Param('id', ParseIntPipe) keyId: number,
    @CurrentUser() user: SessionUser,
  ) {
    if (!user.i) {
      throw new BadRequestException('could not identify the user');
    }
    const res = await this.prisma.apiKey.updateMany({
      where: { id: keyId, userId: user.i },
      data: { active: false },
    });
    return { revoked: res.count };
  }
}
