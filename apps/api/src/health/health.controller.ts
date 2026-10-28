import { Controller, Get, Inject } from '@nestjs/common';
import { ApiError } from '@lanxu/contracts';
import { READINESS, type ReadinessService } from './readiness.service';

@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: ReadinessService) {}

  /** Liveness: process is alive. Never touches dependencies. */
  @Get('live')
  live(): { data: { status: 'live' } } {
    return { data: { status: 'live' } };
  }

  /** Readiness: DB reachable + migrations current. 503 envelope when not. */
  @Get('ready')
  async ready(): Promise<{ data: ReadinessResponse }> {
    const result = await this.readiness.check();
    if (result.status !== 'ready') {
      throw new ApiError(
        'SERVICE_UNAVAILABLE',
        'Service is not ready to accept traffic.',
        Object.entries(result.checks).map(([path, state]) => ({
          path,
          code: 'CHECK_FAILED',
          message: state,
        })),
      );
    }
    return { data: { status: 'ready', checks: result.checks } };
  }
}

interface ReadinessResponse {
  status: 'ready';
  checks: Record<string, string>;
}
