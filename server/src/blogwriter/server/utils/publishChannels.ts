/**
 * List of publishing channels and parsing of the user's selection.
 *
 * "Where we publish" used to be set purely by toggles in settings: turn on
 * dev.to, and EVERY article goes there. That's not enough for real work: a
 * technical deep-dive belongs on dev.to but not on Dzen, and a news
 * announcement is the other way around. So publishing gained a one-off channel
 * selection, and the toggle stayed what it was — a default value.
 *
 * Telegram is deliberately absent here: we don't send the full article to the
 * channel — the 4096-character message limit would turn it into several walls
 * of text. The channel gets a short post with a link via the social composer.
 *
 * Channel readiness is computed HERE and only here, using the same *Config as
 * publishing itself. These rules must not be duplicated in the frontend: they
 * would silently drift apart, and the UI would start offering a channel that
 * the backend would then reject.
 */
import type { AppSettings } from './appSettings'
import { bskyConfig } from './blueskyPublish'
import { devtoConfig } from './devtoPublish'
import { ghostConfig } from './ghostPublish'
import { mastodonConfig } from './mastodonPublish'
import { telegraphConfig } from './telegraphPublish'
import { wpConfig } from './wordpressPublish'

/** Channel keys controlled by the publish-time selection. */
export const CHANNEL_KEYS = [
  'external', 'devto', 'bluesky', 'mastodon', 'wordpress', 'ghost', 'telegraph', 'threads',
] as const
export type ChannelKey = (typeof CHANNEL_KEYS)[number]

export interface ChannelInfo {
  key: ChannelKey
  label: string
  /** configured and able to accept an article right now */
  ready: boolean
  /** enabled via the toggle — the checkbox's default value */
  enabled: boolean
  /** why it's not ready (empty when ready) */
  reason?: string
}

/**
 * Channels for the UI. `threads` isn't included here: its connection lives in
 * the main database and is obtained by a service via DI, not from blog
 * settings — the controller appends it itself.
 */
export function listChannels(s: AppSettings): ChannelInfo[] {
  const dev = devtoConfig(s)
  const bsky = bskyConfig(s)
  const masto = mastodonConfig(s)
  const wp = wpConfig(s)
  const gh = ghostConfig(s)
  const tph = telegraphConfig(s)

  const out: ChannelInfo[] = [
    {
      key: 'external', label: 'Website',
      ready: !!(s.extPublishUrl && s.extPublishToken),
      enabled: !!s.extPublishEnabled,
      reason: s.extPublishUrl && s.extPublishToken ? '' : 'receiver address or token not set',
    },
    { key: 'devto', label: 'dev.to', ready: !!dev.apiKey, enabled: !!s.devtoEnabled, reason: dev.apiKey ? '' : 'API key not set' },
    {
      key: 'bluesky', label: 'Bluesky',
      ready: !!(bsky.handle && bsky.appPassword), enabled: !!s.blueskyEnabled,
      reason: bsky.handle && bsky.appPassword ? '' : 'handle or app password not set',
    },
    {
      key: 'mastodon', label: 'Mastodon',
      ready: !!(masto.instance && masto.token), enabled: !!s.mastodonEnabled,
      reason: masto.instance && masto.token ? '' : 'instance address or token not set',
    },
    {
      key: 'wordpress', label: 'WordPress',
      ready: !!(wp.siteUrl && (wp.oauthToken || (wp.user && wp.appPassword))), enabled: !!s.wpEnabled,
      reason: wp.siteUrl ? (wp.oauthToken || (wp.user && wp.appPassword) ? '' : 'access not set') : 'site address not set',
    },
    {
      key: 'ghost', label: 'Ghost',
      ready: !!(gh.siteUrl && gh.keyId && gh.keySecret), enabled: !!s.ghostEnabled,
      reason: gh.siteUrl ? (gh.keyId && gh.keySecret ? '' : 'Admin API key not set') : 'site address not set',
    },
    { key: 'telegraph', label: 'Telegraph', ready: !!tph.token, enabled: !!s.telegraphEnabled, reason: tph.token ? '' : 'account not created' },
  ]
  return out.map((c) => ({ ...c, reason: c.ready ? undefined : c.reason }))
}

/**
 * Channel selection for a single publish.
 *
 * `undefined` means no selection was made (old client, scheduled
 * auto-publish): we go by the toggles, as before. An empty array is a
 * DELIBERATE "nowhere", not "as usual": treating it as "all enabled" would
 * mean sending the article to channels it was just unchecked from.
 */
export class ChannelPick {
  private readonly picked: Set<string> | null

  constructor(raw: unknown) {
    this.picked = Array.isArray(raw)
      ? new Set(raw.map((x) => String(x || '').trim().toLowerCase()).filter((x) => (CHANNEL_KEYS as readonly string[]).includes(x)))
      : null
  }

  /** Was a selection made at all? */
  get explicit(): boolean { return this.picked !== null }

  /** Does the channel participate in this publish? */
  wants(key: ChannelKey): boolean { return this.picked ? this.picked.has(key) : true }
}
