import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Ensures `dist/` is a self-contained static bundle ready for GitHub Pages (`/KHL_Manager/` or any static path):
 * copies root `roster.json` alongside `dist/index.html`, removes internal test fixtures, and writes `.nojekyll`.
 */
function githubPagesBundle(): Plugin {
  let outDir = path.resolve(__dirname, "dist");
  return {
    name: "khl-github-pages-bundle",
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    closeBundle() {
      if (!fs.existsSync(outDir)) return;
      const rootRoster = path.resolve(__dirname, "roster.json");
      const distRoster = path.join(outDir, "roster.json");
      if (fs.existsSync(rootRoster)) {
        fs.copyFileSync(rootRoster, distRoster);
      }
      const scratchRoster = path.join(outDir, "rostfdfer.json");
      if (fs.existsSync(scratchRoster)) {
        fs.rmSync(scratchRoster, { force: true });
      }
      fs.writeFileSync(path.join(outDir, ".nojekyll"), "");
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile(), githubPagesBundle()],
  build: {
    target: ["es2020", "safari15", "ios15", "chrome90"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
