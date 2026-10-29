import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '@lanxu/contracts';
import { Public, RequirePermissions } from '../common/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PaymentsService } from './payments.service';

const paymentBody = z.object({
  orderId: z.string().uuid(),
  method: z.enum(['CASH', 'WECHAT', 'ALIPAY', 'WALLET', 'CARD', 'OTHER']),
  amountCents: z.int().positive(),
  cashSessionId: z.string().uuid().optional(),
});
const cashOpenBody = z.object({ openingFloatCents: z.int().nonnegative().optional() }).default({});
const cashCloseBody = z.object({ countedCashCents: z.int().nonnegative() });
/** §13.2 provider callback — public by design; the HMAC signature is the auth. */
const webhookBody = z.object({
  provider: z.string().min(1).max(32),
  providerOrderId: z.string().min(1).max(255),
  providerTransactionId: z.string().min(1).max(255),
  amountCents: z.int().positive(),
  signature: z.string().min(1).max(255),
});

@Controller('v1')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly service: PaymentsService) {}

  /** §7.1 dangerous write — Idempotency-Key mandatory. */
  @RequirePermissions('order.checkout')
  @Post('payments')
  create(
    @Body(new ZodValidationPipe(paymentBody)) body: z.infer<typeof paymentBody>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const key = (idempotencyKey ?? '').trim();
    if (!key) {
      throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key header is required');
    }
    if (key.length > 200) {
      throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key too long (max 200)');
    }
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.create(body, key, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
    });
  }

  @RequirePermissions('order.checkout')
  @Post('payments/:paymentId/capture')
  capture(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.capture(paymentId, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
    });
  }

  /** Signed provider callback — HMAC verified in the service (public route). */
  @Public()
  @Post('payments/webhook')
  @HttpCode(HttpStatus.OK)
  webhook(
    @Body(new ZodValidationPipe(webhookBody)) body: z.infer<typeof webhookBody>,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    return this.service.webhook(body, { ip: req.ip });
  }

  /** §13.2 server-side provider query → CAPTURED (client claims never count). */
  @RequirePermissions('order.checkout')
  @Post('payments/:paymentId/verify')
  @HttpCode(201)
  verify(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.verify(paymentId, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
    });
  }

  @RequirePermissions('order.read')
  @Get('payments/:paymentId')
  get(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    return this.service.get(paymentId, req.authStoreId!);
  }

  @RequirePermissions('order.checkout')
  @Post('cash-sessions')
  openCash(
    @Body(new ZodValidationPipe(cashOpenBody)) body: z.infer<typeof cashOpenBody>,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.openCashSession(body, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
    });
  }

  @RequirePermissions('order.read')
  @Get('cash-sessions')
  listCash(@Req() req: FastifyRequest): Promise<{ data: unknown }> {
    return this.service.listCashSessions(req.authStoreId!);
  }

  @RequirePermissions('order.checkout')
  @Post('cash-sessions/:cashSessionId/close')
  closeCash(
    @Param('cashSessionId', ParseUUIDPipe) cashSessionId: string,
    @Body(new ZodValidationPipe(cashCloseBody)) body: z.infer<typeof cashCloseBody>,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p || !req.actorEmployeeId) throw new Error('auth context missing');
    return this.service.closeCashSession(cashSessionId, body, {
      storeId: req.authStoreId!,
      actorId: req.actorEmployeeId,
      ip: req.ip,
    });
  }
}
