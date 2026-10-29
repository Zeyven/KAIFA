import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RequirePermissions } from '../common/decorators';
import { CatalogService } from './catalog.service';

/** Sellable products (spec §4.x); order.read gates checkout-side visibility. */
@Controller('v1/products')
export class ProductsController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService) {}

  @RequirePermissions('order.read')
  @Get()
  list(@Req() req: FastifyRequest): Promise<{ data: unknown }> {
    const p = req.principal;
    if (!p) throw new Error('auth context missing — guard misconfigured');
    return this.service.listProducts(p.orgId);
  }
}
