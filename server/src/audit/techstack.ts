/**
 * Tech stack detection from HTML and headers — port of core/techstack.py.
 *
 * Instead of paid BuiltWith/Wappalyzer — a small signature matcher. Enough
 * for the tech passport: framework, analytics, CDN, hosting, payment provider.
 */

const CYRILLIC = /[а-яё]/gi;
const LANG_RU = /<html[^>]*\blang=["']?ru/i;

/**
 * Is this a Russian-market site? `<html lang="ru">` or a lot of Cyrillic in the text.
 * This signal sends SEO tooling to Keys.so (Yandex) even for an RU product on .com.
 */
export function looksRussian(html: string): boolean {
  const h = html || '';
  if (LANG_RU.test(h)) return true;
  return (h.slice(0, 20_000).match(CYRILLIC) || []).length > 200;
}

// name → [category, substrings in html/headers (lowercase)]
const SIG: Record<string, [string, string[]]> = {
  'Stripe': ['payment', ['js.stripe.com', 'stripe.com/v3', 'data-stripe']],
  'Paddle': ['payment', ['cdn.paddle.com', 'paddle.setup', 'paddle_button']],
  'Lemon Squeezy': ['payment', ['lemonsqueezy', 'lmsqueezy']],
  'PayPal': ['payment', ['paypal.com/sdk', 'paypalobjects']],
  'Next.js': ['framework', ['/_next/', '__next_data__', 'id="__next"']],
  'Nuxt': ['framework', ['/_nuxt/', '__nuxt__']],
  'React': ['framework', ['data-reactroot', 'react-dom']],
  'Vue': ['framework', ['data-v-', '__vue__']],
  'Svelte': ['framework', ['svelte-']],
  'Tailwind': ['framework', ['tailwind']],
  'Webflow': ['framework', ['webflow']],
  'WordPress': ['framework', ['wp-content', 'wp-includes']],
  'Vercel': ['hosting', ['vercel.app', 'x-vercel-id', 'x-vercel-cache']],
  'Netlify': ['hosting', ['netlify']],
  'Cloudflare': ['cdn', ['cf-ray', 'cloudflare']],
  'Google Analytics': ['analytics', ['gtag/js', 'google-analytics.com', 'googletagmanager.com']],
  'Mixpanel': ['analytics', ['cdn.mxpnl.com', 'mixpanel']],
  'PostHog': ['analytics', ['posthog']],
  'Plausible': ['analytics', ['plausible.io']],
  'Amplitude': ['analytics', ['amplitude.com', 'cdn.amplitude']],
  'Meta Pixel': ['ads', ['connect.facebook.net', 'fbevents.js', 'fbq(']],
  'Google Ads': ['ads', ['googleadservices', 'google_conversion', 'gtag/js?id=aw-']],
  'TikTok Pixel': ['ads', ['analytics.tiktok.com', 'ttq.load']],
  'Intercom': ['chat', ['widget.intercom.io', 'intercomsettings']],
  'Crisp': ['chat', ['client.crisp.chat']],
  'Tawk.to': ['chat', ['embed.tawk.to']],
};

export interface TechStack {
  tech: string[];
  payment: string | null;
  by_category: Record<string, string[]>;
  is_ru: boolean;
}

/** Matches signatures against the page HTML and response headers. No network. */
export function detectTechstack(html: string, headers?: Record<string, string>): TechStack {
  let hay = (html || '').toLowerCase();
  if (headers) {
    hay += ` ${Object.entries(headers).map(([k, v]) => `${k}:${v}`.toLowerCase()).join(' ')}`;
  }
  const tech: string[] = [];
  const byCategory: Record<string, string[]> = {};
  let payment: string | null = null;

  for (const [name, [cat, pats]] of Object.entries(SIG)) {
    if (pats.some((p) => hay.includes(p))) {
      tech.push(name);
      (byCategory[cat] ||= []).push(name);
      if (cat === 'payment' && payment === null) payment = name;
    }
  }
  return { tech, payment, by_category: byCategory, is_ru: looksRussian(html) };
}
