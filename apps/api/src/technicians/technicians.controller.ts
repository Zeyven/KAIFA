import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TechniciansService, type TechnicianCommandContext } from './technicians.service';

const versionFields = { expectedVersion: z.int().nonnegative().optional() };
const emptyBody = z.object({ ...versionFields }).default({});

/** Technician endpoints (spec §7.3) + break commands required by §5.2. */
@Controller('v1/technicians')
export class TechniciansController {
  constructor(@Inject(TechniciansService) private readonly service: TechniciansService) {}

  private ctxOf(req: FastifyRequest): TechnicianCommandContext {
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

  @RequirePermissions('tech.read')
  @Get()
  list(@Req() req: FastifyRequest): Promise<{ data: unknown }> {
    return this.service.list(req.authStoreId!);
  }

  @Post(':technicianId/clock-in')
  clockIn(
    @Req() req: FastifyRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.clockIn(this.ctxOf(req), technicianId, body);
  }

  @Post(':technicianId/clock-out')
  clockOut(
    @Req() req: FastifyRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.clockOut(this.ctxOf(req), technicianId, body);
  }

  @Post(':technicianId/lock')
  lock(
    @Req() req: FastifyRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.lockTechnician(this.ctxOf(req), technicianId, body);
  }

  @Post(':technicianId/unlock')
  unlock(
    @Req() req: FastifyRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.unlockTechnician(this.ctxOf(req), technicianId, body);
  }

  @Post(':technicianId/break/start')
  breakStart(
    @Req() req: FastifyRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.breakStart(this.ctxOf(req), technicianId, body);
  }

  @Post(':technicianId/break/end')
  breakEnd(
    @Req() req: FastifyRequest,
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.breakEnd(this.ctxOf(req), technicianId, body);
  }
}
