import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { ProductsController } from './products.controller';
import { CatalogService } from './catalog.service';

@Module({
  controllers: [CatalogController, ProductsController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
