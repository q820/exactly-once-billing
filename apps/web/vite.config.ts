import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works on any static host (Pages, Vercel, a subpath).
  base: "./",
  worker: { format: "es" },
  // 5173 is Vite's default and often taken by another local project; fail loudly instead of drifting.
  server: { host: "127.0.0.1", port: 5180, strictPort: true },
});
