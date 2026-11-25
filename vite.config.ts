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
 * Mod folders (`mods/<id>/` with a roster.json) in the order of `mods/index.json`, then the rest alphabetically.
 * A static site can't list a directory, so the game reads this list from mods/index.json.
 */
function scanMods(modsDir: string): string[] {
  if (!fs.existsSync(modsDir)) return [];
  let listed: string[] = [];
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(modsDir, "index.json"), "utf8"));
    listed = (Array.isArray(idx) ? idx : idx?.mods ?? []).map((x: unknown) => (typeof x === "string" ? x : (x as { id?: string })?.id)).filter(Boolean);
  } catch {
    /* no index yet */
  }
  const found = fs
    .readdirSync(modsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(modsDir, d.name, "roster.json")))
    .map((d) => d.name)
    .sort();
  return [...listed.filter((id) => found.includes(id)), ...found.filter((id) => !listed.includes(id))];
}
const modIndexText = (ids: string[]) => JSON.stringify({ mods: ids }, null, 2) + "\n";

/**
 * Ensures `dist/` is a self-contained static bundle ready for GitHub Pages (`/KHL_Manager/` or any static path):
 * lists the mod folders in `dist/mods/index.json` and writes `.nojekyll`.
 * The dev server answers `mods/index.json` from the folders in `public/mods` the same way.
 */
function githubPagesBundle(): Plugin {
  let outDir = path.resolve(__dirname, "dist");
  return {
    name: "khl-github-pages-bundle",
    configResolved(cfg) {
      outDir = path.resolve(cfg.root, cfg.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!/\/mods\/index\.json(\?|$)/.test(req.url ?? "")) return next();
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(modIndexText(scanMods(path.resolve(__dirname, "public/mods"))));
      });
    },
    closeBundle() {
      if (!fs.existsSync(outDir)) return;
      const modsDir = path.join(outDir, "mods");
      if (fs.existsSync(modsDir)) fs.writeFileSync(path.join(modsDir, "index.json"), modIndexText(scanMods(modsDir)));
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
