/**
 * The unified Nest-layer mailer — a port of scrapper/web/mailer.py (lines 1-239).
 * Nest had no mail at all before this; weekly AEO reports (reports.ts) send
 * emails through `sendMail`. The driver is picked via the `MAIL_DRIVER` env
 * ('smtp'|'resend'|'brevo') or auto-selected by which keys are present —
 * verbatim mailer.mail_driver:61-74.
 *
 * Why HTTP APIs by default and not SMTP: the host of both prod VPSes blocks ALL
 * outbound SMTP ports (25/465/587), so the real prod driver is Resend (HTTP).
 * SMTP is kept for local/future use and only activates via an explicit
 * MAIL_DRIVER=smtp or when SMTP_HOST is set without any HTTP-provider keys.
 *
 * Transports:
 *   • resend/brevo — the global `fetch` (Node 18+; Node 22 in prod), no new
 *     dependencies, exactly like httpx.post in mailer.py;
 *   • smtp — nodemailer (a new dependency), LAZILY loaded via a dynamic
 *     import: mail.ts does not pull in nodemailer until the smtp driver is
 *     actually selected, so the HTTP process/tests never load it and the
 *     build does not depend on its presence.
 *
 * Testability and money safety: the real transports are injectable
 * (`sendMail(msg, {transport})`) — tests supply a spy and verify the driver
 * SELECTION, without touching the network/SMTP. `sendMail` NEVER throws: a
 * mail failure must not bring down the caller (a job/delivery run), just like
 * send_email in mailer.py.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** The active mail driver. */
export type MailDriver = 'smtp' | 'resend' | 'brevo';

/** A single email: recipient, subject, HTML and/or plain text, bcc. */
export interface MailMessage {
  to: string;
  subject: string;
  html?: string | null;
  text?: string | null;
  /** Bcc (address or list). For SMTP this only goes into the envelope (no header). */
  bcc?: string | string[] | null;
}

/** Delivery result: {sent, error?, driver?} — matches the dict from send_email. */
export interface MailResult {
  sent: boolean;
  error?: string;
  driver?: MailDriver;
}

/** SMTP config from the environment (port of mailer.smtp_config:89-105). */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  ssl: boolean;
  tls: boolean;
}

/**
 * Transport — the sender implementation for the selected driver. The default
 * hits the network (fetch/nodemailer); tests inject a spy to verify driver
 * selection without the network. Each method reads its own credentials from
 * env (like _send_* in mailer.py).
 */
export interface MailTransport {
  resend(msg: MailMessage): Promise<MailResult>;
  brevo(msg: MailMessage): Promise<MailResult>;
  smtp(msg: MailMessage): Promise<MailResult>;
}

// ── env reading (port of mailer.py) ───────────────────────────────────────────

/** `os.environ.get(name, "").strip()`. */
function envStr(name: string): string {
  return (process.env[name] || '').trim();
}

/** Python-style "enabled" flag: value NOT in {0,false,no,off} (default on). */
function envFlagOn(name: string, def: boolean): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (v === '') return def;
  return !['0', 'false', 'no', 'off'].includes(v);
}

/**
 * Sender address (shared across all drivers) — port of mailer.sender:38-42:
 * SMTP_FROM → SMTP_USER → 'no-reply@ideata.io'.
 */
export function sender(): string {
  return envStr('SMTP_FROM') || envStr('SMTP_USER') || 'no-reply@ideata.io';
}

/**
 * The active driver — port of mailer.mail_driver:61-74. An explicit MAIL_DRIVER
 * (smtp/resend/brevo) is respected EVEN without credentials (then mailConfigured
 * returns false and the driver itself returns a credentials error); otherwise
 * auto-select: RESEND_API_KEY→resend, BREVO_API_KEY→brevo, SMTP_HOST→smtp;
 * nothing → null ("mail not configured").
 */
export function mailDriver(): MailDriver | null {
  const d = (process.env.MAIL_DRIVER || '').trim().toLowerCase();
  if (d === 'smtp' || d === 'resend' || d === 'brevo') return d;
  if (envStr('RESEND_API_KEY')) return 'resend';
  if (envStr('BREVO_API_KEY')) return 'brevo';
  if (envStr('SMTP_HOST')) return 'smtp';
  return null;
}

/** Whether the selected driver is ready to send (has credentials) — port of mail_configured:77-86. */
export function mailConfigured(): boolean {
  const d = mailDriver();
  if (d === 'resend') return !!envStr('RESEND_API_KEY');
  if (d === 'brevo') return !!envStr('BREVO_API_KEY');
  if (d === 'smtp') return !!envStr('SMTP_HOST');
  return false;
}

/** SMTP config from env, or null (host is empty) — port of smtp_config:89-105. */
export function smtpConfig(): SmtpConfig | null {
  const host = envStr('SMTP_HOST');
  if (!host) return null;
  const rawPort = (process.env.SMTP_PORT || '').trim();
  let port = parseInt(rawPort || '587', 10);
  if (!Number.isFinite(port)) port = 587;
  return {
    host,
    port,
    user: envStr('SMTP_USER'),
    password: process.env.SMTP_PASSWORD || '',
    from: sender(),
    ssl: ['1', 'true', 'yes', 'on'].includes((process.env.SMTP_SSL || '').toLowerCase()),
    tls: envFlagOn('SMTP_TLS', true),
  };
}

