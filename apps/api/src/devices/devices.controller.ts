import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Ip,
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
import { DevicesService } from './devices.service';

const enrollBody = z.object({
  platform: z.string().max(60).optional(),
  appVersion: z.string().max(40).optional(),
});
const bindBody = z.object({
  storeId: z.string().uuid(),
  roomId: z.string().uuid(),
});

@Controller('v1/devices')
export class DevicesController {
  constructor(@Inject(DevicesService) private readonly service: DevicesService) {}

  /** §10.2 unbound kiosk — no staff JWT exists yet (public, rate-limited). */
  @Public()
  @Post('enroll')
  enroll(
    @Body(new ZodValidationPipe(enrollBody)) body: z.infer<typeof enrollBody>,
    @Ip() ip: string,
    @Req() req: FastifyRequest,
  ): Promise<{ data: unknown }> {
    /* org resolved from X-Org-Code (device has no JWT yet — §10.2). */
    const orgCode = (req.headers['x-org-code'] as string | undefined) ?? '';
    if (!orgCode) {
      throw new ApiError('VALIDATION_FAILED', 'missing X-Org-Code header');
    }
    return this.service.enroll({ ...body, orgCode }, { ip, actor: req.actorEmployeeId });
  }

  @RequirePermissions('device.read')
  @Get()
  list(@Req() req: FastifyRequest): Promise<{ data: unknown }> {
    return this.service.list(req.authStoreId!);
  }

  /** Kiosk polls with X-Device-Code only (device credential, not staff JWT). */
  @Public()
  @Get('heartbeat')
  heartbeat(
    @Headers('x-device-code') deviceCode: string | undefined,
    @Ip() ip: string,
  ): Promise<{ data: unknown }> {
    if (!deviceCode) throw new Error('missing device code');
    return this.service.heartbeat(deviceCode, ip);
  }

  @RequirePermissions('device.manage')
  @Post(':deviceId/bind')
  bind(
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Body(new ZodValidationPipe(bindBody)) body: z.infer<typeof bindBody>,
    @Req() req: FastifyRequest,
    @Ip() ip: string,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p) throw new Error('auth context missing');
    return this.service.bind(deviceId, body, {
      orgId: p.orgId,
      actorId: req.actorEmployeeId ?? p.userId,
      ip,
    });
  }

  @RequirePermissions('device.manage')
  @Post(':deviceId/unbind')
  unbind(
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Req() req: FastifyRequest,
    @Ip() ip: string,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p) throw new Error('auth context missing');
    return this.service.unbind(deviceId, {
      orgId: p.orgId,
      actorId: req.actorEmployeeId ?? p.userId,
      ip,
    });
  }

  @RequirePermissions('device.manage')
  @Post(':deviceId/disable')
  disable(
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Req() req: FastifyRequest,
    @Ip() ip: string,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p) throw new Error('auth context missing');
    return this.service.setStatus(deviceId, 'DISABLED', {
      orgId: p.orgId,
      actorId: req.actorEmployeeId ?? p.userId,
      ip,
    });
  }

  @RequirePermissions('device.manage')
  @Post(':deviceId/revoke')
  revoke(
    @Param('deviceId', ParseUUIDPipe) deviceId: string,
    @Req() req: FastifyRequest,
    @Ip() ip: string,
  ): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p) throw new Error('auth context missing');
    return this.service.setStatus(deviceId, 'REVOKED', {
      orgId: p.orgId,
      actorId: req.actorEmployeeId ?? p.userId,
      ip,
    });
  }
}
