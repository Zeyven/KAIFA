import { Module } from '@nestjs/common';
import { EnvModule } from './env/env.module';
import { HealthModule } from './health/health.module';
import { CoreModule } from './core/core.module';
import { RoomsModule } from './rooms/rooms.module';

/**
 * Root application module (modular monolith — spec §2.1). One module per
 * bounded context joins here as its phase lands: Auth/Room done (02/03) →
 * Technician, Scheduling, Visit/ServiceSession, Order, Payment, Member,
 * Commission, Device, Approval, Realtime, EdgeSync next.
 */
@Module({
  imports: [EnvModule, CoreModule, HealthModule, RoomsModule],
})
export class AppModule {}
