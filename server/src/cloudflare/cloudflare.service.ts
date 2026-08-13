import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

// ── Cloudflare (API token) + GraphQL Analytics ─────────────────────────────
// "Cloudflare" connector: the user creates a scoped API token
// (Analytics:Read) in their CF dashboard and pastes it in. We store the
// token per brand (encrypted), pull AI crawler visits from GraphQL Analytics
// (GPTBot, ClaudeBot, PerplexityBot …) → feeds the "Bots" tab with real data
// instead of the log forwarder.

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';

// UA substring → bot + vendor. Matched case-insensitively by substring.
export const AI_CRAWLERS: { bot: string; ua: string; vendor: string }[] = [
  { bot: 'GPTBot', ua: 'gptbot', vendor: 'OpenAI' },
  { bot: 'OAI-SearchBot', ua: 'oai-searchbot', vendor: 'OpenAI' },
  { bot: 'ChatGPT-User', ua: 'chatgpt-user', vendor: 'OpenAI' },
  { bot: 'ClaudeBot', ua: 'claudebot', vendor: 'Anthropic' },
  { bot: 'Claude-User', ua: 'claude-user', vendor: 'Anthropic' },
  { bot: 'Claude-Web', ua: 'claude-web', vendor: 'Anthropic' },
  { bot: 'anthropic-ai', ua: 'anthropic-ai', vendor: 'Anthropic' },
  { bot: 'PerplexityBot', ua: 'perplexitybot', vendor: 'Perplexity' },
  { bot: 'Perplexity-User', ua: 'perplexity-user', vendor: 'Perplexity' },
  { bot: 'Google-Extended', ua: 'google-extended', vendor: 'Google' },
  { bot: 'GoogleOther', ua: 'googleother', vendor: 'Google' },
  { bot: 'Bytespider', ua: 'bytespider', vendor: 'ByteDance' },
  { bot: 'CCBot', ua: 'ccbot', vendor: 'Common Crawl' },
  { bot: 'Amazonbot', ua: 'amazonbot', vendor: 'Amazon' },
  { bot: 'Applebot-Extended', ua: 'applebot-extended', vendor: 'Apple' },
  { bot: 'meta-externalagent', ua: 'meta-externalagent', vendor: 'Meta' },
  { bot: 'FacebookBot', ua: 'facebookbot', vendor: 'Meta' },
  { bot: 'cohere-ai', ua: 'cohere-ai', vendor: 'Cohere' },
  { bot: 'DuckAssistBot', ua: 'duckassistbot', vendor: 'DuckDuckGo' },
  { bot: 'YouBot', ua: 'youbot', vendor: 'You.com' },
  { bot: 'Diffbot', ua: 'diffbot', vendor: 'Diffbot' },
  { bot: 'Timpibot', ua: 'timpibot', vendor: 'Timpi' },
];

