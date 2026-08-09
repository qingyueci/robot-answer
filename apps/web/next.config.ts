import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["mem0ai", "ollama", "@qdrant/js-client-rest"],
};

export default nextConfig;
