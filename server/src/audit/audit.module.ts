import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DiscoverModule } from '../discover/discover.module';
import { DiscoverSettings } from '../discover/settings';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditThrottleService } from './audit-throttle.service';

/**
 * Technical site audit — a full port of core/site_audit.py.
 * DiscoverSettings is reused for the PageSpeed key: it lives in the same
 * place, app_settings, and is edited from the same admin panel.
 */
@Module({
  imports: [AuthModule, DiscoverModule],
  controllers: [AuditController],
  providers: [AuditService, AuditThrottleService, DiscoverSettings],
  exports: [AuditService],
})
export class AuditModule {}
