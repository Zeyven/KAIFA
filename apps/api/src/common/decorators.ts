import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'lanxu.is_public';
export const PERMISSIONS_KEY = 'lanxu.permissions';
export const NO_STORE_SCOPE_KEY = 'lanxu.no_store_scope';

/** Bypass authentication (health, login). Never use on business commands. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Route requires ALL listed permission codes within the scoped store. */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

/** Route does not act on a store (login, /me identity bootstrap). */
export const NoStoreScope = () => SetMetadata(NO_STORE_SCOPE_KEY, true);
