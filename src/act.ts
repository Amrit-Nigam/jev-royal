import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ActionCoordinates, JevDecision, Placement, WindowBounds } from './types.js';

const execFileAsync = promisify(execFile);
const HELPER_PATH = resolve(process.cwd(), 'bin/helper');

/**
 * Horizontal centers of the four card slots, as fractions of the mirroring
 * window. Measured from the elixir-cost badges on real capture frames.
 */
export const CARD_SLOT_X: Record<number, number> = {
  1: 0.3204,
  2: 0.4983,
  3: 0.6763,
  4: 0.8542,
};

/** Vertical center of a card in hand. */
export const CARD_SLOT_Y = 0.88;

export interface ActOptions {
  dryRun?: boolean;
  clickTool?: 'native' | 'cliclick';
  tapDelayMs?: number;
}

/** Converts a card slot and an arena placement into absolute screen points. */
export function calculateActionCoordinates(
  windowBounds: WindowBounds,
  slot: number,
  placement: Placement
): ActionCoordinates {
  const slotX = CARD_SLOT_X[slot] ?? CARD_SLOT_X[1];

  return {
    cardScreenX: Math.round(windowBounds.x + windowBounds.width * slotX),
    cardScreenY: Math.round(windowBounds.y + windowBounds.height * CARD_SLOT_Y),
    targetScreenX: Math.round(windowBounds.x + windowBounds.width * placement.x),
    targetScreenY: Math.round(windowBounds.y + windowBounds.height * placement.y),
  };
}

/**
 * Plays a card: tap the card in hand, then tap where it should go.
 */
export async function executePlay(
  windowBounds: WindowBounds,
  decision: JevDecision,
  options: ActOptions = {}
): Promise<ActionCoordinates | null> {
  if (!decision.shouldPlayNow || !decision.action) return null;

  const { card, placement } = decision.action;
  const coords = calculateActionCoordinates(windowBounds, card.slot, placement);

  if (options.dryRun) {
    console.log(
      `[act:DRY_RUN] would play ${card.name} (slot ${card.slot}) at ${placement.label} ` +
        `-> tap (${coords.cardScreenX}, ${coords.cardScreenY}) then (${coords.targetScreenX}, ${coords.targetScreenY})`
    );
    return coords;
  }

  const tapDelay = options.tapDelayMs ?? 120;
  const tool = options.clickTool || process.env.CLICK_TOOL || 'native';

  if (tool === 'cliclick') {
    await execFileAsync('cliclick', [
      `c:${coords.cardScreenX},${coords.cardScreenY}`,
      `w:${tapDelay}`,
      `c:${coords.targetScreenX},${coords.targetScreenY}`,
    ]);
  } else {
    await execFileAsync(HELPER_PATH, [
      'tap-sequence',
      String(coords.cardScreenX),
      String(coords.cardScreenY),
      String(coords.targetScreenX),
      String(coords.targetScreenY),
      String(tapDelay),
    ]);
  }

  console.log(`[act] played ${card.name} (slot ${card.slot}) at ${placement.label}`);
  return coords;
}
