import { getSpellProperties } from './cards.js';
import type { ArenaUnit, CardInHand, Placement } from './types.js';

/**
 * Arena geometry, as fractions of the captured iPhone Mirroring window.
 *
 * These were measured off real capture frames by locating the tower hit-point
 * labels, which sit directly above each tower, and the river/bridge band
 * between them. Everything else is derived from these anchors rather than
 * hardcoded separately, so the whole layout stays self-consistent.
 */
export const ARENA = {
  /** Lane centers. Bridges sit in line with the princess towers. */
  leftLaneX: 0.23,
  rightLaneX: 0.77,
  centerX: 0.505,

  /** The river runs across the middle; troops may only cross at the bridges. */
  riverY: 0.47,

  ownPrincessY: 0.655,
  ownKingY: 0.785,
  opponentPrincessY: 0.255,
  opponentKingY: 0.155,

  /**
   * Deployable band on our side. The upper bound sits just below the river
   * (you cannot deploy across it) and the lower bound just past our king tower.
   */
  deployTopY: 0.505,
  deployBottomY: 0.80,
  deployLeftX: 0.07,
  deployRightX: 0.93,
} as const;

/**
 * Tile size, derived from measured landmarks rather than assumed.
 *
 * Clash Royale's arena is a tile grid, and good placements are described in
 * tiles ("three tiles in front of the tower"), so expressing offsets this way
 * makes them mean the same thing everywhere. The horizontal and vertical tile
 * sizes differ because the mirrored view is not square on screen, so each axis
 * is calibrated against its own landmarks: the distance between the two lanes
 * horizontally, and the river-to-tower distance vertically.
 */
export const TILE_X = (ARENA.rightLaneX - ARENA.leftLaneX) / 12;
export const TILE_Y = (ARENA.ownPrincessY - ARENA.riverY) / 6;

/** The two bridges, the only places ground troops can cross. */
export const BRIDGES = [
  { side: 'left' as const, x: ARENA.leftLaneX },
  { side: 'right' as const, x: ARENA.rightLaneX },
];

export function isOnOurSide(y: number): boolean {
  return y > ARENA.riverY;
}

export function clampToDeployZone(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(ARENA.deployRightX, Math.max(ARENA.deployLeftX, x)),
    y: Math.min(ARENA.deployBottomY, Math.max(ARENA.deployTopY, y)),
  };
}

function place(label: string, x: number, y: number): Placement {
  const clamped = clampToDeployZone(x, y);
  return { label, x: clamped.x, y: clamped.y };
}

/**
 * Where a unit will be after `seconds`, given its measured velocity.
 *
 * Units that are not moving, or that we failed to track, simply stay put.
 * Predictions are clamped to the arena so a bad velocity reading cannot send
 * an aim point off the board.
 */
export function predictPosition(unit: ArenaUnit, seconds: number): { x: number; y: number } {
  if (!unit.velocity) return { x: unit.x, y: unit.y };
  return {
    x: Math.min(0.97, Math.max(0.03, unit.x + unit.velocity.x * seconds)),
    y: Math.min(0.84, Math.max(0.12, unit.y + unit.velocity.y * seconds)),
  };
}

export function laneName(x: number): 'left' | 'center' | 'right' {
  if (x < 0.38) return 'left';
  if (x > 0.62) return 'right';
  return 'center';
}

export function threatenedSide(x: number): 'left' | 'right' {
  return x < ARENA.centerX ? 'left' : 'right';
}

/** The tower a threat at this position is walking toward. */
function defendedTower(x: number): { x: number; y: number } {
  return {
    x: x < ARENA.centerX ? ARENA.leftLaneX : ARENA.rightLaneX,
    y: ARENA.ownPrincessY,
  };
}

/**
 * Candidate defensive placements for a card against a threat.
 *
 * Returns several genuinely different options rather than one fixed point,
 * because the right answer depends on the card and the situation: a building
 * wants to pull the push off its lane, a melee unit wants to meet it head-on,
 * and a ranged unit wants to sit behind the tower and shoot over it.
 */
export function defensivePlacements(threat: ArenaUnit, card: CardInHand, role: string): Placement[] {
  // Meet the threat where it will be by the time our unit is down and walking,
  // not where it is now.
  const intercept = predictPosition(threat, 1.0);
  const tower = defendedTower(threat.x);
  const side = threatenedSide(threat.x);
  const towardCenter = threat.x < ARENA.centerX ? 1 : -1;
  const lane = laneName(threat.x);
  const out: Placement[] = [];

  if (role === 'building_defense') {
    // The classic pull: a few tiles in front of the tower and offset toward the
    // middle, so a tower-targeting unit walks to the building instead and dies
    // in range of both princess towers. Sitting it directly in the lane instead
    // just lets the push walk past.
    out.push(
      place(
        `building 3 tiles in front of the ${side} tower, pulled toward center`,
        tower.x + towardCenter * TILE_X * 2.5,
        tower.y - TILE_Y * 3
      )
    );
    out.push(
      place(
        `building centered between both towers to pull the ${lane} push`,
        ARENA.centerX + towardCenter * TILE_X * 1.5,
        tower.y - TILE_Y * 2.5
      )
    );
    return out;
  }

  if (role === 'support_ranged' || role === 'spell_small') {
    // Ranged units belong behind the tower, shooting over it, where the push
    // cannot reach them first.
    out.push(
      place(
        `${card.name} behind the ${side} tower, shooting over it`,
        tower.x + towardCenter * TILE_X,
        tower.y + TILE_Y * 1.5
      )
    );
  }

  // Head-on intercept, placed a little ahead of the threat so our unit engages
  // before the tower comes into range.
  out.push(
    place(
      `${card.name} intercepting the ${lane} push ahead of the tower`,
      intercept.x,
      Math.min(intercept.y + TILE_Y * 1.5, tower.y - TILE_Y)
    )
  );

  // Kite toward the middle: drags the push away from the tower and into range
  // of the second one.
  out.push(
    place(
      `${card.name} placed toward center to pull the ${lane} push away from the tower`,
      intercept.x + towardCenter * TILE_X * 3,
      intercept.y + TILE_Y
    )
  );

  return out;
}

