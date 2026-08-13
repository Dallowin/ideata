/**
 * Recognizing links to embed in an article's body — purely by host and path,
 * with zero network requests.
 *
 * Why no network: the resolver fires on every URL paste in the editor, and the
 * oEmbed endpoints of half the platforms (VK, Dzen, Rutube) are either not
 * public or answer only some of the time — we can't wait on them for every
 * Ctrl+V. If the link isn't recognized, the controller falls back to
 * unfurl.ts for og tags and draws a card.
 *
 * EMBED_HOSTS is a second consumer of this file: the sanitizer only allows
 * <iframe> for hosts that appear here. When adding a provider, add its host
 * too, or the embed will get stripped out when the article is saved.
 */

export type EmbedKind = 'embed' | 'image' | 'video' | 'audio'

export interface EmbedDescriptor {
  kind: EmbedKind
  provider: string
  /** URL for the iframe/media tag */
  src: string
  /** original link (shown to the human) */
  href: string
  title: string
  desc: string
  thumb: string
  site: string
  /** height relative to width, in % (container's padding-bottom) */
  ratio: number
}

/**
 * Whitelist of iframe hosts. The sanitizer compares by suffix
 * (host === h || host.endsWith('.' + h)), so only "roots" belong here.
 */
export const EMBED_HOSTS: string[] = [
  'youtube.com',
  'youtube-nocookie.com',
  'vimeo.com',
  'rutube.ru',
  'vk.com',
  'vkvideo.ru',
  'dzen.ru',
  'ok.ru',
  'dailymotion.com',
  'twitch.tv',
  'coub.com',
  'soundcloud.com',
  'spotify.com',
  'yandex.ru',
  't.me',
  'loom.com',
  'figma.com',
  'codepen.io',
  'jsfiddle.net',
  'gist.github.com',
  'google.com',
  'tiktok.com',
]

/** Direct file links: type is taken from the path extension. */
const FILE_KIND: Record<string, EmbedKind> = {
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', avif: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', ogg: 'audio', wav: 'audio', m4a: 'audio',
}

const RATIO_16_9 = 56.25
const RATIO_VERTICAL = 177.78 // 9:16 — Shorts/Clips/TikTok

/**
 * Twitch requires the parent parameter = the host of the page the player sits
 * on, otherwise it returns "player is disabled". We use our public domain.
 */
function embedParent(): string {
  try {
    return new URL(process.env.PUBLIC_BASE_URL || 'https://ideata.io').hostname
  } catch {
    return 'ideata.io'
  }
}

function seg(u: URL): string[] {
  return u.pathname.split('/').filter(Boolean)
}

function make(
  kind: EmbedKind, provider: string, src: string, href: string, ratio: number, site: string,
): EmbedDescriptor {
  return { kind, provider, src, href, title: '', desc: '', thumb: '', site, ratio }
}

/**
 * Parse a link. null means "not recognized": the caller goes to unfurl for a
 * card. No network calls.
 */
