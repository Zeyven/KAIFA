import { Module } from '@nestjs/common';
import { EnvModule } from '../env/env.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [EnvModule, OrdersModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
