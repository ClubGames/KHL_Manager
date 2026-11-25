/// <reference types="vite/client" />

/** Build stamp from vite.config.ts: commit time (seconds), short sha, apps' version «1.0.N» (empty outside CI). */
declare const __KHL_BUILD__: { build: number; sha: string; version: string };
