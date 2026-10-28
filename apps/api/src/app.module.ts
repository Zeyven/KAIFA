import { Module } from '@nestjs/common';
import { EnvModule } from './env/env.module';
import { HealthModule } from './health/health.module';

/**
 * Root application module (modular monolith — spec §2.1). One module per
 * bounded context joins here as its phase lands: Auth, Organization, Room,
 * Technician, Scheduling, Visit, ServiceSession, Order, Payment, Member,
 * Commission, Device, Approval, Audit, Reporting, EdgeSync.
 */
@Module({
  imports: [EnvModule, HealthModule],
})
export class AppModule {}
