import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works on any static host (Pages, Vercel, a subpath).
  base: "./",
  worker: { format: "es" },
});
