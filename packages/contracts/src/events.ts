import { z } from 'zod';

/**
 * WebSocket event envelope (Master Prompt §8). `storeSeq` is per-store
 * monotonic and gap-free; clients persist `lastStoreSeq` and replay with
 * `after=<seq>`; expired retention ⇒ snapshot resync (never assume lossless).
 */
export const wsEventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  storeId: z.uuid(),
  storeSeq: z.int().nonnegative(),
  type: z.string().min(1),
  occurredAt: z.iso.datetime(),
  aggregate: z.object({ type: z.string().min(1), id: z.uuid() }),
  version: z.int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
});

export type WsEventEnvelope = z.infer<typeof wsEventEnvelopeSchema>;

/** Initial event registry (docs/architecture/realtime-contract.md). Clients ignore unknown types. */
export const WS_EVENT_TYPES = [
  'room.updated',
  'visit.opened',
  'visit.closed',
  'technician.status_changed',
  'technician.queue_changed',
  'service.assigned',
  'service.acknowledged',
  'service.arrived',
  'service.started',
  'service.extended',
  'service.completed',
  'service.terminated',
  'service.changed_technician',
  'order.updated',
  'order.paid',
  'payment.updated',
  'refund.updated',
  'service_request.created',
  'service_request.completed',
  'device.status_changed',
  'hello',
  'resume',
  'resync_required',
  'error',
] as const;

export type WsEventType = (typeof WS_EVENT_TYPES)[number];
