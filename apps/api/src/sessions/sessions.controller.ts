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
import { RequirePermissions } from '../common/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SessionsService, type SessionCommandContext } from './sessions.service';

const versionFields = { expectedVersion: z.int().nonnegative().optional() };
const emptyBody = z.object({ ...versionFields }).default({});

const createBody = z
  .object({
    visitId: z.string().uuid().optional(),
    roomId: z.string().uuid().optional(),
    serviceVariantId: z.string().uuid(),
    technicianId: z.string().uuid().optional(),
    assignmentType: z
      .enum(['ROTATION', 'REQUESTED', 'RESERVATION', 'MANUAL', 'PRIORITY', 'COMPENSATION'])
      .optional(),
    bedId: z.string().uuid().optional(),
    ...versionFields,
  })
  .refine((v) => Boolean(v.visitId ?? v.roomId), {
    message: 'visitId or roomId is required',
    path: ['visitId'],
  });

const assignBody = z.object({
  technicianId: z.string().uuid(),
  ...versionFields,
});

const extendBody = z.object({
  minutes: z.int().positive().max(480),
  priceDeltaCents: z.int().min(0).max(1_000_000_00).optional(),
  ...versionFields,
});

const changeTechBody = z.object({
  technicianId: z.string().uuid(),
  reasonCode: z.string().min(1).max(64),
  ...versionFields,
});

const changeServiceBody = z.object({
  serviceVariantId: z.string().uuid(),
  ...versionFields,
});

const terminateBody = z.object({
  reasonCode: z.string().min(1).max(64),
  ...versionFields,
});

/**
 * Service session endpoints (spec §7.3). Lifecycle commands acknowledge →
 * arrive → start → complete carry NO static permission: authorization is the
 * in-tx identity gate (own session as the linked technician) or service.manage.
 */
@Controller('v1/service-sessions')
export class SessionsController {
  constructor(@Inject(SessionsService) private readonly service: SessionsService) {}

  private ctxOf(req: FastifyRequest): SessionCommandContext {
    const p = req.principal;
    if (!p || !req.authStoreId) throw new Error('auth context missing — guard misconfigured');
    return {
      storeId: req.authStoreId,
      orgId: p.orgId,
      actor: { actorType: 'EMPLOYEE', actorId: req.actorEmployeeId, requestId: req.id, ip: req.ip },
      actorEmployeeId: req.actorEmployeeId,
      permissionCodes: req.permissionCodes ?? null,
    };
  }

  @RequirePermissions('service.manage')
  @Post()
  create(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(createBody)) body: z.infer<typeof createBody>,
  ): Promise<{ data: unknown }> {
    return this.service.create(this.ctxOf(req), req.principal!.orgId, body);
  }

  @RequirePermissions('service.read')
  @Get()
  list(
    @Req() req: FastifyRequest,
    @Query('technicianId') technicianId?: string,
    @Query('roomId') roomId?: string,
    @Query('status') status?: string,
    @Query('activeOnly') activeOnly?: string,
    @Query('today') today?: string,
    @Query('limit') limit?: string,
  ): Promise<{ data: unknown }> {
    return this.service.list(req.authStoreId!, {
      technicianId: technicianId || undefined,
      roomId: roomId || undefined,
      status: status || undefined,
      activeOnly: activeOnly === '1' || activeOnly === 'true',
      today: today === '1' || today === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @RequirePermissions('service.read')
  @Get(':sessionId')
  get(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<{ data: unknown }> {
    return this.service.get(req.authStoreId!, sessionId);
  }

  @RequirePermissions('service.manage')
  @Post(':sessionId/assign')
  assign(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(assignBody)) body: z.infer<typeof assignBody>,
  ): Promise<{ data: unknown }> {
    return this.service.assign(this.ctxOf(req), sessionId, body);
  }

  @Post(':sessionId/acknowledge')
  acknowledge(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.acknowledge(this.ctxOf(req), sessionId, body);
  }

  @Post(':sessionId/arrive')
  arrive(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.arrive(this.ctxOf(req), sessionId, body);
  }

  @Post(':sessionId/start')
  start(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.start(this.ctxOf(req), sessionId, body);
  }

  @RequirePermissions('service.manage')
  @Post(':sessionId/extend')
  extend(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(extendBody)) body: z.infer<typeof extendBody>,
  ): Promise<{ data: unknown }> {
    return this.service.extend(this.ctxOf(req), sessionId, body);
  }

  @RequirePermissions('service.manage')
  @Post(':sessionId/change-technician')
  changeTechnician(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(changeTechBody)) body: z.infer<typeof changeTechBody>,
  ): Promise<{ data: unknown }> {
    return this.service.changeTechnician(this.ctxOf(req), sessionId, body);
  }

  @RequirePermissions('service.manage')
  @Post(':sessionId/change-service')
  changeService(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(changeServiceBody)) body: z.infer<typeof changeServiceBody>,
  ): Promise<{ data: unknown }> {
    return this.service.changeService(this.ctxOf(req), sessionId, body);
  }

  @Post(':sessionId/complete')
  complete(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.complete(this.ctxOf(req), sessionId, body);
  }

  @RequirePermissions('service.terminate')
  @Post(':sessionId/terminate')
  terminate(
    @Req() req: FastifyRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body(new ZodValidationPipe(terminateBody)) body: z.infer<typeof terminateBody>,
  ): Promise<{ data: unknown }> {
    return this.service.terminate(this.ctxOf(req), sessionId, body);
  }
}