export function resolveEmbed(url: string): EmbedDescriptor | null {
  let u: URL
  try {
    u = new URL(String(url || '').trim())
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

  const host = u.hostname.replace(/^www\./, '').toLowerCase()
  const site = host
  const href = u.toString()
  const p = seg(u)

  // --- video hosting --------------------------------------------------------- //

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com' || host === 'youtu.be') {
    let id = ''
    let vertical = false
    if (host === 'youtu.be') id = p[0] || ''
    else if (p[0] === 'watch') id = u.searchParams.get('v') || ''
    else if (p[0] === 'shorts') { id = p[1] || ''; vertical = true }
    else if (p[0] === 'embed' || p[0] === 'live' || p[0] === 'v') id = p[1] || ''
    id = id.replace(/[^A-Za-z0-9_-]/g, '')
    if (id) {
      const t = u.searchParams.get('t') || u.searchParams.get('start') || ''
      const start = /^\d+$/.test(t) ? `?start=${t}` : ''
      return make('embed', 'youtube', `https://www.youtube.com/embed/${id}${start}`, href,
        vertical ? RATIO_VERTICAL : RATIO_16_9, site)
    }
    return null
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    // /123456, /channels/x/123456, /player.vimeo.com/video/123456 — take the last number
    const id = [...p].reverse().find((s) => /^\d+$/.test(s)) || ''
    if (id) return make('embed', 'vimeo', `https://player.vimeo.com/video/${id}`, href, RATIO_16_9, site)
    return null
  }

  if (host === 'rutube.ru') {
    // rutube.ru/video/<hash>/ and rutube.ru/play/embed/<hash>
    const i = p.indexOf('video')
    const id = (p[0] === 'play' && p[1] === 'embed' ? p[2] : i >= 0 ? p[i + 1] : '') || ''
    const safe = id.replace(/[^a-f0-9]/gi, '')
    if (safe) return make('embed', 'rutube', `https://rutube.ru/play/embed/${safe}`, href, RATIO_16_9, site)
    return null
  }

  if (host === 'vk.com' || host === 'vkvideo.ru' || host === 'm.vk.com') {
    // vk.com/video-1_2, vk.com/clip-1_2, vkvideo.ru/video-1_2, video_ext.php?oid&id
    const raw = p[0] === 'video_ext.php' ? '' : (p.find((s) => /^(video|clip)-?\d+_\d+$/.test(s)) || '')
    const m = raw.match(/^(video|clip)(-?\d+)_(\d+)$/)
    if (m) {
      const vertical = m[1] === 'clip'
      return make('embed', 'vk', `https://vk.com/video_ext.php?oid=${m[2]}&id=${m[3]}&hd=2`, href,
        vertical ? RATIO_VERTICAL : RATIO_16_9, site)
    }
    const oid = u.searchParams.get('oid')
    const id = u.searchParams.get('id')
    if (oid && id && /^-?\d+$/.test(oid) && /^\d+$/.test(id)) {
      return make('embed', 'vk', `https://vk.com/video_ext.php?oid=${oid}&id=${id}&hd=2`, href, RATIO_16_9, site)
    }
    return null
  }

  if (host === 'dzen.ru') {
    // dzen.ru/video/watch/<id> and dzen.ru/embed/<id>
    const id = (p[0] === 'video' && p[1] === 'watch' ? p[2] : p[0] === 'embed' ? p[1] : '') || ''
    const safe = id.replace(/[^a-z0-9_-]/gi, '')
    if (safe) return make('embed', 'dzen', `https://dzen.ru/embed/${safe}`, href, RATIO_16_9, site)
    return null
  }

  if (host === 'ok.ru' || host === 'odnoklassniki.ru') {
    const i = p.indexOf('video')
    const id = (i >= 0 ? p[i + 1] : '') || ''
    if (/^\d+$/.test(id)) return make('embed', 'ok', `https://ok.ru/videoembed/${id}`, href, RATIO_16_9, site)
    return null
  }

  if (host === 'dailymotion.com' || host === 'dai.ly') {
    const id = (host === 'dai.ly' ? p[0] : p[0] === 'video' ? p[1] : '') || ''
    const safe = id.split('_')[0].replace(/[^a-z0-9]/gi, '')
    if (safe) return make('embed', 'dailymotion', `https://www.dailymotion.com/embed/video/${safe}`, href, RATIO_16_9, site)
    return null
  }

  if (host === 'twitch.tv' || host === 'clips.twitch.tv') {
    const parent = embedParent()
    if (host === 'clips.twitch.tv' && p[0]) {
      return make('embed', 'twitch', `https://clips.twitch.tv/embed?clip=${encodeURIComponent(p[0])}&parent=${parent}`, href, RATIO_16_9, site)
    }
    if (p[0] === 'videos' && /^\d+$/.test(p[1] || '')) {
      return make('embed', 'twitch', `https://player.twitch.tv/?video=${p[1]}&parent=${parent}&autoplay=false`, href, RATIO_16_9, site)
    }
    if (p[0] && p[1] === 'clip' && p[2]) {
      return make('embed', 'twitch', `https://clips.twitch.tv/embed?clip=${encodeURIComponent(p[2])}&parent=${parent}`, href, RATIO_16_9, site)
    }
    if (p[0] && !p[1]) {
      return make('embed', 'twitch', `https://player.twitch.tv/?channel=${encodeURIComponent(p[0])}&parent=${parent}&autoplay=false`, href, RATIO_16_9, site)
    }
    return null
  }

  if (host === 'coub.com') {
    const id = (p[0] === 'view' ? p[1] : '') || ''
    const safe = id.replace(/[^a-z0-9]/gi, '')
    if (safe) return make('embed', 'coub', `https://coub.com/embed/${safe}?muted=false&autostart=false`, href, RATIO_16_9, site)
    return null
  }

  if (host === 'tiktok.com' || host === 'vm.tiktok.com') {
    const i = p.indexOf('video')
    const id = (i >= 0 ? p[i + 1] : '') || ''
    if (/^\d+$/.test(id)) {
      return make('embed', 'tiktok', `https://www.tiktok.com/embed/v2/${id}`, href, RATIO_VERTICAL, site)
    }
    return null // short vm.tiktok.com/... — id only appears after the redirect, fall back to a card
  }

  // --- audio/music ------------------------------------------------------------ //

  if (host === 'soundcloud.com' || host === 'm.soundcloud.com') {
    // SoundCloud's player accepts the track URL itself — no need to know the id
    return make('embed', 'soundcloud',
      `https://w.soundcloud.com/player/?url=${encodeURIComponent(href)}&color=%23444444&show_teaser=false`,
      href, 24, site)
  }

  if (host === 'spotify.com' || host === 'open.spotify.com') {
    const type = p[0] || ''
    const id = (p[1] || '').replace(/[^A-Za-z0-9]/g, '')
    if (['track', 'album', 'playlist', 'episode', 'show', 'artist'].includes(type) && id) {
      // track/episode — compact player, collections — tall with a list
      const ratio = type === 'track' || type === 'episode' ? 22 : 60
      return make('embed', 'spotify', `https://open.spotify.com/embed/${type}/${id}`, href, ratio, site)
    }
    return null
  }

  if (host === 'music.yandex.ru' || host === 'music.yandex.com') {
    const album = p[0] === 'album' ? (p[1] || '') : ''
    const track = p[2] === 'track' ? (p[3] || '') : ''
    if (album && track && /^\d+$/.test(album) && /^\d+$/.test(track)) {
      return make('embed', 'yandex-music', `https://music.yandex.ru/iframe/track/${track}/${album}`, href, 22, 'music.yandex.ru')
    }
    if (album && /^\d+$/.test(album)) {
      return make('embed', 'yandex-music', `https://music.yandex.ru/iframe/album/${album}`, href, 60, 'music.yandex.ru')
    }
    return null
  }

  // --- other widgets ----------------------------------------------------------- //

  if (host === 't.me' || host === 'telegram.me') {
    // t.me/<channel>/<messageId> — post widget
    if (p[0] && /^\d+$/.test(p[1] || '')) {
      const chan = p[0].replace(/[^A-Za-z0-9_]/g, '')
      if (chan) {
        return make('embed', 'telegram', `https://t.me/${chan}/${p[1]}?embed=1&dark=0`, href, 60, 't.me')
      }
    }
    return null
  }

  if (host === 'loom.com') {
    const id = (p[0] === 'share' || p[0] === 'embed' ? p[1] : '') || ''
    const safe = id.split('?')[0].replace(/[^a-f0-9]/gi, '')
    if (safe) return make('embed', 'loom', `https://www.loom.com/embed/${safe}`, href, RATIO_16_9, site)
    return null
  }

  if (host === 'figma.com') {
    if (['file', 'design', 'proto', 'board', 'slides'].includes(p[0] || '')) {
      return make('embed', 'figma',
        `https://www.figma.com/embed?embed_host=ideata&url=${encodeURIComponent(href)}`, href, 60, site)
    }
    return null
  }

  if (host === 'codepen.io') {
    // codepen.io/<user>/pen/<slug> → /<user>/embed/<slug>
    if (p[0] && (p[1] === 'pen' || p[1] === 'embed' || p[1] === 'details' || p[1] === 'full') && p[2]) {
      const user = encodeURIComponent(p[0])
      const slug = encodeURIComponent(p[2])
      return make('embed', 'codepen', `https://codepen.io/${user}/embed/${slug}?default-tab=result`, href, 60, site)
    }
    return null
  }

  if (host === 'jsfiddle.net') {
    // jsfiddle.net/<user>/<slug>/ or jsfiddle.net/<slug>/ → …/embedded/
    const parts = p.filter((s) => s !== 'embedded' && s !== 'show').slice(0, 3)
    if (parts.length) {
      const path = parts.map((s) => encodeURIComponent(s)).join('/')
      return make('embed', 'jsfiddle', `https://jsfiddle.net/${path}/embedded/`, href, 60, site)
    }
    return null
  }

  if (host === 'gist.github.com') {
    // .pibb — the official "iframe version" of a gist (regular gist.js requires <script>)
    if (p[0] && p[1]) {
      const user = encodeURIComponent(p[0])
      const id = p[1].replace(/[^a-f0-9]/gi, '')
      if (id) return make('embed', 'gist', `https://gist.github.com/${user}/${id}.pibb`, href, 45, site)
    }
    return null
  }

  if (host === 'docs.google.com') {
    const type = p[0] || ''
    const id = p[1] === 'd' ? (p[2] || '') : (p[2] === 'd' ? (p[3] || '') : '')
    const safe = id.replace(/[^A-Za-z0-9_-]/g, '')
    if (safe) {
      if (type === 'document') return make('embed', 'google-docs', `https://docs.google.com/document/d/${safe}/preview`, href, 100, site)
      if (type === 'spreadsheets') return make('embed', 'google-sheets', `https://docs.google.com/spreadsheets/d/${safe}/preview`, href, 75, site)
      if (type === 'presentation') return make('embed', 'google-slides', `https://docs.google.com/presentation/d/${safe}/embed`, href, RATIO_16_9, site)
      if (type === 'forms') return make('embed', 'google-forms', `https://docs.google.com/forms/d/${safe}/viewform?embedded=true`, href, 120, site)
    }
    if (type === 'forms' && p.includes('e')) {
      // modern form links: /forms/d/e/<longId>/viewform
      const e = p[p.indexOf('e') + 1] || ''
      const safeE = e.replace(/[^A-Za-z0-9_-]/g, '')
      if (safeE) return make('embed', 'google-forms', `https://docs.google.com/forms/d/e/${safeE}/viewform?embedded=true`, href, 120, site)
    }
    return null
  }

  if (host === 'google.com' || host === 'maps.google.com' || host === 'goo.gl') {
    if (u.pathname.startsWith('/maps/embed')) {
      return make('embed', 'google-maps', href, href, 60, 'google.com')
    }
    if (u.pathname.startsWith('/maps')) {
      // arbitrary map link: Google itself serves an embeddable version via q=
      const q = u.searchParams.get('q')
        || decodeURIComponent(p[p.indexOf('place') + 1] || '')
        || (u.pathname.match(/@(-?[\d.]+,-?[\d.]+)/)?.[1] ?? '')
      if (q) {
        return make('embed', 'google-maps',
          `https://www.google.com/maps?output=embed&q=${encodeURIComponent(q)}`, href, 60, 'google.com')
      }
    }
    return null
  }

  if (host === 'yandex.ru' || host === 'yandex.com') {
    // yandex.ru/maps/... → maps widget; an already-ready map-widget passes through as-is
    if (u.pathname.startsWith('/map-widget')) {
      return make('embed', 'yandex-maps', href, href, 60, 'yandex.ru')
    }
    if (u.pathname.startsWith('/maps')) {
      return make('embed', 'yandex-maps',
        `https://yandex.ru/map-widget/v1/${u.search || ''}${u.hash || ''}`, href, 60, 'yandex.ru')
    }
    return null
  }

  // --- direct file link --------------------------------------------------------- //

  const ext = (u.pathname.split('.').pop() || '').toLowerCase()
  const fileKind = FILE_KIND[ext]
  if (fileKind) {
    const d = make(fileKind, 'direct', href, href, fileKind === 'audio' ? 0 : RATIO_16_9, site)
    d.title = decodeURIComponent(p[p.length - 1] || '')
    return d
  }

  return null
}
