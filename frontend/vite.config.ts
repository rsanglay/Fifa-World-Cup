import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 5174 chosen to avoid the framework-default magnets (3000/5173) already
// in use elsewhere. Backend API proxied to FastAPI on :8090.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    host: true,
    proxy: {
      "/api": { target: "http://localhost:8090", changeOrigin: true },
    },
  },
});
