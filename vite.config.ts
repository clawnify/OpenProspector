import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { logoUrl } from "@clawnify/logokit";

export default defineConfig({
  // Resolve the static brand at build time, keeping LogoKit's index out of the browser bundle.
  define: { "import.meta.env.VITE_LINKEDIN_LOGO_URL": JSON.stringify(logoUrl("linkedin.com", { format: "vector" })) },
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  resolve: { alias: { "@": path.resolve(__dirname, "./src/client") } },
  server: {
    proxy: { "/api": { target: "http://localhost:8789", changeOrigin: true } },
  },
});
