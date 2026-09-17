import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_CAPTURES_DIR = resolve(process.cwd(), 'captures');

export interface CaptureOptions {
  outputDir?: string;
  outputPath?: string;
  maxStoredFrames?: number;
}

/**
 * Ensures capture directory exists.
 */
export function ensureCapturesDir(dir = DEFAULT_CAPTURES_DIR): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Cleans up old frames to prevent disk space bloat.
 */
export function pruneOldCaptures(dir = DEFAULT_CAPTURES_DIR, keepLatest = 20): void {
  try {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ name: f, path: join(dir, f) }))
      .sort((a, b) => b.name.localeCompare(a.name));

    if (files.length > keepLatest) {
      for (const file of files.slice(keepLatest)) {
        try {
          unlinkSync(file.path);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  } catch {
    // ignore directory read errors
  }
}

/**
 * Captures a screenshot of the specified window by CoreGraphics window ID.
 * Uses `screencapture -x -o -l<windowId> <path>`
 * -x: silent (no shutter sound)
 * -o: no shadow
 */
export async function captureWindow(
  windowId: number,
  options: CaptureOptions = {}
): Promise<{ filePath: string; base64: string }> {
  const dir = options.outputDir || DEFAULT_CAPTURES_DIR;
  ensureCapturesDir(dir);

  const timestamp = Date.now();
  const filePath = options.outputPath || join(dir, `frame_${timestamp}.png`);

  // Run screencapture without shadow and silently
  await execFileAsync('screencapture', ['-x', '-o', `-l${windowId}`, filePath]);

  if (!existsSync(filePath)) {
    throw new Error(`Screen capture failed: file ${filePath} was not created`);
  }

  // Prune older files
  pruneOldCaptures(dir, options.maxStoredFrames ?? 20);

  // Read base64 for vision API
  const buffer = await readFile(filePath);
  const base64 = buffer.toString('base64');

  return { filePath, base64 };
}
