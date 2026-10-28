import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { READINESS, ReadinessService } from './readiness.service';
import { EnvModule } from '../env/env.module';

@Module({
  imports: [EnvModule],
  controllers: [HealthController],
  providers: [{ provide: READINESS, useClass: ReadinessService }],
})
export class HealthModule {}
