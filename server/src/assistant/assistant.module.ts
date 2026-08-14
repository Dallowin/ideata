import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { LoginGuard } from '../auth/login.guard';
import { BlogBrandContext } from '../blogwriter/brand-context';
import { AssistantController } from './assistant.controller';

/**
 * Brand-data assistant (`assistant/chat`). Reuses the active-brand resolver
 * and the blog-writer's LLM client (Anthropic/OpenRouter provider from account
 * settings). Gate is login-only: the assistant is available on all plans,
 * a credits-based limit will be wired up on the credit_ledger side.
 */
@Module({
  imports: [AuthModule, BrandsModule],
  controllers: [AssistantController],
  providers: [LoginGuard, BlogBrandContext],
})
export class AssistantModule {}
