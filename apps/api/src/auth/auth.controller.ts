import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { NoStoreScope, Public } from '../common/decorators';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';

const loginSchema = z.object({
  orgCode: z.string().min(1).max(64),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
});

type LoginBody = z.infer<typeof loginSchema>;

/** Credentials: validated for shape only — failure semantics live in AuthService. */
const credentialsSchema = loginSchema;

@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @NoStoreScope()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(credentialsSchema)) body: LoginBody,
    @Req() req: FastifyRequest,
  ): Promise<{ data: Awaited<ReturnType<AuthService['login']>> }> {
    const data = await this.auth.login({
      orgCode: body.orgCode,
      username: body.username,
      password: body.password,
      ip: req.ip,
    });
    return { data };
  }

  @NoStoreScope()
  @Get('me')
  async me(@Req() req: FastifyRequest): Promise<{
    data: Awaited<ReturnType<AuthService['identity']>> & { permissions: string[] | null };
  }> {
    const principal = req.principal;
    if (!principal) {
      throw new Error('me endpoint reached without principal — guard misconfigured');
    }
    const identity = await this.auth.identity(principal.userId);
    const storeHeader = req.headers['x-store-id'];
    const storeId = Array.isArray(storeHeader) ? storeHeader[0] : storeHeader;
    if (storeId && storeId === identity.stores.find((s) => s.id === storeId)?.id) {
      const perms = await this.auth.effectivePermissions(principal.userId, storeId);
      return { data: { ...identity, permissions: perms.permissions, storeId } };
    }
    return { data: identity };
  }
}
