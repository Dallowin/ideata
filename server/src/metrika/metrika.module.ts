import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandsModule } from '../brands/brands.module';
import { MetrikaController } from './metrika.controller';
import { MetrikaService } from './metrika.service';

// "AI traffic" tab: Yandex OAuth + Metrika Stat API. PrismaService is global.
@Module({
  imports: [AuthModule, BrandsModule],
  controllers: [MetrikaController],
  providers: [MetrikaService],
})
export class MetrikaModule {}
