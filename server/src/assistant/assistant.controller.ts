import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { LoginGuard } from '../auth/login.guard';
import { CreditsService } from '../credits/credits.service';
import { BlogBrandContext } from '../blogwriter/brand-context';
import { resolveSettings } from '../blogwriter/server/utils/appSettings';
import { LLM } from '../blogwriter/server/utils/llm';
import {
  DEFAULT_ASSISTANT_MODEL,
  getUnifiedCatalog,
  isValidModelId,
  modelsForKeys,
} from '../blogwriter/server/utils/modelCatalog';

/**
 * Brand-data assistant. Answers FREE-FORM questions that the client-side
 * intent router didn't recognize (that router answers common questions for
 * free, without a model). Cheap model (modelFast) + a strict system rule
 * "only from the snapshot, never make up numbers".
 *
 * The brand snapshot is assembled by the CLIENT from what's already loaded
 * (tracker aggregates + analysis facts) — the backend doesn't need to hit
 * the scrapper again, and the user only sees their own brand (the _cw
 * session gates access). Spend is logged to llm_usage via the LLM wrapper;
 * credits are charged based on the actual returned call: assertEnough gates
 * before calling the model, charge happens after a successful response. A
 * provider error charges nothing (the soft fallback answer below is free).
 */
const SYSTEM = `Ты — ассистент сервиса Ideata по мониторингу видимости бренда в ответах нейросетей (AEO).
Тебе дают СНИМОК данных бренда в JSON и вопрос пользователя.

Правила, нарушать нельзя:
- Отвечай ТОЛЬКО по данным снимка. Никаких чисел, названий и фактов, которых нет в снимке.
- Если данных для ответа в снимке нет — прямо скажи об этом и предложи, где это посмотреть в кабинете. Не выдумывай.
- Пиши по-русски, кратко и по делу: 2–5 коротких абзацев или список. Без воды и без общих советов «в вакууме».
- Оперируй конкретикой из снимка: проценты, дельты, названия конкурентов и промптов, домены-источники.
- Разделы кабинета: «Мониторинг» (динамика, конкуренты, движки, что изменилось), «Ссылки» (цитаты и источники), «Промпты», «Дополнительные» (разбор сайта), Blog Writer (посты).
- Не обещай действий, которые не можешь выполнить. Ты только объясняешь данные и подсказываешь следующий шаг.`;

interface ChatBody {
  question: string;
  /** brand snapshot (JSON string) assembled by the client from loaded data */
  snapshot?: string;
  /** recent message pairs for context; trimmed on the backend to a sane size */
  history?: { role: 'user' | 'bot'; text: string }[];
  /** model chosen by the user in the selector (OpenRouter slug). Empty → cheap default. */
  model?: string;
}

@Controller('assistant')
@UseGuards(LoginGuard)
export class AssistantController {
  constructor(
    private readonly brandCtx: BlogBrandContext,
    private readonly auth: AuthService,
    private readonly credits: CreditsService,
  ) {}

  /**
   * Unified model catalog for the selector (Anthropic + OpenRouter, 1h cache).
   * {models:[{id,label,provider,format,inUsd,outUsd,desc,context}], source, at, default}.
   * ?refresh=1 forces a refresh.
   */
  @Get('models')
  async models(@Req() req: Request, @Query('refresh') refresh?: string) {
    const [cat, s] = await Promise.all([
      getUnifiedCatalog(refresh === '1'),
      resolveSettings(await this.brandCtx.brandId(req)),
    ]);
    // only models available with the current keys (see modelsForKeys)
    const models = modelsForKeys(cat.models, { anthropicKey: s.anthropicKey, orKey: s.openrouterKey });
    return { ...cat, models, default: DEFAULT_ASSISTANT_MODEL };
  }

  @Post('chat')
  async chat(@Req() req: Request, @Body() body: ChatBody) {
    const question = String(body?.question || '').trim().slice(0, 2000);
    if (!question) throw new BadRequestException('Empty question');

    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);

    // The chosen model is passed through as-is; the LLM provider (Anthropic/OpenRouter)
    // picks itself by model from the shared catalog. No choice → brand's cheap modelFast.
    const model = isValidModelId(body?.model) ? body!.model! : s.modelFast;

    // no keys at all → tell the truth instead of blowing up with a 500
    if (!s.anthropicKey && !s.openrouterKey && !s.apiKey) {
      return {
        answer:
          'Модель ассистента ещё не подключена в настройках. Типовые вопросы я отвечаю и без неё — спросите про видимость, конкурентов, источники или темы для контента.',
        grounded: false,
        model: null,
      };
    }

    // Credits: don't let a call through with a known-empty balance. The estimate
    // uses the same catalog as the actual call price — what's shown in the UI and
    // what gets charged come from the same source.
    const user = this.auth.userFromRequest(req);
    if (user?.i) {
      await this.credits.assertEnough(user.i, await this.credits.estimateAsk(model));
    }

    const llm = new LLM({
      ...s,
      modelFast: model,
      modelStrong: model,
      usage: { ...s.usage, runId: null },
    });

    const snapshot = String(body?.snapshot || '').slice(0, 12000);
    const history = (Array.isArray(body?.history) ? body!.history : [])
      .slice(-6)
      .map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${String(m.text).slice(0, 800)}`)
      .join('\n');

    const prompt = [
      `СНИМОК ДАННЫХ БРЕНДА:\n${snapshot || '(снимок пуст — данных трекера пока нет)'}`,
      history ? `\nПРЕДЫДУЩИЕ РЕПЛИКИ:\n${history}` : '',
      `\nВОПРОС: ${question}`,
    ].join('\n');

    try {
      const r = await llm.completeEx(prompt, {
        system: SYSTEM,
        strong: false, // cheap fast model
        maxTokens: 700,
        temperature: 0.4,
      });
      // Charged by the call's actual token counts, at the model's OFFICIAL price —
      // the same number regardless of which provider the call was routed through.
      // The ledger doesn't throw — a failed usage log must not turn a successful
      // answer into an error.
      const spent = user?.i
        ? await this.credits.chargeCall(user.i, r.model, r.tokensIn, r.tokensOut, 'ask', { brandId })
        : 0;
      return { answer: r.text.trim(), grounded: false, model, spent };
    } catch (e) {
      // 402 from the credits gate is a backend response to the user, not a model failure
      if (e instanceof HttpException) throw e;
      // network/provider limit — don't crash the chat, return a soft fallback answer
      return {
        answer:
          'Не получилось обратиться к модели прямо сейчас. Типовые вопросы я отвечаю из данных мгновенно — попробуйте спросить про видимость, конкурентов или источники.',
        grounded: false,
        model: null,
      };
    }
  }
}
