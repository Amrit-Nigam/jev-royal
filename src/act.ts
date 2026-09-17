import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ActionCoordinates, JevDecision, PlacementLane, WindowBounds } from './types.js';

const execFileAsync = promisify(execFile);
const HELPER_PATH = resolve(process.cwd(), 'bin/helper');

// Calibrated normalized relative coordinates inside the iPhone Mirroring window
export const CARD_SLOT_RELATIVE_COORDS: Record<number, { x: number; y: number }> = {
  1: { x: 0.32, y: 0.88 },
  2: { x: 0.50, y: 0.88 },
  3: { x: 0.68, y: 0.88 },
  4: { x: 0.85, y: 0.88 },
};

export const LANE_RELATIVE_COORDS: Record<PlacementLane, { x: number; y: number }> = {
  left_bridge: { x: 0.27, y: 0.47 },
  right_bridge: { x: 0.73, y: 0.47 },
  defensive_left: { x: 0.27, y: 0.63 },
  defensive_right: { x: 0.73, y: 0.63 },
  defensive_center: { x: 0.50, y: 0.60 },
  back_cycle_left: { x: 0.27, y: 0.75 },
  back_cycle_right: { x: 0.73, y: 0.75 },
};

export interface ActOptions {
  dryRun?: boolean;
  clickTool?: 'native' | 'cliclick';
  tapDelayMs?: number;
}

/**
 * Calculates absolute screen coordinates for card slot and target placement.
 */
export function calculateActionCoordinates(
  windowBounds: WindowBounds,
  slot: number,
  lane: PlacementLane
): ActionCoordinates {
  const cardRel = CARD_SLOT_RELATIVE_COORDS[slot] || CARD_SLOT_RELATIVE_COORDS[1];
  const targetRel = LANE_RELATIVE_COORDS[lane] || LANE_RELATIVE_COORDS.defensive_center;

  return {
    cardScreenX: Math.round(windowBounds.x + windowBounds.width * cardRel.x),
    cardScreenY: Math.round(windowBounds.y + windowBounds.height * cardRel.y),
    targetScreenX: Math.round(windowBounds.x + windowBounds.width * targetRel.x),
    targetScreenY: Math.round(windowBounds.y + windowBounds.height * targetRel.y),
  };
}

/**
 * Executes the card play by simulating two taps:
 * 1. Tap card slot
 * 2. Tap placement target in arena
 */
export async function executePlay(
  windowBounds: WindowBounds,
  decision: JevDecision,
  options: ActOptions = {}
): Promise<ActionCoordinates | null> {
  if (!decision.shouldPlayNow || decision.whichCard === 'none') {
    return null;
  }

  // Parse slot number (slot1 -> 1, slot2 -> 2, etc.)
  const slotMatch = decision.whichCard.match(/\d+/);
  const slot = slotMatch ? parseInt(slotMatch[0], 10) : 1;
  const lane = decision.whichLane;

  const coords = calculateActionCoordinates(windowBounds, slot, lane);

  if (options.dryRun) {
    console.log(
      `[act:DRY_RUN] Would tap card slot ${slot} at (${coords.cardScreenX}, ${coords.cardScreenY}) then arena at (${coords.targetScreenX}, ${coords.targetScreenY})`
    );
    return coords;
  }

  const tapDelay = options.tapDelayMs ?? 150;
  const tool = options.clickTool || process.env.CLICK_TOOL || 'native';

  if (tool === 'cliclick') {
    // cliclick c:X,Y w:ms c:X,Y
    await execFileAsync('cliclick', [
      `c:${coords.cardScreenX},${coords.cardScreenY}`,
      `w:${tapDelay}`,
      `c:${coords.targetScreenX},${coords.targetScreenY}`,
    ]);
  } else {
    // Native Swift helper
    await execFileAsync(HELPER_PATH, [
      'tap-sequence',
      String(coords.cardScreenX),
      String(coords.cardScreenY),
      String(coords.targetScreenX),
      String(coords.targetScreenY),
      String(tapDelay),
    ]);
  }

  console.log(
    `[act] Successfully played Slot ${slot} to ${lane} [(${coords.cardScreenX},${coords.cardScreenY}) -> (${coords.targetScreenX},${coords.targetScreenY})]`
  );

  return coords;
}
