import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CommentsResolver } from './comments.resolver';
import { CommentsService } from './comments.service';

@Module({
  imports: [AuthModule],
  providers: [CommentsService, CommentsResolver],
})
export class CommentsModule {}
