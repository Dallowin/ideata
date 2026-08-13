import { HttpException, HttpStatus } from '@nestjs/common';
import { GraphQLError } from 'graphql';

/**
 * Plan limit error factories (stage 2). Kept separate from PlanService so the
 * transport layer doesn't leak into pure plan logic: the brand limit travels
 * through GraphQL (createBrand mutation) with `extensions.code` — the
 * frontend catches the code and renders an upsell; the daily post limit is a
 * blog-writer REST endpoint → HTTP 429.
 */

/** Russian noun form by count: [1, 2-4, 5+] (counting context). */
export function pluralRu(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20))
    return forms[1];
  return forms[2];
}

export const PLAN_LIMIT_BRANDS_CODE = 'PLAN_LIMIT_BRANDS';
export const PLAN_LIMIT_POSTS_CODE = 'PLAN_LIMIT_POSTS';
export const PLAN_LIMIT_SEATS_CODE = 'PLAN_LIMIT_SEATS';

/**
 * Team (stage 5a) is unavailable on a single-seat plan (free/lite: seats=1 —
 * owner only). extensions.code = PLAN_LIMIT_SEATS for the frontend upsell.
 * `detail` differs: plan has no team vs. seats ran out on a paid plan.
 */
export function seatsLimitError(
  detail = 'Команда доступна с тарифа Бестселлер',
): GraphQLError {
  return new GraphQLError(detail, {
    extensions: { code: PLAN_LIMIT_SEATS_CODE },
  });
}

/**
 * "На тарифе Бестселлер доступно 2 бренда — расширьте тариф" (Russian
 * user-facing text). extensions.code = PLAN_LIMIT_BRANDS so the frontend
 * shows an upsell instead of a generic error.
 */
export function brandLimitError(planTitle: string, max: number): GraphQLError {
  const verb = pluralRu(max, ['доступен', 'доступно', 'доступно']);
  const noun = pluralRu(max, ['бренд', 'бренда', 'брендов']);
  return new GraphQLError(
    `На тарифе ${planTitle} ${verb} ${max} ${noun} — расширьте тариф`,
    { extensions: { code: PLAN_LIMIT_BRANDS_CODE } },
  );
}

/**
 * "Лимит 2 поста в день на тарифе Бестселлер" (Russian user-facing text) →
 * HTTP 429 (Too Many Requests), body with code=PLAN_LIMIT_POSTS for the
 * frontend upsell.
 */
export function postLimitError(
  perDay: number,
  planTitle: string,
): HttpException {
  const noun = pluralRu(perDay, ['пост', 'поста', 'постов']);
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: PLAN_LIMIT_POSTS_CODE,
      message: `Лимит ${perDay} ${noun} в день на тарифе ${planTitle}`,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
