import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { ReplayClip } from '../game/rinkPlayback';
import { viewFor, type ReplayCamera, type ReplayView } from './replayCameras';

/**
 * MP4 export of the 3D goal replay.
 *
 * Frames are rendered offline (not screen-captured): every frame is drawn at an exact clip time at the export
 * resolution, the broadcast graphics (score bug, shot label, «ГОЛ» lower third, «ПОВТОР» badge) are composited
 * on a 2D canvas, and the result is encoded with WebCodecs (H.264, else VP9/AV1) and muxed into MP4.
 * A browser without VideoEncoder falls back to MediaRecorder (MP4 only) playing the frames in real time.
 */

/** Implemented by ReplayScene: renders the scene into its own canvas at a given size, time and camera. */
export type ReplayFrameSource = {
  begin(width: number, height: number): void;
  frame(time: number, view: ReplayView): HTMLCanvasElement;
  end(): void;
};

export type ExportGraphics = {
  label: string; period: string; strength: string;
  home: { short: string; color: string }; away: { short: string; color: string };
  /** Score before and after the goal. */
  before: [number, number]; after: [number, number];
  scorer?: string; assists?: string;
};

export type ExportOptions = {
  source: ReplayFrameSource; clip: ReplayClip; camera: ReplayCamera; graphics: ExportGraphics;
  height?: 720 | 1080; fps?: 30 | 60;
  onProgress?: (done: number) => void; signal?: AbortSignal;
};

export type ExportResult = { blob: Blob; codec: string; frames: number; seconds: number; method: 'webcodecs' | 'mediarecorder' };

type Shot = { time: number; view: ReplayView; replay: boolean; speed: number };

/** The edit: the whole clip in real time, then the shot and the goal again in slow motion from another angle. */
export function exportTimeline(clip: ReplayClip, camera: ReplayCamera, fps: number): Shot[] {
  const out: Shot[] = [];
  const n = Math.max(1, Math.round(clip.duration * fps));
  for (let i = 0; i <= n; i++) { const time = i / n; out.push({ time, view: viewFor(camera, clip, time), replay: false, speed: 1 }); }
  const s = (sec: number) => sec / clip.duration, speed = .35;
  const from = Math.max(0, clip.release - s(1.3)), to = Math.min(1, clip.goal + s(.7));
  const live = viewFor(camera, clip, clip.release);
  const replayView: ReplayView = camera !== 'auto' ? camera : live === 'end' || live === 'chase' ? 'net' : 'end';
  // A short hold on the last live frame, then the slow-motion replay.
  for (let i = 0; i < Math.round(fps * .4); i++) out.push({ ...out[out.length - 1] });
  const m = Math.max(1, Math.round(((to - from) * clip.duration / speed) * fps));
  for (let i = 0; i <= m; i++) out.push({ time: from + (to - from) * (i / m), view: i / m > .78 && camera === 'auto' ? 'goal' : replayView, replay: true, speed });
  return out;
}

const CODECS: [string, 'avc' | 'vp9' | 'av1', (h: number) => string][] = [
  ['H.264', 'avc', h => (h > 720 ? 'avc1.640028' : 'avc1.64001f')],
  ['H.264', 'avc', h => (h > 720 ? 'avc1.4d0028' : 'avc1.4d001f')],
  ['H.264', 'avc', () => 'avc1.42e028'],
  ['VP9', 'vp9', () => 'vp09.00.40.08'],
  ['AV1', 'av1', () => 'av01.0.08M.08'],
];

async function pickCodec(width: number, height: number, fps: number, bitrate: number) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const [name, mux, id] of CODECS) {
    const config: VideoEncoderConfig = { codec: id(height), width, height, bitrate, framerate: fps, latencyMode: 'quality', ...(mux === 'avc' ? { avc: { format: 'avc' } } : {}) };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { name, mux, config }; } catch { /* next */ }
  }
  return null;
}

const recorderType = () => (typeof MediaRecorder === 'undefined' ? null : ['video/mp4;codecs=avc1', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t)) ?? null);

/** Whether this browser can produce an MP4 at all (WebCodecs, or MediaRecorder with MP4 output). */
export async function canExportMp4(): Promise<boolean> {
  return !!(await pickCodec(1280, 720, 30, 5e6)) || !!recorderType();
}

