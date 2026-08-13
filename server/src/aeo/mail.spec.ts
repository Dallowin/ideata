/**
 * Mailer (port of mailer.py). We verify driver SELECTION against an injectable
 * mock transport (network/SMTP untouched — money/mail safety), the
 * mailDriver/mailConfigured truth table, and env parsing (sender/smtpConfig/bccList).
 * sendMail never throws: no recipient / mail not configured / driver failure →
 * {sent:false,...}, not an exception.
 */
import {
  sendMail,
  mailDriver,
  mailConfigured,
  sender,
  smtpConfig,
  bccList,
  type MailTransport,
  type MailMessage,
  type MailResult,
} from './mail';

// All mail-related env keys that we reset between tests.
const MAIL_KEYS = [
  'MAIL_DRIVER',
  'RESEND_API_KEY',
  'BREVO_API_KEY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'SMTP_FROM',
  'SMTP_SSL',
  'SMTP_TLS',
];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of MAIL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of MAIL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Spy transport: records which driver was called, without sending anything. */
function spyTransport(): { transport: MailTransport; calls: string[]; lastMsg: MailMessage | null } {
  const calls: string[] = [];
  let lastMsg: MailMessage | null = null;
  const mk = (name: string) => async (msg: MailMessage): Promise<MailResult> => {
    calls.push(name);
    lastMsg = msg;
    return { sent: true };
  };
  return {
    calls,
    get lastMsg() {
      return lastMsg;
    },
    transport: { resend: mk('resend'), brevo: mk('brevo'), smtp: mk('smtp') },
  };
}

const MSG: MailMessage = { to: 'user@x.io', subject: 'S', text: 'T', html: '<b>H</b>' };

describe('mailDriver — explicit MAIL_DRIVER and auto-select by keys', () => {
  it('explicit smtp/resend/brevo is respected even without credentials', () => {
    process.env.MAIL_DRIVER = 'smtp';
    expect(mailDriver()).toBe('smtp');
    process.env.MAIL_DRIVER = 'resend';
    expect(mailDriver()).toBe('resend');
    process.env.MAIL_DRIVER = 'brevo';
    expect(mailDriver()).toBe('brevo');
  });
  it('invalid MAIL_DRIVER → auto-select by keys', () => {
    process.env.MAIL_DRIVER = 'sendgrid';
    process.env.BREVO_API_KEY = 'k';
    expect(mailDriver()).toBe('brevo');
  });
  it('auto-select priority: resend → brevo → smtp', () => {
    process.env.SMTP_HOST = 'mx';
    expect(mailDriver()).toBe('smtp');
    process.env.BREVO_API_KEY = 'k';
    expect(mailDriver()).toBe('brevo');
    process.env.RESEND_API_KEY = 'k';
    expect(mailDriver()).toBe('resend');
  });
  it('no driver, no keys → null', () => {
    expect(mailDriver()).toBeNull();
  });
});

describe('mailConfigured — whether the selected driver has credentials', () => {
  it('resend/brevo/smtp — by their own key/host', () => {
    process.env.RESEND_API_KEY = 'k';
    expect(mailConfigured()).toBe(true);
    delete process.env.RESEND_API_KEY;
    process.env.BREVO_API_KEY = 'k';
    expect(mailConfigured()).toBe(true);
    delete process.env.BREVO_API_KEY;
    process.env.SMTP_HOST = 'mx';
    expect(mailConfigured()).toBe(true);
  });
  it('explicit MAIL_DRIVER=smtp without SMTP_HOST → not configured', () => {
    process.env.MAIL_DRIVER = 'smtp';
    expect(mailDriver()).toBe('smtp');
    expect(mailConfigured()).toBe(false);
  });
  it('nothing set → false', () => {
    expect(mailConfigured()).toBe(false);
  });
});

