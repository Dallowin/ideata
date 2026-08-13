import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsResolver } from './brands.resolver';
import { BrandsService } from './brands.service';

@Module({
  imports: [AuthModule],
  providers: [BrandsService, BrandsResolver],
  exports: [BrandsService],
})
export class BrandsModule {}
