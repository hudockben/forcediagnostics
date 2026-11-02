import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  async redirects() {
    return [
      // The signed-in page moved to the Home tab.
      { source: "/shop", destination: "/home", permanent: false },
      // Customers and the Sticker & Plate log moved out of System Admin to
      // tabs of their own; links and bookmarks to the old pages still work.
      { source: "/admin/customers/:path*", destination: "/customers/:path*", permanent: false },
      { source: "/admin/sticker-plate-log/:path*", destination: "/sticker-plate-log/:path*", permanent: false },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
