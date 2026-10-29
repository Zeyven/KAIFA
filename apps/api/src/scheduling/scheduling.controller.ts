import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SchedulingService } from './scheduling.service';

const recommendBody = z
  .object({
    serviceVariantId: z.string().uuid().optional(),
    genderCode: z.string().min(1).max(32).optional(),
  })
  .default({});

const assignBody = z.object({
  technicianId: z.string().uuid(),
  serviceVariantId: z.string().uuid().optional(),
  expectedVersion: z.int().nonnegative().optional(),
});

const skipBody = z.object({
  queueEntryId: z.string().uuid(),
  expectedVersion: z.int().nonnegative().optional(),
});

const compensateBody = z.object({
  queueEntryId: z.string().uuid(),
  delta: z.int().min(-20).max(20),
  expectedVersion: z.int().nonnegative().optional(),
});

const reorderBody = z.object({
  items: z
    .array(
      z.object({
        entryId: z.string().uuid(),
        positionKey: z.number().positive(),
        expectedVersion: z.int().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(50),
});

/** Scheduling endpoints (spec §7.3). */
@Controller('v1/scheduling')
export class SchedulingController {
  constructor(@Inject(SchedulingService) private readonly service: SchedulingService) {}

  private ctxOf(req: FastifyRequest) {
    const p = req.principal;
    if (!p || !req.authStoreId) throw new Error('auth context missing — guard misconfigured');
    return {
      storeId: req.authStoreId,
      orgId: p.orgId,
      actor: {
        actorType: 'EMPLOYEE' as const,
        actorId: req.actorEmployeeId,
        requestId: req.id,
        ip: req.ip,
      },
      actorEmployeeId: req.actorEmployeeId,
      permissionCodes: req.permissionCodes ?? null,
    };
  }

  @RequirePermissions('schedule.assign')
  @Get('queue')
  queue(@Req() req: FastifyRequest): Promise<{ data: unknown }> {
    return this.service.queue(req.authStoreId!);
  }

  @RequirePermissions('schedule.assign')
  @Post('recommend')
  recommend(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(recommendBody)) body: z.infer<typeof recommendBody>,
  ): Promise<{ data: unknown }> {
    return this.service.recommend(this.ctxOf(req), body);
  }

  @RequirePermissions('schedule.assign')
  @Post('assign')
  assign(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(assignBody)) body: z.infer<typeof assignBody>,
  ): Promise<{ data: unknown }> {
    return this.service.assign(this.ctxOf(req), body);
  }

  @RequirePermissions('schedule.assign')
  @Post('skip')
  skip(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(skipBody)) body: z.infer<typeof skipBody>,
  ): Promise<{ data: unknown }> {
    return this.service.skip(this.ctxOf(req), body);
  }

  @RequirePermissions('schedule.assign.force')
  @Post('compensate')
  compensate(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(compensateBody)) body: z.infer<typeof compensateBody>,
  ): Promise<{ data: unknown }> {
    return this.service.compensate(this.ctxOf(req), body);
  }

  @RequirePermissions('schedule.assign')
  @Post('reorder')
  reorder(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(reorderBody)) body: z.infer<typeof reorderBody>,
  ): Promise<{ data: unknown }> {
    return this.service.reorder(this.ctxOf(req), body);
  }
}
