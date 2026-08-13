import { Module } from '@nestjs/common';
import { DiscoverService } from './discover.service';
import { DataForSeoClient } from './dataforseo.client';
import { KeysSoClient } from './keysso.client';
import { DiscoverSettings } from './settings';

/**
 * Direct clients for DataForSEO/Keys.so — the first piece of the migration
 * from the scraper (Python) to this service. See discover.service.ts.
 */
@Module({
  providers: [DiscoverService, DataForSeoClient, KeysSoClient, DiscoverSettings],
  exports: [DiscoverService],
})
export class DiscoverModule {}
