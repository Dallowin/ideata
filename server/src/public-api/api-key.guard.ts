import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { ApiKey } from '@prisma/client';

/**
 * Gate for the token API v1: `Authorization: Bearer <token>` or `X-API-Key`.
 * The DB only stores the sha256 hash; the found key is placed on req.apiKey and
 * touched (last_used). Access is limited to keys with plan='scale' (matches the
 * require_api_key/require_scale contract from api_v1.py).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const authz = String(req.headers['authorization'] || '');
    const xKey = String(req.headers['x-api-key'] || '');
    let token = '';
    if (authz.toLowerCase().startsWith('bearer ')) token = authz.slice(7).trim();
    else if (xKey) token = xKey.trim();
    if (!token) {
      throw new UnauthorizedException(
        "API key required: the 'Authorization: Bearer <token>' or 'X-API-Key' header",
      );
    }
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const key = await this.prisma.apiKey.findFirst({
      where: { tokenHash, active: true },
    });
    if (!key) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }
    if (key.plan !== 'scale') {
      throw new ForbiddenException('The API is available on the Scale plan');
    }
    // Bump last_used — best-effort (like touch_api_key in the scrapper): a write
    // failure shouldn't fail an otherwise valid API request.
    try {
      await this.prisma.apiKey.update({
        where: { id: key.id },
        data: { lastUsed: new Date() },
      });
    } catch {
      /* the touch isn't critical */
    }
    (req as any).apiKey = key;
    return true;
  }
}

export const CurrentApiKey = (req: Request): ApiKey =>
  (req as any).apiKey as ApiKey;
