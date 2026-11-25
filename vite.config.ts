import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Build stamp shared by the browser version and both apps (they all ship the same `dist/`): the commit time orders
 * builds, `version` is the apps' «1.0.N» when CI sets APP_VERSION. Written to `dist/version.json` for the update check.
 */
function buildInfo() {
  const git = (cmd: string) => {
    try {
      return execSync(cmd, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  };
  const build = Number(process.env.KHL_BUILD_TIME || git("git log -1 --format=%ct")) || Math.floor(Date.now() / 1000);
  const sha = (process.env.GITHUB_SHA || git("git rev-parse HEAD") || "").slice(0, 7);
  const version = process.env.APP_VERSION || "";
  return { build, sha, version };
}
const BUILD = buildInfo();

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
      fs.writeFileSync(path.join(outDir, "version.json"), JSON.stringify({ ...BUILD, date: new Date(BUILD.build * 1000).toISOString() }) + "\n");
    },
  };
}

export default defineConfig({
  base: "./",
  define: {
    __KHL_BUILD__: JSON.stringify(BUILD),
  },
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
