/**
 * External API keys: environment first, then the `app_settings` table — the
 * same one edited on the "Settings" page in the admin panel. This order
 * matches how the Python service behaves: `.env` sets the baseline, the
 * panel overrides it on the fly, without a release.
 *
 * Values are cached for a minute: discover lookups are synchronous, there's
 * no point hitting the DB for a key on every request, and a minute is the
 * cap on how long a panel edit takes to land.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const TTL_MS = 60_000;

@Injectable()
export class DiscoverSettings {
  private readonly log = new Logger('DiscoverSettings');
  private cache = new Map<string, { value: string; until: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async get(key: string): Promise<string> {
    const fromEnv = (process.env[key] || '').trim();
    if (fromEnv) return fromEnv;

    const hit = this.cache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;

    let value = '';
    try {
      const row = await this.prisma.appSetting.findUnique({ where: { key } });
      value = (row?.value || '').trim();
    } catch (e) {
      // Settings are a helper layer: an unreachable DB shouldn't break the
      // lookup — it just falls through as "no key".
      this.log.debug(`app_settings unavailable (${key}): ${e}`);
    }
    this.cache.set(key, { value, until: Date.now() + TTL_MS });
    return value;
  }
}
