import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppEnv } from '@lanxu/config';
import { RequirePermissions } from '../common/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ENV } from '../env/env.module';
import { OrdersService } from './orders.service';

const openBody = z.object({ visitId: z.string().uuid() });
const itemBody = z
  .object({
    productId: z.string().uuid().optional(),
    serviceVariantId: z.string().uuid().optional(),
    quantity: z.int().positive().max(999).optional(),
  })
  .refine((b) => (b.productId ? 1 : 0) + (b.serviceVariantId ? 1 : 0) === 1, {
    message: 'exactly one of productId/serviceVariantId',
  });
const discountBody = z.object({
  amountCents: z.int().positive(),
  reasonCode: z.string().max(60).optional(),
  orderItemId: z.string().uuid().optional(),
});
const checkoutBody = z.object({ expectedVersion: z.int().nonnegative().optional() }).default({});

@Controller('v1/orders')
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly service: OrdersService,
    @Inject(ENV) private readonly env: AppEnv,
  ) {}

  @RequirePermissions('order.read')
  @Get()
  list(
    @Req() req: FastifyRequest,
    @Query('status') status?: string,
    @Query('visitId') visitId?: string,
    @Query('today') today?: string,
    @Query('limit') limit?: string,
  ): Promise<{ data: unknown }> {
    return this.service.list(req.authStoreId!, {
      status: status || undefined,
      visitId: visitId || undefined,
      today: today === '1' || today === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @RequirePermissions('order.checkout')
  @Post('open')
  open(
    @Body(new ZodValidationPipe(openBody)) body: z.infer<typeof openBody>,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.open(body, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
    });
  }

  @RequirePermissions('order.read')
  @Get(':orderId')
  get(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    return this.service.get(orderId, req.authStoreId!);
  }

  @RequirePermissions('order.checkout')
  @Post(':orderId/items')
  addItem(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body(new ZodValidationPipe(itemBody)) body: z.infer<typeof itemBody>,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.addItem(orderId, body, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
    });
  }

  @RequirePermissions('order.discount')
  @Post(':orderId/discounts')
  discount(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body(new ZodValidationPipe(discountBody)) body: z.infer<typeof discountBody>,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.applyDiscount(orderId, body, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
      thresholdCents: this.env.DISCOUNT_APPROVAL_THRESHOLD_CENTS,
    });
  }

  @RequirePermissions('order.checkout')
  @Post(':orderId/checkout')
  checkout(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body(new ZodValidationPipe(checkoutBody)) body: z.infer<typeof checkoutBody>,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.checkout(orderId, body, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
    });
  }
}