function matchBot(ua: string): { bot: string; vendor: string } | null {
  const u = (ua || '').toLowerCase();
  for (const c of AI_CRAWLERS) if (u.includes(c.ua)) return { bot: c.bot, vendor: c.vendor };
  return null;
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

export interface CfZone {
  id: string;
  name: string;
}

export interface CfReport {
  period: string;
  totalHits: number;
  vendors: number;
  bots: { bot: string; vendor: string; hits: number; pct: number }[];
  series: { labels: string[]; hits: number[] };
}

@Injectable()
export class CloudflareService {
  private readonly log = new Logger('CloudflareService');
  private key = createHash('sha256')
    .update((process.env.CF_TOKEN_KEY || process.env.SESSION_SECRET || 'ideata-cf').trim())
    .digest(); // 32 bytes

  constructor(private prisma: PrismaService) {}

  get enabled(): boolean {
    return true; // the user enters the token — the connector is always available
  }

  // ── token encryption (AES-256-GCM) ────────────────────────────────────────
  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }
  private decrypt(blob: string): string {
    const [ivB, tagB, dataB] = String(blob || '').split(':');
    if (!ivB || !tagB || !dataB) return '';
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  }

  // ── Cloudflare REST: verify token + list zones ────────────────────────────
  async verifyToken(token: string): Promise<boolean> {
    const res = await fetch(`${CF_API}/user/tokens/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data: any = await res.json();
    return data?.success && data?.result?.status === 'active';
  }

  async listZones(token: string): Promise<CfZone[]> {
    const res = await fetch(`${CF_API}/zones?per_page=50&status=active`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Cloudflare zones failed (${res.status})`);
    const data: any = await res.json();
    return (data?.result ?? []).map((z: any) => ({ id: z.id, name: z.name }));
  }

  // ── Connection storage (per-brand) ────────────────────────────────────────
  async getConnection(brandId: number) {
    return this.prisma.cloudflareConnection.findUnique({ where: { brandId } });
  }

  async upsertConnection(input: {
    brandId: number;
    userId: number;
    token: string;
    zoneId: string;
    zoneName: string;
  }) {
    const { brandId, userId, token, zoneId, zoneName } = input;
    const data = { userId, apiToken: this.encrypt(token), zoneId, zoneName };
    return this.prisma.cloudflareConnection.upsert({
      where: { brandId },
      create: { brandId, ...data },
      update: data,
    });
  }

  async setZone(brandId: number, zoneId: string, zoneName: string) {
    return this.prisma.cloudflareConnection.update({ where: { brandId }, data: { zoneId, zoneName } });
  }

  async disconnect(brandId: number) {
    await this.prisma.cloudflareConnection.deleteMany({ where: { brandId } });
    return true;
  }

  // token for listZones on an already-connected brand (decryption)
  tokenOf(conn: { apiToken: string }): string {
    try {
      return this.decrypt(conn.apiToken);
    } catch {
      return '';
    }
  }

  // ── GraphQL Analytics: AI crawler hits by User-Agent ──────────────────────
  async getReport(
    conn: { apiToken: string; zoneId: string },
    period: string,
  ): Promise<CfReport> {
    const token = this.tokenOf(conn);
    const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '28d' ? 28 : 30;
    const since = isoDaysAgo(days);
    const until = isoDaysAgo(0);

    const query = `
      query($zoneTag:String!,$since:Time!,$until:Time!){
        viewer{
          zones(filter:{zoneTag:$zoneTag}){
            httpRequestsAdaptiveGroups(
              limit:5000,
              filter:{datetime_geq:$since, datetime_leq:$until},
              orderBy:[count_DESC]
            ){
              count
              dimensions{ userAgent date }
            }
          }
        }
      }`;
    const res = await fetch(CF_GRAPHQL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { zoneTag: conn.zoneId, since, until } }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Cloudflare graphql ${res.status}: ${t.slice(0, 200)}`);
    }
    const data: any = await res.json();
    if (data?.errors?.length) throw new Error(`Cloudflare graphql: ${data.errors[0]?.message || 'error'}`);
    const groups: any[] = data?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];

    const botTotals = new Map<string, { vendor: string; hits: number }>();
    const vendorSet = new Set<string>();
    const byDate = new Map<string, number>();
    let totalHits = 0;
    for (const g of groups) {
      const m = matchBot(g?.dimensions?.userAgent);
      if (!m) continue;
      const c = num(g.count);
      totalHits += c;
      vendorSet.add(m.vendor);
      const cur = botTotals.get(m.bot) || { vendor: m.vendor, hits: 0 };
      cur.hits += c;
      botTotals.set(m.bot, cur);
      const date = String(g?.dimensions?.date || '').slice(0, 10);
      if (date) byDate.set(date, (byDate.get(date) || 0) + c);
    }

    const bots = [...botTotals.entries()]
      .map(([bot, x]) => ({ bot, vendor: x.vendor, hits: x.hits, pct: totalHits ? (x.hits / totalHits) * 100 : 0 }))
      .sort((a, b) => b.hits - a.hits);

    const labels = [...byDate.keys()].sort();
    const hits = labels.map((d) => byDate.get(d) || 0);

    return { period, totalHits, vendors: vendorSet.size, bots, series: { labels, hits } };
  }
}
