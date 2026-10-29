import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL, requirePool } from '../db/pg.module';

/** Read-only catalog slice for FrontDesk boards (org-scoped). */
@Injectable()
export class CatalogService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool | null) {}

  /** GET /v1/products — sellable goods for checkout (server-priced). */
  async listProducts(orgId: string): Promise<{ data: unknown }> {
    const { rows } = await requirePool(this.pool).query(
      `SELECT id, sku, name, category, unit, list_price_cents, status
       FROM products
       WHERE organization_id = $1 AND status = 'ACTIVE'
       ORDER BY category NULLS LAST, sku`,
      [orgId],
    );
    return { data: { items: rows, nextCursor: null } };
  }

  /** GET /v1/service-variants — priced variants the frontdesk can book. */
  async listVariants(orgId: string): Promise<{ data: unknown }> {
    const { rows } = await requirePool(this.pool).query<{
      id: string;
      code: string;
      name: string;
      service_code: string;
      service_name: string;
      duration_minutes: number;
      base_price_cents: string;
      category_name: string | null;
    }>(
      `SELECT v.id, v.code, v.name, s.code AS service_code, s.name AS service_name,
              v.duration_minutes, v.base_price_cents, c.name AS category_name
       FROM service_variants v
       JOIN services s ON s.id = v.service_id
       LEFT JOIN service_categories c ON c.id = s.category_id
       WHERE s.organization_id = $1 AND s.status = 'ACTIVE' AND v.status = 'ACTIVE'
       ORDER BY c.sort_order NULLS LAST, s.code, v.duration_minutes DESC`,
      [orgId],
    );
    return {
      data: {
        items: rows.map((r) => ({ ...r, base_price_cents: Number(r.base_price_cents) })),
        nextCursor: null,
      },
    };
  }
}