/** Normalize bcc: string/list/empty → a list of non-empty addresses (port of _bcc_list:53-58). */
export function bccList(bcc: string | string[] | null | undefined): string[] {
  if (!bcc) return [];
  const items = typeof bcc === 'string' ? [bcc] : bcc;
  return items.map((a) => (a || '').trim()).filter((a) => a.length > 0);
}

// ── default transports (real network) ─────────────────────────────────────────

/** Resend HTTP API via fetch — port of _send_resend:173-188. */
async function resendSend(msg: MailMessage): Promise<MailResult> {
  const key = envStr('RESEND_API_KEY');
  if (!key) return { sent: false, error: 'no resend key' };
  const body: Record<string, unknown> = {
    from: sender(),
    to: [msg.to],
    subject: msg.subject,
  };
  if (msg.text != null) body.text = msg.text;
  if (msg.html) body.html = msg.html;
  const bcc = bccList(msg.bcc);
  if (bcc.length) body.bcc = bcc;
  const r = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (Math.floor(r.status / 100) === 2) return { sent: true };
  return { sent: false, error: `resend ${r.status}` };
}

/** Brevo HTTP API via fetch — port of _send_brevo:191-207. */
async function brevoSend(msg: MailMessage): Promise<MailResult> {
  const key = envStr('BREVO_API_KEY');
  if (!key) return { sent: false, error: 'no brevo key' };
  const body: Record<string, unknown> = {
    sender: { email: sender() },
    to: [{ email: msg.to }],
    subject: msg.subject,
  };
  if (msg.text != null) body.textContent = msg.text;
  if (msg.html) body.htmlContent = msg.html;
  const bcc = bccList(msg.bcc);
  if (bcc.length) body.bcc = bcc.map((email) => ({ email }));
  const r = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (Math.floor(r.status / 100) === 2) return { sent: true };
  return { sent: false, error: `brevo ${r.status}` };
}

/**
 * Minimal shape of nodemailer.createTransport, so the build's types don't pull
 * in the package: the SMTP path loads nodemailer LAZILY (see loadNodemailer).
 */
interface NodemailerLike {
  createTransport(opts: unknown): {
    sendMail(mail: unknown): Promise<unknown>;
  };
}

/**
 * Lazily loads nodemailer via a variable specifier: TypeScript does not resolve
 * the module for a non-literal `import()` argument (type any), so the
 * build/tests don't depend on the package being present; at runtime Node picks
 * it up if installed (a dependency in package.json). Absence → throws, caught above.
 */
async function loadNodemailer(): Promise<NodemailerLike> {
  const spec = 'nodemailer';
  const mod = (await import(spec)) as unknown as NodemailerLike & { default?: NodemailerLike };
  return (mod.default ?? mod) as NodemailerLike;
}

/** SMTP via nodemailer — port of _send_smtp:210-239 (bcc envelope-only). */
async function smtpSend(msg: MailMessage): Promise<MailResult> {
  const cfg = smtpConfig();
  if (!cfg) return { sent: false, error: 'no smtp' };
  const nm = await loadNodemailer();
  const transporter = nm.createTransport({
    host: cfg.host,
    port: cfg.port,
    // ssl=implicit TLS (465); otherwise STARTTLS per the tls flag (mailer.py: starttls).
    secure: cfg.ssl,
    requireTLS: !cfg.ssl && cfg.tls,
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
  });
  const mail: Record<string, unknown> = {
    from: cfg.from,
    to: msg.to,
    subject: msg.subject,
  };
  if (msg.text != null) mail.text = msg.text;
  if (msg.html) mail.html = msg.html;
  // Bcc goes into the envelope, but nodemailer won't reveal it to the recipient
  // (it doesn't emit a Bcc header in DATA) — equivalent to smtplib.sendmail's rcpt-only.
  const bcc = bccList(msg.bcc);
  if (bcc.length) mail.bcc = bcc;
  await transporter.sendMail(mail);
  return { sent: true };
}

/** Default transport: real delivery (fetch/nodemailer). */
export const defaultTransport: MailTransport = {
  resend: resendSend,
  brevo: brevoSend,
  smtp: smtpSend,
};

// ── public sending ─────────────────────────────────────────────────────────────

/**
 * Send a single email via the selected driver — port of send_email:108-132.
 * Never throws: no recipient → {sent:false,'no recipient'}; mail not configured
 * (driver null) → {sent:false,'mail not configured'}; driver/network failure →
 * {sent:false, error}. Driver selection is mailDriver(); execution is transport
 * (real by default, tests inject a spy).
 */
export async function sendMail(
  msg: MailMessage,
  opts: { transport?: MailTransport } = {},
): Promise<MailResult> {
  if (!msg.to) return { sent: false, error: 'no recipient' };
  const driver = mailDriver();
  if (!driver) return { sent: false, error: 'mail not configured' };
  const transport = opts.transport ?? defaultTransport;
  try {
    let res: MailResult;
    if (driver === 'resend') res = await transport.resend(msg);
    else if (driver === 'brevo') res = await transport.brevo(msg);
    else res = await transport.smtp(msg);
    return { driver, ...res };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e), driver };
  }
}
