import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LlmService } from './llm.service';
import { ToolsResolver } from './tools.resolver';
import { ToolsService } from './tools.service';

@Module({
  imports: [AuthModule],
  providers: [LlmService, ToolsService, ToolsResolver],
})
export class ToolsModule {}
