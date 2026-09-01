import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  serverExternalPackages: ["mem0ai", "ollama", "@qdrant/js-client-rest"],
};

export default nextConfig;
