import { Global, Module } from '@nestjs/common';
import { CreditsService } from './credits.service';

/**
 * Credits. @Global for the same reasons as PlansModule: various features will
 * charge them (images in the cover constructor, later posts and the
 * assistant), and there's no point importing the module into every
 * feature module.
 */
@Global()
@Module({
  providers: [CreditsService],
  exports: [CreditsService],
})
export class CreditsModule {}
