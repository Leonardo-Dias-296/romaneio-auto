import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Proxy local: em dev, /api/* vai para a Vercel CLI (vercel dev)
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