export interface SpellAim {
  placement: Placement;
  unitsHit: number;
  hitsTower: boolean;
}

/**
 * Finds the best point to drop a spell.
 *
 * Two things the previous version got wrong: it aimed at where units currently
 * were, which misses anything moving because a spell takes about a second to
 * land, and it ignored the enemy tower, which is free chip damage when a spell
 * can cover both. This searches candidate aim points over *predicted* positions
 * and scores them by how many units they cover.
 */
export function spellAim(
  card: CardInHand,
  targets: ArenaUnit[],
  opponentTowers: Array<{ x: number; y: number; standing: boolean }> = []
): SpellAim | null {
  if (targets.length === 0) return null;

  const spell = getSpellProperties(card.key);
  const travel = spell?.travelSeconds ?? 1.0;
  const radiusTiles = spell?.radiusTiles ?? 2.5;

  // A spell's radius is circular in arena tiles, but a tile is a different
  // fraction of the screen on each axis, so the covered region is an ellipse.
  const radiusX = radiusTiles * TILE_X;
  const radiusY = radiusTiles * TILE_Y;

  const predicted = targets.map((t) => predictPosition(t, travel));

  const covers = (ax: number, ay: number, p: { x: number; y: number }) =>
    ((p.x - ax) / radiusX) ** 2 + ((p.y - ay) / radiusY) ** 2 <= 1;

  let best: SpellAim | null = null;

  // Each predicted unit position is a candidate aim point, plus the midpoint of
  // each pair, which is what actually catches two units a spell can just span.
  const candidates: Array<{ x: number; y: number }> = [...predicted];
  for (let i = 0; i < predicted.length; i++) {
    for (let j = i + 1; j < predicted.length; j++) {
      candidates.push({
        x: (predicted[i].x + predicted[j].x) / 2,
        y: (predicted[i].y + predicted[j].y) / 2,
      });
    }
  }

  for (const aim of candidates) {
    const unitsHit = predicted.filter((p) => covers(aim.x, aim.y, p)).length;
    if (unitsHit === 0) continue;

    const hitsTower = opponentTowers.some(
      (tower) => tower.standing && covers(aim.x, aim.y, tower)
    );

    // Prefer covering more units; a tower caught in the blast is a real bonus
    // but never worth giving up a unit for.
    const score = unitsHit * 10 + (hitsTower ? 3 : 0);
    const bestScore = best ? best.unitsHit * 10 + (best.hitsTower ? 3 : 0) : -1;
    if (score > bestScore) {
      best = {
        placement: {
          label:
            `${card.name} on ${unitsHit} unit${unitsHit === 1 ? '' : 's'}` +
            (hitsTower ? ' and the tower' : '') +
            (travel > 0.3 ? `, led ${travel.toFixed(1)}s ahead of their movement` : ''),
          x: aim.x,
          y: aim.y,
        },
        unitsHit,
        hitsTower,
      };
    }
  }

  return best;
}

/**
 * Candidate offensive placements.
 *
 * A push is not one fixed point: dropping a win condition at the bridge is an
 * immediate commitment, while starting it at the back trades tempo for a
 * supported push. Both are offered so the situation decides.
 */
export function offensivePlacements(
  card: CardInHand,
  role: string,
  side: 'left' | 'right',
  elixir: number
): Placement[] {
  const laneX = side === 'left' ? ARENA.leftLaneX : ARENA.rightLaneX;
  // Toward the middle from this lane, used to offset a unit off the lane edge.
  const towardCenter = side === 'left' ? 1 : -1;
  // Toward the lane we are attacking, used to bias back placements to that side.
  const towardSide = side === 'left' ? -1 : 1;
  const out: Placement[] = [];

  if (role === 'win_condition') {
    out.push(place(`${card.name} at the ${side} bridge`, laneX, ARENA.deployTopY));

    // Slightly off the bridge, so it is not the first thing a building pulls.
    out.push(
      place(
        `${card.name} at the ${side} bridge, offset toward center`,
        laneX + towardCenter * TILE_X * 1.5,
        ARENA.deployTopY
      )
    );
    return out;
  }

  // Expensive units are started at the back so elixir regenerates while they
  // walk, letting them reach the bridge with support instead of arriving alone.
  if (card.elixirCost >= 4) {
    out.push(
      place(
        `${card.name} behind the king tower to build a ${side} push`,
        ARENA.centerX + towardSide * TILE_X * 3,
        ARENA.deployBottomY
      )
    );
  }

  // Support placed behind an existing push, not in front of it.
  if (elixir >= 6) {
    out.push(
      place(
        `${card.name} supporting the ${side} lane from behind`,
        laneX + towardCenter * TILE_X,
        ARENA.ownPrincessY - TILE_Y
      )
    );
  }

  return out;
}

/**
 * Where to put a card we are only cycling. Behind the king tower, split away
 * from whichever lane is under pressure, so it is never the reason a push
 * gets through.
 */
export function cyclePlacement(card: CardInHand, safeSide: 'left' | 'right'): Placement {
  const towardSafeSide = safeSide === 'left' ? -1 : 1;
  return place(
    `${card.name} behind the king tower on the ${safeSide} to cycle safely`,
    ARENA.centerX + towardSafeSide * TILE_X * 2,
    ARENA.deployBottomY
  );
}
