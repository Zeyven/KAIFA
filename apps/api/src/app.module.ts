import { Module } from '@nestjs/common';
import { EnvModule } from './env/env.module';
import { HealthModule } from './health/health.module';
import { CoreModule } from './core/core.module';
import { RoomsModule } from './rooms/rooms.module';
import { TechniciansModule } from './technicians/technicians.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { SessionsModule } from './sessions/sessions.module';
import { CatalogModule } from './catalog/catalog.module';
import { DevicesModule } from './devices/devices.module';
import { OrdersModule } from './orders/orders.module';

/**
 * Root application module (modular monolith — spec §2.1). One module per
 * bounded context joins here as its phase lands: Auth/Room/Technician/
 * Scheduling/ServiceSession done (02–06) → Order, Payment, Member,
 * Commission, Device, Approval, Realtime, EdgeSync next.
 */
@Module({
  imports: [
    EnvModule,
    CoreModule,
    HealthModule,
    RoomsModule,
    TechniciansModule,
    SchedulingModule,
    SessionsModule,
    CatalogModule,
    DevicesModule,
    OrdersModule,
  ],
})
export class AppModule {}
