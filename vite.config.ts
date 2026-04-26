import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  envDir: "..",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    host: true,
    fs: {
      // Allow importing shared protocol types from ../party.
      allow: [".."],
    },
    // Proxy PartyKit through Vite in dev so the client uses a single origin
    // (port 5173) — avoids iOS Safari's multi-port LAN restrictions and
    // matches the prod path (single host name) more closely.
    proxy: {
      "/parties": {
        target: "http://localhost:1999",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
