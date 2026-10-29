import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type * as Jose from 'jose';
import { type AppEnv } from '@lanxu/config';
import { ApiError } from '@lanxu/contracts';
import { ENV } from '../env/env.module';

/**
 * JWT (HS256) via `jose`, loaded through dynamic import so this CJS build works
 * whether jose ships ESM or dual. The raw UTF-8 secret is passed as a
 * Uint8Array (jose's HMAC API — no key-import step needed).
 * Algorithm is pinned to HS256: `alg: none` / algorithm-confusion attempts fail.
 */

export interface AccessTokenPayload {
  sub: string;
  orgId: string;
  username: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtService implements OnModuleInit {
  private jose!: typeof Jose;
  private key!: Uint8Array;
  private readonly ttlSeconds: number;

  constructor(@Inject(ENV) private readonly env: AppEnv) {
    this.ttlSeconds = env.JWT_ACCESS_TTL_SECONDS;
  }

  async onModuleInit(): Promise<void> {
    this.jose = await import('jose');
    this.key = new TextEncoder().encode(this.env.JWT_SECRET);
  }

  async sign(payload: Omit<AccessTokenPayload, 'iat' | 'exp'>): Promise<{
    token: string;
    expiresIn: number;
  }> {
    // jose numbers are ABSOLUTE unix seconds — compute iat/exp explicitly so
    // the token is not born expired (setExpirationTime(ttl) would be 1970+ttl).
    const now = Math.floor(Date.now() / 1000);
    const token = await new this.jose.SignJWT({ orgId: payload.orgId, username: payload.username })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(payload.sub)
      .setIssuedAt(now)
      .setExpirationTime(now + this.ttlSeconds)
      .sign(this.key);
    return { token, expiresIn: this.ttlSeconds };
  }

  async verify(token: string): Promise<AccessTokenPayload> {
    try {
      const { payload } = await this.jose.jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        clockTolerance: 5,
      });
      if (!payload.sub || typeof payload.orgId !== 'string' || !payload.username) {
        throw new ApiError('UNAUTHENTICATED', 'Token missing required claims.');
      }
      return payload as unknown as AccessTokenPayload;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('UNAUTHENTICATED', 'Invalid or expired token.');
    }
  }
}