const yieldToBrowser = () => new Promise<void>(resolve => { const ch = new MessageChannel(); ch.port1.onmessage = () => resolve(); ch.port2.postMessage(0); });

/** Broadcast graphics over a rendered frame. */
export function drawGraphics(ctx: CanvasRenderingContext2D, w: number, h: number, g: ExportGraphics, shot: Shot, clip: ReplayClip) {
  const u = h / 1080, goal = shot.time >= clip.goal;
  const score = goal ? g.after : g.before;
  ctx.save();
  ctx.textBaseline = 'middle';
  const font = (px: number, weight = 700) => `${weight} ${Math.round(px * u)}px Oswald, "Arial Narrow", sans-serif`;
  const pill = (x: number, y: number, text: string, px: number, bg: string, fg = '#ffffff', align: 'left' | 'right' = 'left') => {
    ctx.font = font(px); const tw = ctx.measureText(text).width, pw = tw + 28 * u, ph = px * 1.6 * u;
    const x0 = align === 'left' ? x : x - pw;
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x0, y, pw, ph, 8 * u); ctx.fill();
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.fillText(text, x0 + 14 * u, y + ph / 2 + 1 * u);
    return pw;
  };
  // Score bug, top left: [home | score | away] with club colour bars.
  const x = 40 * u, y = 36 * u, bh = 58 * u;
  ctx.font = font(34);
  const hw = Math.max(110 * u, ctx.measureText(g.home.short).width + 36 * u), aw = Math.max(110 * u, ctx.measureText(g.away.short).width + 36 * u), sw = 120 * u;
  ctx.fillStyle = 'rgba(6,12,22,.86)'; ctx.beginPath(); ctx.roundRect(x, y, hw + sw + aw, bh, 10 * u); ctx.fill();
  ctx.fillStyle = g.home.color; ctx.fillRect(x, y + bh - 7 * u, hw, 7 * u);
  ctx.fillStyle = g.away.color; ctx.fillRect(x + hw + sw, y + bh - 7 * u, aw, 7 * u);
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
  ctx.fillText(g.home.short, x + hw / 2, y + bh / 2 - 2 * u); ctx.fillText(g.away.short, x + hw + sw + aw / 2, y + bh / 2 - 2 * u);
  ctx.fillStyle = goal ? '#f5b942' : '#ffffff'; ctx.font = font(38);
  ctx.fillText(`${score[0]} : ${score[1]}`, x + hw + sw / 2, y + bh / 2);
  pill(x, y + bh + 10 * u, `${g.period} · ${g.strength}`, 22, 'rgba(6,12,22,.72)', '#c9d6e2');
  // Shot type, top right; slow-motion badge during the replay.
  pill(w - 40 * u, y, shot.replay ? `ПОВТОР · ×${shot.speed}` : g.label, 26, shot.replay ? '#d8314b' : 'rgba(6,12,22,.78)', '#ffffff', 'right');
  // Lower third once the puck is in: ГОЛ + scorer (+ assists).
  if (goal) {
    const k = Math.min(1, (shot.time - clip.goal) * clip.duration / .35 / (shot.replay ? 1 / shot.speed : 1));
    const by = h - 170 * u, bx = 40 * u - (1 - k) * 60 * u;
    ctx.globalAlpha = k;
    ctx.fillStyle = '#d8314b'; ctx.beginPath(); ctx.roundRect(bx, by, 190 * u, 92 * u, 10 * u); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.font = font(60); ctx.fillText('ГОЛ', bx + 95 * u, by + 48 * u);
    if (g.scorer) {
      ctx.font = font(40); const nameW = ctx.measureText(g.scorer).width;
      ctx.font = font(24, 500); const asW = g.assists ? ctx.measureText(g.assists).width : 0;
      const pw = Math.max(nameW, asW) + 48 * u;
      ctx.fillStyle = 'rgba(6,12,22,.86)'; ctx.beginPath(); ctx.roundRect(bx + 200 * u, by, pw, 92 * u, 10 * u); ctx.fill();
      ctx.textAlign = 'left'; ctx.fillStyle = '#ffffff'; ctx.font = font(40); ctx.fillText(g.scorer, bx + 224 * u, by + (g.assists ? 34 : 47) * u);
      if (g.assists) { ctx.fillStyle = '#9fb6c4'; ctx.font = font(24, 500); ctx.fillText(g.assists, bx + 224 * u, by + 70 * u); }
    }
    ctx.globalAlpha = 1;
  }
  // Watermark.
  ctx.textAlign = 'right'; ctx.font = font(20, 500); ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fillText('KHL Manager · 3D-повтор', w - 40 * u, h - 34 * u);
  ctx.restore();
}

