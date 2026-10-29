import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { RequirePermissions } from '../common/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RoomsService } from './rooms.service';

const versionFields = { expectedVersion: z.int().nonnegative().optional() };

const openBody = z.object({ guestCount: z.int().min(1).max(20).default(1), ...versionFields });
const moveBody = z.object({ toRoomId: z.string().uuid(), ...versionFields });
const cleaningCompleteBody = z.object({ checklistPassed: z.boolean(), ...versionFields });
const maintenanceEndBody = z.object({ inspectionPassed: z.boolean(), ...versionFields });
const emptyBody = z.object({ ...versionFields }).default({});

/** Room command endpoints — one per domain command (spec §5.1/§7.3). */
@Controller('v1/rooms')
export class RoomsController {
  constructor(@Inject(RoomsService) private readonly service: RoomsService) {}

  private actorOf(req: FastifyRequest) {
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
    };
  }

  @RequirePermissions('room.read')
  @Get()
  list(@Req() req: FastifyRequest): Promise<{ data: unknown }> {
    return this.service.list(req.authStoreId!) as Promise<{ data: unknown }>;
  }

  @RequirePermissions('room.read')
  @Get(':roomId')
  get(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
  ): Promise<{ data: unknown }> {
    return this.service.get(req.authStoreId!, roomId) as Promise<{ data: unknown }>;
  }

  @RequirePermissions('room.open')
  @Post(':roomId/open')
  open(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body(new ZodValidationPipe(openBody)) body: z.infer<typeof openBody>,
  ): Promise<{ data: unknown }> {
    return this.service.open(this.actorOf(req), roomId, body) as Promise<{ data: unknown }>;
  }

  @RequirePermissions('room.move')
  @Post(':roomId/move')
  move(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body(new ZodValidationPipe(moveBody)) body: z.infer<typeof moveBody>,
  ): Promise<{ data: unknown }> {
    return this.service.move(this.actorOf(req), roomId, body) as Promise<{ data: unknown }>;
  }

  @RequirePermissions('room.clean')
  @Post(':roomId/cleaning-start')
  cleaningStart(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.cleaningStart(this.actorOf(req), roomId, body) as Promise<{
      data: unknown;
    }>;
  }

  @RequirePermissions('room.clean')
  @Post(':roomId/cleaning-complete')
  cleaningComplete(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body(new ZodValidationPipe(cleaningCompleteBody)) body: z.infer<typeof cleaningCompleteBody>,
  ): Promise<{ data: unknown }> {
    return this.service.cleaningComplete(this.actorOf(req), roomId, body) as Promise<{
      data: unknown;
    }>;
  }

  @RequirePermissions('room.maintenance')
  @Post(':roomId/maintenance-start')
  maintenanceStart(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.maintenanceStart(this.actorOf(req), roomId, body) as Promise<{
      data: unknown;
    }>;
  }

  @RequirePermissions('room.maintenance')
  @Post(':roomId/maintenance-end')
  maintenanceEnd(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body(new ZodValidationPipe(maintenanceEndBody)) body: z.infer<typeof maintenanceEndBody>,
  ): Promise<{ data: unknown }> {
    return this.service.maintenanceEnd(this.actorOf(req), roomId, body) as Promise<{
      data: unknown;
    }>;
  }

  @RequirePermissions('room.disable')
  @Post(':roomId/disable')
  disable(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.disable(this.actorOf(req), roomId, body) as Promise<{ data: unknown }>;
  }

  @RequirePermissions('room.disable')
  @Post(':roomId/enable')
  enable(
    @Req() req: FastifyRequest,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body(new ZodValidationPipe(emptyBody)) body: z.infer<typeof emptyBody>,
  ): Promise<{ data: unknown }> {
    return this.service.enable(this.actorOf(req), roomId, body) as Promise<{ data: unknown }>;
  }
}
