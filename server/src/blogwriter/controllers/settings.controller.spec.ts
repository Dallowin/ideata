/**
 * Contract for the GET blogwriter/settings response: only the allow-list goes out.
 * This test guards against exactly what bit us before — the response used to be
 * built with a spread `{...s}`, and platform-wide keys (anthropicKey/openrouterKey)
 * were sent out in plaintext.
 */
import { publicSettings } from './settings.controller';
import type { AppSettings } from '../server/utils/appSettings';

/** Settings where EVERY secret is filled with a recognizable string. */
function settingsWithSecrets(): AppSettings {
  return {
    provider: 'anthropic',
    apiKey: 'SECRET-apiKey',
    anthropicKey: 'SECRET-anthropicKey',
    openrouterKey: 'SECRET-openrouterKey',
    geminiKey: 'SECRET-geminiKey',
    modelStrong: 'anthropic/claude-sonnet-5',
    modelFast: 'anthropic/claude-haiku-4.5',
    modelResearch: 'google/gemini-2.5-pro',
    language: 'ru',
    tone: 'экспертный',
    persona: 'персона',
    requirements: '',
    delivery: '',
    brand: 'Ideata',
    brandFacts: '',
    minCitations: 2,
    author: '',
    categories: 'Гайды',
    siteUrl: 'https://ideata.io',
    maxSources: 8,
    maxQueries: 5,
    postsPerQuery: 8,
    maxPerDomain: 2,
    maxPerspectives: 4,
    fetchTimeoutMs: 20_000,
    slopThreshold: 6,
    slopMaxRewrites: 2,
    targetWords: 1200,
    mock: false,
    extPublishEnabled: true,
    extPublishUrl: 'https://example.com/api',
    extPublishAuthHeader: 'Authorization',
    extPublishToken: 'SECRET-extPublishToken',
    tgPublishEnabled: true,
    tgBotToken: 'SECRET-tgBotToken',
    tgChannel: '@channel',
    dzenEnabled: false,
    dzenChannelUrl: '',
    devtoEnabled: true,
    devtoApiKey: 'SECRET-devtoApiKey',
    blueskyEnabled: true,
    blueskyHandle: 'me.bsky.social',
    blueskyAppPassword: 'SECRET-blueskyAppPassword',
    wpEnabled: true,
    wpMode: 'app',
    wpSiteUrl: 'https://wp.example.com',
    wpUser: 'admin',
    wpAppPassword: 'SECRET-wpAppPassword',
    wpOauthToken: 'SECRET-wpOauthToken',
    mastodonEnabled: true,
    mastodonInstance: 'https://mastodon.social',
    mastodonToken: 'SECRET-mastodonToken',
    ghostEnabled: true,
    ghostSiteUrl: 'https://ghost.example.com',
    ghostAdminKey: 'id:SECRET-ghostAdminKey',
    telegraphEnabled: true,
    telegraphToken: 'SECRET-telegraphToken',
    telegraphAuthorName: 'Редакция',
    usage: { userId: 42, domain: 'ideata.io' },
  };
}

const SECRET_KEYS: Array<keyof AppSettings> = [
  'apiKey', 'anthropicKey', 'openrouterKey', 'geminiKey', 'extPublishToken', 'tgBotToken', 'devtoApiKey',
  'blueskyAppPassword', 'wpAppPassword', 'wpOauthToken', 'mastodonToken', 'ghostAdminKey',
  'telegraphToken', 'usage',
];

describe('publicSettings — no secret fields in the response', () => {
  const s = settingsWithSecrets();
  const out = publicSettings(s);

  it('no secret key is present in the response', () => {
    for (const k of SECRET_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
    }
  });

  it('no secret value leaked under a different name', () => {
    const dump = JSON.stringify(out);
    expect(dump).not.toContain('SECRET-');
  });

  it('no *Token/*Password/*Key/apiKey-like fields are exposed', () => {
    const suspicious = Object.keys(out).filter((k) =>
      /token|password|secret|apikey|(^|[a-z])key$/i.test(k));
    expect(suspicious).toEqual([]);
  });

  it('non-secret form fields are present', () => {
    expect(out.provider).toBe('anthropic');
    expect(out.brand).toBe('Ideata');
    expect(out.extPublishUrl).toBe('https://example.com/api');
    expect(out.wpUser).toBe('admin');
    expect(out.targetWords).toBe(1200);
  });

  it('a new secret added to AppSettings does not leak into the response on its own', () => {
    // an allow-list, not "everything except": an unknown field is simply not copied
    const withNew = { ...s, brandNewSecret: 'SECRET-future' } as unknown as AppSettings;
    expect(JSON.stringify(publicSettings(withNew))).not.toContain('SECRET-future');
  });
});
