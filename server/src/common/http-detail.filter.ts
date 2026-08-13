import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Error body shape like FastAPI's: /api/public/* has historically returned
 * {"detail": "..."} (HTTPException), and the frontend (web) reads
 * `e.data.detail` everywhere. NestJS returns {statusCode, message, error} by
 * default; without this filter, after switching nginx to NestJS, the Russian
 * texts for 402 (paywall), 429 (quota) and others would stop reaching the user.
 *
 * The filter is additive: it keeps message/error and adds `detail` (= message).
 * Applied selectively to the public-api REST controllers (@UseFilters) so it
 * doesn't touch the GraphQL context, where HTTP response handling doesn't apply.
 */
@Catch()
export class HttpDetailFilter implements ExceptionFilter {
  private readonly logger = new Logger('PublicApi');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let payload: Record<string, unknown> = {
      statusCode: status,
      message: 'internal error',
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      payload =
        typeof body === 'string'
          ? { statusCode: status, message: body }
          : { statusCode: status, ...(body as Record<string, unknown>) };
    } else {
      this.logger.error(
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    // message can be a string or an array (validation) — detail is always a string.
    const msg = payload.message;
    if (payload.detail === undefined) {
      payload.detail = Array.isArray(msg) ? msg.join('; ') : msg;
    }
    res.status(status).json(payload);
  }
}
