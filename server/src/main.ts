import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { json, urlencoded, raw } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  // The BOT_INGEST_SECRET fallback DIFFERS between api (its own SESSION_SECRET)
  // and scrapper (its own) — without an explicit secret, bot ingest tokens will
  // diverge once nginx switches to NestJS (see scrapper/deploy/CUTOVER.md step 0).
  if (process.env.NODE_ENV === 'production' && !process.env.BOT_INGEST_SECRET) {
    new Logger('PublicApi').warn(
      'BOT_INGEST_SECRET is not set — bot ingest tokens are signed with the fallback ' +
        '(SESSION_SECRET), which differs from scrapper. Set it identically on both services.',
    );
  }
  // disable Nest's default 100kb body parser; long blog posts (10k-word
  // longreads) easily exceed it once Cyrillic is UTF-8 encoded
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  // blog-writer cover-save posts a raw JPEG (canvas-composited cover) — parse it
  // as a Buffer for this route only, BEFORE the global json parser.
  app.use('/blogwriter/runs/:id/cover-save', raw({ type: 'image/jpeg', limit: '10mb' }));
  // content factory: media uploads (photo/video) for adapted posts — RAW bytes
  // with Content-Type image/* | video/*, up to 80MB (video); parsed as a Buffer before json.
  app.use('/blogwriter/runs/:id/crosspost/media', (req, res, next) =>
    req.method === 'POST'
      ? raw({ type: ['image/*', 'video/*'], limit: '80mb' })(req, res, next)
      : next(),
  );
  // article-body media (editor images/video/audio/files) — also RAW bytes with
  // the file's real MIME type; up to 100MB (video). POST only: this same path
  // also serves the article-library GET, and the raw parser would silently swallow it.
  app.use('/blogwriter/runs/:id/media', (req, res, next) =>
    req.method === 'POST'
      ? raw({ type: ['image/*', 'video/*', 'audio/*', 'application/*', 'text/*'], limit: '100mb' })(req, res, next)
      : next(),
  );
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));
  app.use(cookieParser());
  app.enableCors({ origin: true, credentials: true });
  await app.listen(process.env.PORT ?? 4000);
}
bootstrap();
