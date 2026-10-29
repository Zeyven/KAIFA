import { z } from 'zod';
import { apiErrorSchema } from './errors';

/** OpenAPI 3.1.2 document assembled from zod schemas (ADR-0005). */

export const OPENAPI_VERSION = '3.1.2';

const jsonSchemaOf = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;

const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z
      .array(z.object({ path: z.string(), code: z.string(), message: z.string() }))
      .optional(),
  }),
});

const errSchema = jsonSchemaOf(errorEnvelopeSchema);

const uuid = z.string().uuid();
const versionFields = { expectedVersion: z.int().nonnegative().optional() };
const emptyBody = z.object({ ...versionFields });

/** Generic success envelope with an object/unknown payload. */
const dataObj = (props: Record<string, unknown> = {}, required: string[] = []): unknown => ({
  type: 'object',
  required: ['data', ...required],
  properties: { data: { type: 'object', properties: props } },
});

const dataItems = (itemSchema: unknown): unknown => ({
  type: 'object',
  required: ['data'],
  properties: {
    data: {
      type: 'object',
      required: ['items'],
      properties: {
        items: { type: 'array', items: itemSchema },
        nextCursor: { type: ['string', 'null'] },
      },
    },
  },
});

interface OpSpec {
  method: 'get' | 'post';
  opId: string;
  summary: string;
  /** documented error codes beyond the universal 401/403 */
  errors?: number[];
  /** path template params */
  params?: string[];
  /** query params: name → schema */
  query?: Record<string, z.ZodType>;
  body?: z.ZodType;
  /** public (no bearer): login / health / device enroll+heartbeat */
  public?: boolean;
  /** success status (default 200 GET / 201 POST; login is 200) */
  success?: number;
  responses?: Record<string, unknown>;
  /** GET responses use success, POST default 201 */
  successBody?: unknown;
}

const P = 401;
const COMMON: Record<string, unknown> = {
  [P]: {
    description: 'UNAUTHENTICATED',
    content: { 'application/json': { schema: errSchema } },
  },
  403: {
    description: 'FORBIDDEN / UNAUTHORIZED_SCOPE',
    content: { 'application/json': { schema: errSchema } },
  },
};

const errRes = (code: number, description: string): Record<string, unknown> => ({
  description,
  content: { 'application/json': { schema: errSchema } },
});

function responsesOf(op: OpSpec): Record<string, unknown> {
  const status = op.success ?? (op.method === 'get' ? 200 : 201);
  const out: Record<string, unknown> = {
    [String(status)]: {
      description: 'success',
      content: {
        'application/json': { schema: op.successBody ?? { type: 'object' } },
      },
    },
  };
  if (!op.public) Object.assign(out, COMMON);
  const extra: Record<number, string> = {
    400: 'VALIDATION_FAILED',
    404: 'NOT_FOUND',
    409: 'VERSION_CONFLICT / CONFLICT',
    422: 'INVALID_STATE_TRANSITION / domain invariant',
    429: 'RATE_LIMITED',
    503: 'SERVICE_UNAVAILABLE',
  };
  for (const code of op.errors ?? []) {
    out[String(code)] = errRes(code, extra[code] ?? `HTTP ${code}`);
  }
  if (op.public && op.opId === 'login') out['429'] = errRes(429, 'RATE_LIMITED');
  if (op.public && (op.opId === 'deviceEnroll' || op.opId === 'deviceHeartbeat')) {
    out['429'] = errRes(429, 'RATE_LIMITED');
    if (op.opId === 'deviceHeartbeat') out['403'] = errRes(403, 'DEVICE_DISABLED');
  }
  return out;
}

