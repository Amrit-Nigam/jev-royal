import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { WindowInfo } from './types.js';

const execFileAsync = promisify(execFile);
const HELPER_PATH = resolve(process.cwd(), 'bin/helper');
const SWIFT_SRC_PATH = resolve(process.cwd(), 'native/helper.swift');

/**
 * Ensures the native helper binary is compiled.
 */
export function ensureHelperBinary(): void {
  if (!existsSync(HELPER_PATH)) {
    console.log('[window] Compiling native helper binary...');
    try {
      execFileSync('swiftc', [SWIFT_SRC_PATH, '-o', HELPER_PATH]);
      console.log('[window] Native helper compiled successfully.');
    } catch (err) {
      throw new Error(`Failed to compile native helper with swiftc: ${(err as Error).message}`);
    }
  }
}

/**
 * Lists all visible windows on screen.
 */
export async function listAllWindows(): Promise<WindowInfo[]> {
  ensureHelperBinary();
  const { stdout } = await execFileAsync(HELPER_PATH, ['list-windows']);
  return JSON.parse(stdout.trim()) as WindowInfo[];
}

/**
 * Finds the iPhone Mirroring app window.
 * Checks for "iPhone Mirroring", "iPhone", or a custom window query.
 */
export async function findTargetWindow(appQuery = 'iPhone Mirroring'): Promise<WindowInfo | null> {
  ensureHelperBinary();

  // Try the provided query first
  try {
    const { stdout } = await execFileAsync(HELPER_PATH, ['window', appQuery]);
    const parsed = JSON.parse(stdout.trim());
    if (parsed.id && parsed.bounds) {
      return parsed as WindowInfo;
    }
  } catch {
    // Try fallback queries if the specific one failed
  }

  // Fallback: try "iPhone"
  if (appQuery !== 'iPhone') {
    try {
      const { stdout } = await execFileAsync(HELPER_PATH, ['window', 'iPhone']);
      const parsed = JSON.parse(stdout.trim());
      if (parsed.id && parsed.bounds) {
        return parsed as WindowInfo;
      }
    } catch {
      // Ignored
    }
  }

  return null;
}
