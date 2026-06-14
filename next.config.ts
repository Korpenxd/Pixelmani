import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'wzmwzosavyphbxobepfi.supabase.co',
        port: '',
        pathname: '/storage/v1/object/public/photos/**',
      },
    ],
    qualities: [75, 85],
  },
}

export default nextConfig