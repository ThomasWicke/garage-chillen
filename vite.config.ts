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
  },
});
