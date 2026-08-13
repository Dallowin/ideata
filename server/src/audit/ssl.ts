/**
 * Domain TLS certificate — port of core/ssl_check.py.
 *
 * The only tech-audit check that talks raw socket instead of HTTP: fetch on
 * an expired certificate throws and never lets you reach the certificate
 * itself — which is exactly what's needed to tell "expired 3 days ago" apart
 * from "domain doesn't resolve".
 *
 * So we connect twice: first with verification (chain and hostname checked),
 * and on failure without it, so we can still read notAfter and report the reason.
 *
 * ALPN is asked for here too, because it's the only honest way to know whether
 * the server supports HTTP/2: you can't tell from the HTTP response — the
 * response describes the client's capabilities, and any server would "turn out"
 * to be HTTP/1.1.
 */
import * as tls from 'node:tls';
import * as net from 'node:net';

const TIMEOUT_MS = 10_000;
const PORT = 443;

export interface SslInfo {
  valid: boolean;
  issuer: string | null;
  expires: string | null;   // ISO
  days_left: number | null;
  protocol: string | null;  // TLS version
  alpn: string | null;      // 'h2' | 'http/1.1' | null
  error: string | null;
}

/** Organization or CN from the issuer — what we show as "issued by". */
function issuerName(issuer: tls.PeerCertificate['issuer'] | undefined): string | null {
  if (!issuer) return null;
  const rec = issuer as unknown as Record<string, string | string[]>;
  for (const key of ['O', 'CN']) {          // organizationName, commonName
    const v = rec[key];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && v.length) return v[0];
  }
  return null;
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  // Python takes .days off a timedelta — i.e. truncation toward zero, not rounding.
  return Math.trunc(ms / 86_400_000);
}

interface Handshake {
  cert: tls.PeerCertificate;
  protocol: string | null;
  alpn: string | null;
  authorized: boolean;
  authError: string | null;
}

/** A single TLS handshake. `rejectUnauthorized: false` lets us read a bad certificate. */
function handshake(domain: string, verify: boolean): Promise<Handshake | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: Handshake | null) => { if (!settled) { settled = true; resolve(v); } };

    const socket = tls.connect({
      host: domain,
      port: PORT,
      servername: domain,               // SNI: without it you'd get the default certificate
      ALPNProtocols: ['h2', 'http/1.1'],
      rejectUnauthorized: verify,
      timeout: TIMEOUT_MS,
    }, () => {
      const cert = socket.getPeerCertificate();
      const out: Handshake = {
        cert,
        protocol: socket.getProtocol(),
        alpn: (socket.alpnProtocol as string) || null,
        authorized: socket.authorized,
        authError: socket.authorizationError ? String(socket.authorizationError) : null,
      };
      socket.destroy();
      done(cert && Object.keys(cert).length ? out : null);
    });

    socket.on('error', (e) => {
      // With verify=true, "certificate invalid" lands here too — that's expected,
      // we'll read it without verification on the second pass.
      (socket as any)._authError = e;
      socket.destroy();
      done(null);
    });
    socket.on('timeout', () => { socket.destroy(); done(null); });
  });
}

/** Whether port 443 answers at all — distinguishes "bad certificate" from "no HTTPS". */
function portOpen(domain: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: domain, port: PORT, timeout: TIMEOUT_MS });
    const done = (v: boolean) => { socket.destroy(); resolve(v); };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('timeout', () => done(false));
  });
}

/** → SslInfo, or null if the host is unreachable on 443. */
export async function checkSsl(domain: string): Promise<SslInfo | null> {
  if (!domain) return null;

  const verified = await handshake(domain, true);
  if (verified) {
    const expires = verified.cert.valid_to ? new Date(verified.cert.valid_to).toISOString() : null;
    return {
      valid: true,
      issuer: issuerName(verified.cert.issuer),
      expires,
      days_left: daysUntil(expires),
      protocol: verified.protocol,
      alpn: verified.alpn,
      error: null,
    };
  }

  // Verification failed — either the certificate is bad or the host is dead.
  // We tell these apart with a separate plain-TCP connection.
  if (!(await portOpen(domain))) return null;

  const raw = await handshake(domain, false);
  if (!raw) {
    return {
      valid: false, issuer: null, expires: null, days_left: null,
      protocol: null, alpn: null, error: 'certificate failed verification',
    };
  }

  const expires = raw.cert.valid_to ? new Date(raw.cert.valid_to).toISOString() : null;
  const days = daysUntil(expires);
  return {
    valid: false,
    issuer: issuerName(raw.cert.issuer),
    expires,
    days_left: days,
    // We don't report protocol and ALPN: with an invalid certificate the browser
    // never reaches the application layer, so talking about HTTP/2 is moot.
    protocol: null,
    alpn: null,
    error: days !== null && days < 0 ? 'certificate expired' : 'certificate failed verification',
  };
}
