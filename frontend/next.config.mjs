/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@creit.tech/stellar-wallets-kit"],
  experimental: {
    serverComponentsExternalPackages: [
      "@x402/fetch",
      "@x402/stellar",
      "@stellar/stellar-sdk",
    ],
  },
  webpack(config) {
    // Register SWK subpath imports with webpack
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
    };
    // Prevent window access in Node environment
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

export default nextConfig;
