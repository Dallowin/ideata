import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { XController } from './x.controller';
import { XService } from './x.service';

// X publishing channel: OAuth connection per brand, same as LinkedIn and Threads.
@Module({
  imports: [AuthModule, BrandsModule],
  controllers: [XController],
  providers: [XService],
  exports: [XService],
})
export class XModule {}
