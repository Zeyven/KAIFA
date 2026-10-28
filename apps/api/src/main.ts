import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadEnv } from '@lanxu/config';
import { createLogger } from '@lanxu/observability';
import { AppModule } from './app.module';
import { createFastifyOptions } from './common/fastify-options';
import { StructuredNestLogger } from './common/structured-logger';
import { configureApi } from './setup';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.LOG_LEVEL, service: 'lanxu-api' });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(createFastifyOptions()),
    { logger: false },
  );
  app.useLogger(new StructuredNestLogger(logger));
  configureApi(app, logger);
  app.enableShutdownHooks();

  // Bind on all interfaces — sandbox previews reach 0.0.0.0, not loopback.
  await app.listen(env.PORT, '0.0.0.0');
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'lanxu-api listening');
}

bootstrap().catch((err: unknown) => {
  console.error('fatal: failed to start lanxu-api', err);
  process.exit(1);
});
