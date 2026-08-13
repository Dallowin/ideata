import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BlogResolver } from './blog.resolver';
import { BlogService } from './blog.service';

@Module({
  imports: [AuthModule],
  providers: [BlogService, BlogResolver],
})
export class BlogModule {}