describe('sender / smtpConfig / bccList — env parsing', () => {
  it('sender: SMTP_FROM → SMTP_USER → default', () => {
    expect(sender()).toBe('no-reply@ideata.io');
    process.env.SMTP_USER = 'u@x.io';
    expect(sender()).toBe('u@x.io');
    process.env.SMTP_FROM = 'from@x.io';
    expect(sender()).toBe('from@x.io');
  });
  it('smtpConfig: null without host; port/ssl/tls from env', () => {
    expect(smtpConfig()).toBeNull();
    process.env.SMTP_HOST = 'mx';
    process.env.SMTP_PORT = '465';
    process.env.SMTP_SSL = 'true';
    const cfg = smtpConfig()!;
    expect(cfg).toMatchObject({ host: 'mx', port: 465, ssl: true, tls: true });
  });
  it('smtpConfig: bad port → 587; SMTP_TLS=0 disables STARTTLS', () => {
    process.env.SMTP_HOST = 'mx';
    process.env.SMTP_PORT = 'oops';
    process.env.SMTP_TLS = '0';
    const cfg = smtpConfig()!;
    expect(cfg.port).toBe(587);
    expect(cfg.tls).toBe(false);
  });
  it('bccList: string/array/empty → list of non-empty addresses', () => {
    expect(bccList(null)).toEqual([]);
    expect(bccList('a@x.io')).toEqual(['a@x.io']);
    expect(bccList([' a@x.io ', '', ' b@x.io'])).toEqual(['a@x.io', 'b@x.io']);
  });
});

describe('sendMail — dispatch by driver on a mock transport', () => {
  it('MAIL_DRIVER=resend → calls transport.resend, leaves the rest untouched', async () => {
    process.env.MAIL_DRIVER = 'resend';
    const spy = spyTransport();
    const res = await sendMail(MSG, { transport: spy.transport });
    expect(spy.calls).toEqual(['resend']);
    expect(res).toEqual({ sent: true, driver: 'resend' });
    expect(spy.lastMsg).toMatchObject({ to: 'user@x.io', subject: 'S' });
  });
  it('MAIL_DRIVER=brevo → transport.brevo', async () => {
    process.env.MAIL_DRIVER = 'brevo';
    const spy = spyTransport();
    const res = await sendMail(MSG, { transport: spy.transport });
    expect(spy.calls).toEqual(['brevo']);
    expect(res.driver).toBe('brevo');
  });
  it('MAIL_DRIVER=smtp → transport.smtp', async () => {
    process.env.MAIL_DRIVER = 'smtp';
    const spy = spyTransport();
    await sendMail(MSG, { transport: spy.transport });
    expect(spy.calls).toEqual(['smtp']);
  });
  it('auto-select by RESEND_API_KEY → transport.resend', async () => {
    process.env.RESEND_API_KEY = 'k';
    const spy = spyTransport();
    await sendMail(MSG, { transport: spy.transport });
    expect(spy.calls).toEqual(['resend']);
  });
  it('no driver → {sent:false,mail not configured}, transport not called', async () => {
    const spy = spyTransport();
    const res = await sendMail(MSG, { transport: spy.transport });
    expect(res).toEqual({ sent: false, error: 'mail not configured' });
    expect(spy.calls).toEqual([]);
  });
  it('no recipient → {sent:false,no recipient}', async () => {
    process.env.MAIL_DRIVER = 'resend';
    const spy = spyTransport();
    const res = await sendMail({ ...MSG, to: '' }, { transport: spy.transport });
    expect(res).toEqual({ sent: false, error: 'no recipient' });
    expect(spy.calls).toEqual([]);
  });
  it('a driver failure does not throw → {sent:false,error,driver}', async () => {
    process.env.MAIL_DRIVER = 'smtp';
    const transport: MailTransport = {
      resend: async () => ({ sent: true }),
      brevo: async () => ({ sent: true }),
      smtp: async () => {
        throw new Error('smtp down');
      },
    };
    const res = await sendMail(MSG, { transport });
    expect(res).toEqual({ sent: false, error: 'smtp down', driver: 'smtp' });
  });
  it('propagates a driver error (e.g. resend 4xx) as-is', async () => {
    process.env.MAIL_DRIVER = 'resend';
    const transport: MailTransport = {
      resend: async () => ({ sent: false, error: 'resend 422' }),
      brevo: async () => ({ sent: true }),
      smtp: async () => ({ sent: true }),
    };
    const res = await sendMail(MSG, { transport });
    expect(res).toEqual({ sent: false, error: 'resend 422', driver: 'resend' });
  });
});