const parameterOf = (op: OpSpec): unknown[] => {
  const out: unknown[] = [];
  for (const name of op.params ?? []) {
    out.push({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
  }
  for (const [name, schema] of Object.entries(op.query ?? {})) {
    out.push({ name, in: 'query', required: false, schema: jsonSchemaOf(schema) });
  }
  return out;
};

/** Ops table — the live route surface (each row traced to a controller). */
const OPS: Array<{ path: string } & OpSpec> = [
  // ── health ──
  {
    path: '/health/live',
    method: 'get',
    opId: 'getHealthLive',
    summary: 'Liveness: process is alive',
    public: true,
    successBody: dataObj({ status: { type: 'string', const: 'live' } }, ['status']),
  },
  {
    path: '/health/ready',
    method: 'get',
    opId: 'getHealthReady',
    summary: 'Readiness: DB reachable + migrations current',
    public: true,
    successBody: dataObj(),
    errors: [503],
  },
  // ── auth ──
  {
    path: '/v1/auth/login',
    method: 'post',
    opId: 'login',
    summary: 'Password login → access token (org code + username)',
    public: true,
    success: 200,
    body: z.object({ orgCode: z.string(), username: z.string(), password: z.string() }),
    successBody: dataObj({ token: { type: 'string' } }, ['token']),
    errors: [401, 429],
  },
  {
    path: '/v1/auth/me',
    method: 'get',
    opId: 'getMe',
    summary: 'Current principal, store scope and effective permissions',
    successBody: dataObj(),
  },
  // ── rooms ──
  {
    path: '/v1/rooms',
    method: 'get',
    opId: 'listRooms',
    summary: 'Store rooms with state, visit, service progress (board §9.1)',
    successBody: dataItems({ type: 'object' }),
  },
  {
    path: '/v1/rooms/{roomId}',
    method: 'get',
    opId: 'getRoom',
    summary: 'Room detail',
    params: ['roomId'],
    successBody: dataObj(),
    errors: [404],
  },
  ...(
    [
      [
        'roomOpen',
        'open',
        'Open a visit into a room (state gate)',
        z.object({ customerId: uuid.optional(), guestCount: z.int().positive().optional() }),
      ],
      [
        'roomMove',
        'move',
        'Move visit to another room (404 if destination missing)',
        z.object({ toRoomId: uuid }),
      ],
      ['cleaningStart', 'cleaning/start', 'VACANT_CLEAN→CLEANING', undefined],
      ['cleaningComplete', 'cleaning/complete', 'CLEANING→VACANT_CLEAN', undefined],
      ['maintenanceStart', 'maintenance/start', '→MAINTENANCE', undefined],
      ['maintenanceEnd', 'maintenance/end', 'MAINTENANCE_END→VACANT_CLEAN', undefined],
      ['roomDisable', 'disable', 'Disable room (VISIT_REQUIRED rooms refuse)', undefined],
      ['roomEnable', 'enable', 'Re-enable room', undefined],
    ] as Array<[string, string, string, z.ZodType | undefined]>
  ).map(([opId, seg, summary, body]) => ({
    path: `/v1/rooms/{roomId}/${seg}`,
    method: 'post' as const,
    opId,
    summary,
    params: ['roomId'],
    body: body ?? emptyBody,
    successBody: dataObj(),
    errors: [404, 422, 409],
  })),
  // ── technicians ──
  {
    path: '/v1/technicians',
    method: 'get',
    opId: 'listTechnicians',
    summary: 'Store technicians with skills & status (tech.read)',
    successBody: dataItems({ type: 'object' }),
  },
  ...(
    [
      ['clockIn', 'clock-in', 'OFF_DUTY→AVAILABLE (queue entry created)', 422],
      ['clockOut', 'clock-out', '→OFF_DUTY (active session → TECHNICIAN_BUSY)', 422],
      ['techLock', 'lock', 'Lock technician (no new work)', 422],
      ['techUnlock', 'unlock', 'Unlock → AVAILABLE', 422],
      ['breakStart', 'break/start', 'AVAILABLE→BREAK', 422],
      ['breakEnd', 'break/end', 'BREAK→AVAILABLE', 422],
    ] as Array<[string, string, string, number]>
  ).map(([opId, seg, summary, err]) => ({
    path: `/v1/technicians/{technicianId}/${seg}`,
    method: 'post' as const,
    opId,
    summary,
    params: ['technicianId'],
    body: emptyBody,
    successBody: dataObj(),
    errors: [404, err],
  })),
  // ── scheduling ──
  {
    path: '/v1/scheduling/queue',
    method: 'get',
    opId: 'getQueue',
    summary: 'Effective queue rotation (schedule.read)',
    successBody: dataItems({ type: 'object' }),
  },
  {
    path: '/v1/scheduling/recommend',
    method: 'post',
    opId: 'recommend',
    summary: '§6.5 explainable recommendation: selected + excluded reasons + weights',
    body: z.object({ serviceVariantId: uuid.optional(), roomId: uuid.optional() }),
    successBody: dataObj({
      selected: { type: ['object', 'null'] },
      excluded: { type: 'array', items: { type: 'object' } },
      weights: { type: 'object' },
      policy: { type: 'string' },
    }),
    errors: [422],
  },
  {
    path: '/v1/scheduling/assign',
    method: 'post',
    opId: 'assignSession',
    summary: 'Assign session to technician (rotation order enforced)',
    body: z.object({
      sessionId: uuid,
      technicianId: uuid,
      force: z.boolean().optional(),
      reason: z.string().optional(),
      ...versionFields,
    }),
    successBody: dataObj(),
    errors: [404, 409, 422],
  },
  {
    path: '/v1/scheduling/skip',
    method: 'post',
    opId: 'skipRotation',
    summary: 'Skip an ACTIVE queue entry (audit required)',
    body: z.object({ queueEntryId: uuid, reason: z.string().optional(), ...versionFields }),
    successBody: dataObj(),
    errors: [404, 422],
  },
  {
    path: '/v1/scheduling/compensate',
    method: 'post',
    opId: 'compensateRotation',
    summary: 'Compensation weight delta on a queue entry (append-only audit)',
    body: z.object({
      queueEntryId: uuid,
      delta: z.int(),
      reason: z.string().optional(),
      ...versionFields,
    }),
    successBody: dataObj(),
    errors: [404, 422],
  },
  {
    path: '/v1/scheduling/reorder',
    method: 'post',
    opId: 'reorderRotation',
    summary: 'Manual reorder (force permission; approval may be required)',
    body: z.object({
      queueEntryId: uuid,
      toPosition: z.int().nonnegative(),
      force: z.boolean().optional(),
      reason: z.string().optional(),
      ...versionFields,
    }),
    successBody: dataObj(),
    errors: [404, 422],
  },
  // ── service sessions ──
  {
    path: '/v1/service-sessions',
    method: 'post',
    opId: 'createSession',
    summary: 'Create session (DRAFT; one active session per technician invariant)',
    body: z.object({
      visitId: uuid.optional(),
      roomId: uuid.optional(),
      serviceVariantId: uuid,
      technicianId: uuid.optional(),
      assignmentType: z.enum(['ROTATION', 'REQUESTED', 'MANUAL']).optional(),
      queuePositionSnapshot: z.int().nonnegative().optional(),
      expectedVersion: z.int().nonnegative().optional(),
    }),
    successBody: dataObj(),
    errors: [404, 422],
  },
  {
    path: '/v1/service-sessions',
    method: 'get',
    opId: 'listSessions',
    summary:
      'Store session list: technician/room/status/activeOnly/today filters (today = visit business_date)',
    query: {
      technicianId: uuid,
      roomId: uuid,
      status: z.string(),
      activeOnly: z.enum(['1', 'true', '0', 'false']),
      today: z.enum(['1', 'true', '0', 'false']),
      limit: z.coerce.number().int().positive().max(500),
    },
    successBody: dataItems({ type: 'object' }),
  },
  {
    path: '/v1/service-sessions/{sessionId}',
    method: 'get',
    opId: 'getSession',
    summary: 'Session detail + event history',
    params: ['sessionId'],
    successBody: dataObj(),
    errors: [404],
  },
  ...(
    [
      ['assignSession', 'assign', 'ASSIGNED (queue position snapshot captured)'],
      ['acknowledgeSession', 'acknowledge', 'DRAFT/ASSIGNED→ACKNOWLEDGED (own or manage)'],
      ['arriveSession', 'arrive', 'ACKNOWLEDGED→ARRIVED (room/guest gates)'],
      ['startSession', 'start', 'ARRIVED→STARTED; room→SERVICE_STARTED'],
      ['extendSession', 'extend', 'Extend duration (time-override permission)'],
      ['changeTechnician', 'change-technician', 'Reassign with new technician state gate'],
      ['changeService', 'change-service', 'Change variant with price/history update'],
      ['completeSession', 'complete', 'STARTED/ENDING_SOON→COMPLETED; room→WAITING_CHECKOUT'],
      ['terminateSession', 'terminate', 'Emergency terminate (service.terminate)'],
    ] as Array<[string, string, string]>
  ).map(([opId, seg, summary]) => ({
    path: `/v1/service-sessions/{sessionId}/${seg}`,
    method: 'post' as const,
    opId,
    summary,
    params: ['sessionId'],
    body:
      seg === 'assign'
        ? z.object({ technicianId: uuid, ...versionFields })
        : seg === 'extend'
          ? z.object({ deltaMinutes: z.int().positive(), ...versionFields })
          : seg === 'change-technician'
            ? z.object({ technicianId: uuid, reason: z.string().optional(), ...versionFields })
            : seg === 'change-service'
              ? z.object({ serviceVariantId: uuid, ...versionFields })
              : emptyBody,
    successBody: dataObj(),
    errors: [404, 409, 422],
  })),
  // ── catalog ──
  {
    path: '/v1/service-variants',
    method: 'get',
    opId: 'listVariants',
    summary: 'Active priced variants for the principal org (service.read)',
    successBody: dataItems({ type: 'object' }),
  },
  // ── devices (§10) ──
  {
    path: '/v1/devices/enroll',
    method: 'post',
    opId: 'deviceEnroll',
    summary: 'Public kiosk enrollment (X-Org-Code) → §10.2 device_code; rate-limited',
    public: true,
    body: z.object({
      platform: z.string().max(60).optional(),
      appVersion: z.string().max(40).optional(),
    }),
    successBody: dataObj(
      { id: { type: 'string' }, deviceCode: { type: 'string' }, status: { type: 'string' } },
      ['deviceCode'],
    ),
    errors: [400, 404, 429],
  },
  {
    path: '/v1/devices',
    method: 'get',
    opId: 'listDevices',
    summary: 'Store devices incl. unbound PENDING (device.read)',
    successBody: dataItems({ type: 'object' }),
  },
  {
    path: '/v1/devices/heartbeat',
    method: 'get',
    opId: 'deviceHeartbeat',
    summary: 'Public kiosk heartbeat (X-Device-Code) → binding + server time; bumps last_seen_at',
    public: true,
    successBody: dataObj(
      { deviceId: { type: 'string' }, status: { type: 'string' }, bound: { type: 'boolean' } },
      ['status'],
    ),
    errors: [404, 403],
  },
  ...(
    [
      [
        'deviceBind',
        'bind',
        'Bind org→store→room (server cross-checks; one ACTIVE per room)',
        z.object({ storeId: uuid, roomId: uuid }),
        [409, 422],
      ],
      ['deviceUnbind', 'unbind', 'ACTIVE→PENDING (refs cleared)', emptyBody, [422]],
      ['deviceDisable', 'disable', '→DISABLED (heartbeat refused)', emptyBody, [422]],
      ['deviceRevoke', 'revoke', '→REVOKED (terminal)', emptyBody, [422]],
    ] as Array<[string, string, string, z.ZodType, number[]]>
  ).map(([opId, seg, summary, body, errors]) => ({
    path: `/v1/devices/{deviceId}/${seg}`,
    method: 'post' as const,
    opId,
    summary,
    params: ['deviceId'],
    body,
    successBody: dataObj(),
    errors: [404, ...errors],
  })),
];

function tagOf(path: string): string {
  if (path.startsWith('/health')) return 'health';
  const segs = path.split('/'); // ['', 'v1', '<tag>', ...]
  return (segs[2] ?? segs[1] ?? 'api').replace(/[{}]/g, '') || 'api';
}

function buildOperation(op: { path: string } & OpSpec): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: op.opId,
    summary: op.summary,
    tags: [tagOf(op.path)],
    responses: responsesOf(op),
  };
  const params = parameterOf(op);
  if (params.length > 0) operation.parameters = params;
  if (op.body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: jsonSchemaOf(op.body) } },
    };
  }
  if (!op.public) operation.security = [{ bearerAuth: [] }];
  return operation;
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    paths[op.path] = paths[op.path] ?? {};
    paths[op.path]![op.method] = buildOperation(op);
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'LanXu StoreOS API',
      version: '0.1.0',
      description:
        '澜序 LanXu StoreOS V1 HTTP contract. Clients branch on error.code only. ' +
        'Source of truth: docs/product/lanxu-storeos-v1-master-spec.md §7.',
    },
    servers: [{ url: '/', description: 'current host' }],
    paths,
    components: {
      schemas: {
        ErrorEnvelope: jsonSchemaOf(apiErrorSchema),
      },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}
