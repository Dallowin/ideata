import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { GscController } from './gsc.controller';
import { GscService } from './gsc.service';

// "Google Search Console" connector: Google OAuth (webmasters.readonly) +
// Search Analytics API. PrismaService is global.
@Module({
  imports: [AuthModule, BrandsModule],
  controllers: [GscController],
  providers: [GscService],
})
export class GscModule {}
