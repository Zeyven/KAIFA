/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages are TS-compiled libs — let Next transpile them.
  transpilePackages: ['@lanxu/contracts', '@lanxu/domain', '@lanxu/ui'],
  output: 'standalone',
  poweredByHeader: false,
  async rewrites() {
    // Browser never calls the API host directly (spec §11 + preview rules):
    // relative /api/v1/* is proxied by this server to the modular monolith.
    const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4000';
    return [{ source: '/api/v1/:path*', destination: `${apiTarget}/v1/:path*` }];
  },
};

export default nextConfig;
