/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Renamed from experimental.serverComponentsExternalPackages in Next 15.
  serverExternalPackages: ['pino', 'pg', 'bullmq', 'ioredis'],
};

export default nextConfig;
