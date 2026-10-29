import type { PoolClient } from 'pg';

/**
 * Transactional store event append (spec §8 storeSeq + §12.2 outbox).
 * Allocates the next per-store sequence by locking the store row — inside the
 * SAME transaction as the business mutation, so a committed state change can
 * never exist without its event (invariant I21/I22).
 */
export interface StoreEventInput {
  storeId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  version?: number;
  source?: 'CLOUD' | 'EDGE';
}

export interface StoreEventRef {
  eventId: string;
  storeSeq: number;
}

export async function appendStoreEvent(
  client: PoolClient,
  event: StoreEventInput,
): Promise<StoreEventRef> {
  const seqRes = await client.query<{ last_event_seq: string }>(
    `UPDATE stores SET last_event_seq = last_event_seq + 1, updated_at = now()
     WHERE id = $1 RETURNING last_event_seq`,
    [event.storeId],
  );
  const seqRow = seqRes.rows[0];
  if (!seqRow) throw new Error(`store not found for event: ${event.storeId}`);
  const storeSeq = Number(seqRow.last_event_seq);
  if (!Number.isSafeInteger(storeSeq)) {
    throw new Error(`store_seq overflow: ${seqRow.last_event_seq}`);
  }

  const { rows } = await client.query<{ event_id: string; store_seq: string }>(
    `INSERT INTO outbox_events
       (event_id, store_id, store_seq, aggregate_type, aggregate_id, event_type,
        payload, source, version)
     VALUES (lanxu_uuidv7(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     RETURNING event_id, store_seq`,
    [
      event.storeId,
      storeSeq,
      event.aggregateType,
      event.aggregateId,
      event.type,
      JSON.stringify(event.payload ?? {}),
      event.source ?? 'CLOUD',
      event.version ?? 1,
    ],
  );
  return { eventId: rows[0]!.event_id, storeSeq: Number(rows[0]!.store_seq) };
}
