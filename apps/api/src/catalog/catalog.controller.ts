import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RequirePermissions } from '../common/decorators';
import { CatalogService } from './catalog.service';

/** Catalog reads (spec §4.4 subset). service.read gates visibility (§6.2 skill truth). */
@Controller('v1/service-variants')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService) {}

  @RequirePermissions('service.read')
  @Get()
  list(@Req() req: FastifyRequest): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p) throw new Error('auth context missing — guard misconfigured');
    return this.service.listVariants(p.orgId);
  }
}
