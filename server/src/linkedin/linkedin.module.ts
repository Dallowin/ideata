import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { LinkedinController } from './linkedin.controller';
import { LinkedinService } from './linkedin.service';

// LinkedIn publishing channel: OAuth connection per brand, same as Threads.
@Module({
  imports: [AuthModule, BrandsModule],
  controllers: [LinkedinController],
  providers: [LinkedinService],
  exports: [LinkedinService],
})
export class LinkedinModule {}
