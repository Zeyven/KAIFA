/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages are TS-compiled libs — let Next transpile them.
  transpilePackages: ['@lanxu/contracts', '@lanxu/domain', '@lanxu/ui'],
  output: 'standalone',
  poweredByHeader: false,
};

export default nextConfig;
