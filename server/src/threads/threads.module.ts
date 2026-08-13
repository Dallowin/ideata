import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { ThreadsController } from './threads.controller';
import { ThreadsService } from './threads.service';

// Threads (Meta) publishing channel: OAuth connection per brand. PrismaService is global.
@Module({
  imports: [AuthModule, BrandsModule],
  controllers: [ThreadsController],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