export async function exportReplayMp4(opts: ExportOptions): Promise<ExportResult> {
  const fps = opts.fps ?? 30, height = opts.height ?? 1080, width = Math.round((height * 16) / 9 / 2) * 2;
  const bitrate = height > 720 ? 12_000_000 : 6_000_000;
  const shots = exportTimeline(opts.clip, opts.camera, fps);
  const comp = document.createElement('canvas'); comp.width = width; comp.height = height;
  const ctx = comp.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D недоступен');
  // Make sure the broadcast font is ready before the first frame (it is bundled with the app).
  try { await document.fonts?.load(`700 40px Oswald`); } catch { /* system font fallback */ }
  const abort = () => { if (opts.signal?.aborted) throw new DOMException('Экспорт отменён', 'AbortError'); };
  const compose = (shot: Shot) => {
    const frame = opts.source.frame(shot.time, shot.view);
    ctx.drawImage(frame, 0, 0, width, height);
    drawGraphics(ctx, width, height, opts.graphics, shot, opts.clip);
  };
  const picked = await pickCodec(width, height, fps, bitrate);
  opts.source.begin(width, height);
  try {
    if (picked) {
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({ target, video: { codec: picked.mux, width, height, frameRate: fps }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
      let failure: unknown = null;
      const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => { failure = e; } });
      encoder.configure(picked.config);
      try {
        for (let i = 0; i < shots.length; i++) {
          abort(); if (failure) throw failure;
          compose(shots[i]);
          const frame = new VideoFrame(comp, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
          encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
          frame.close();
          while (encoder.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2));
          if (i % 4 === 0) { opts.onProgress?.(i / shots.length); await yieldToBrowser(); }
        }
        await encoder.flush();
        if (failure) throw failure;
      } finally { if (encoder.state !== 'closed') encoder.close(); }
      muxer.finalize();
      opts.onProgress?.(1);
      return { blob: new Blob([target.buffer], { type: 'video/mp4' }), codec: picked.name, frames: shots.length, seconds: shots.length / fps, method: 'webcodecs' };
    }
    const type = recorderType();
    if (!type) throw new Error('Этот браузер не умеет кодировать видео в MP4');
    // Fallback: real-time recording of the composited frames.
    const stream = comp.captureStream(0), track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: bitrate });
    const parts: Blob[] = [];
    recorder.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.start(250);
    const t0 = performance.now();
    try {
      for (let i = 0; i < shots.length; i++) {
        abort();
        compose(shots[i]); track.requestFrame?.();
        opts.onProgress?.(i / shots.length);
        const wait = t0 + ((i + 1) * 1000) / fps - performance.now();
        await new Promise(r => setTimeout(r, Math.max(0, wait)));
      }
    } finally { recorder.stop(); await stopped; track.stop(); }
    opts.onProgress?.(1);
    return { blob: new Blob(parts, { type: 'video/mp4' }), codec: type, frames: shots.length, seconds: shots.length / fps, method: 'mediarecorder' };
  } finally {
    opts.source.end();
  }
}

const LATIN: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
/** ASCII file name (some systems drop non-Latin download names and save as "download"). */
export function videoFileName(parts: string[]): string {
  const latin = parts.join('_').split('').map(ch => { const l = LATIN[ch.toLowerCase()]; return l === undefined ? ch : ch === ch.toLowerCase() ? l : l.charAt(0).toUpperCase() + l.slice(1); }).join('');
  return `${latin.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'replay'}.mp4`;
}

/** Saves the file (or opens the share sheet on phones that cannot download blobs). */
export async function saveVideo(blob: Blob, name: string) {
  const file = typeof File !== 'undefined' ? new File([blob], name, { type: 'video/mp4' }) : null;
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  if (coarse && file && nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], title: name }); return; } catch (e) { if ((e as DOMException)?.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
