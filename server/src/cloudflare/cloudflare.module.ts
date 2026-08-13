import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { CloudflareController } from './cloudflare.controller';
import { CloudflareService } from './cloudflare.service';

// "Cloudflare" connector: API token + GraphQL Analytics (AI crawler hits).
@Module({
  imports: [AuthModule, BrandsModule],
  controllers: [CloudflareController],
  providers: [CloudflareService],
})
export class CloudflareModule {}
