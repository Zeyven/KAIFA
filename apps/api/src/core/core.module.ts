import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { EnvModule } from '../env/env.module';
import { DatabaseModule } from '../db/pg.module';
import { AuditService } from '../audit/audit.service';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { JwtService } from '../auth/jwt.service';
import { AppAuthGuard } from '../auth/guards/app-auth.guard';

/**
 * Global cross-cutting core: validated env, pg pool, audit writer, JWT, auth
 * pipeline. Registered once here so every module inherits the same guards.
 * NOTE: class dependencies of global guards use explicit @Inject — tests run
 * under esbuild (no emitDecoratorMetadata), prod and test must behave alike.
 */
@Global()
@Module({
  imports: [EnvModule, DatabaseModule],
  controllers: [AuthController],
  providers: [
    JwtService,
    AuthService,
    AuditService,
    { provide: APP_GUARD, useClass: AppAuthGuard },
  ],
  exports: [JwtService, AuthService, AuditService],
})
export class CoreModule {}
