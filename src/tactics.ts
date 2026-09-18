import {
  ARENA,
  cyclePlacement,
  defensivePlacements,
  offensivePlacements,
  spellAim,
  threatenedSide,
} from './arena.js';
import { canHitAir, getCardKnowledge, roleOf } from './cards.js';
import type { ArenaUnit, CandidateAction, CardInHand, GameState } from './types.js';

/**
 * Elixir we try to keep in reserve when starting an offensive push, so a
 * counter-attack does not arrive while we are empty. Defending overrides this:
 * an unanswered push costs a tower, which is worse than being low on elixir.
 */
const PUSH_RESERVE = 2.0;

/** Above this, elixir is about to overflow and is being wasted every second. */
const LEAK_THRESHOLD = 9.4;

/** A threat this far into our half is about to connect with a tower. */
const URGENT_THREAT_Y = 0.58;

export interface TacticalAssessment {
  candidates: CandidateAction[];
  /** Set when the situation is clear-cut enough to act without consulting the model. */
  urgent: CandidateAction | null;
  /** Why we are holding, when there is nothing worth playing. */
  holdReason: string | null;
  threatsOnOurSide: ArenaUnit[];
}

export function assess(state: GameState): TacticalAssessment {
  const affordable = state.cardsInHand.filter((c) => c.isPlayable && c.key);
  const threatsOnOurSide = state.threats.filter((t) => t.onOurSide);
  const leaking = state.elixir >= LEAK_THRESHOLD;

  const candidates: CandidateAction[] = [
    ...defensiveCandidates(state, affordable, threatsOnOurSide),
    ...offensiveCandidates(state, affordable, threatsOnOurSide),
    ...cycleCandidates(state, affordable, leaking),
  ];

  candidates.sort((a, b) => b.score - a.score);

  return {
    candidates: candidates.slice(0, 5),
    urgent: findUrgent(candidates, threatsOnOurSide, leaking),
    holdReason: holdReason(state, affordable, threatsOnOurSide),
    threatsOnOurSide,
  };
}

/**
 * A decision is urgent when waiting on a model round-trip would cost us the
 * exchange: a threat is about to hit a tower, or elixir is overflowing.
 */
function findUrgent(
  candidates: CandidateAction[],
  threatsOnOurSide: ArenaUnit[],
  leaking: boolean
): CandidateAction | null {
  const best = candidates[0];
  if (!best) return null;

  const imminent = threatsOnOurSide.some((t) => t.y >= URGENT_THREAT_Y);
  if (imminent && best.kind === 'defend') return best;
  if (leaking) return best;
  return null;
}

function holdReason(
  state: GameState,
  affordable: CardInHand[],
  threatsOnOurSide: ArenaUnit[]
): string | null {
  if (affordable.length === 0) {
    return `no affordable card at ${state.elixir.toFixed(1)} elixir`;
  }
  if (threatsOnOurSide.length === 0 && state.elixir < 6) {
    return `nothing to answer and only ${state.elixir.toFixed(1)} elixir; building up is the better trade`;
  }
  return null;
}

function defensiveCandidates(
  state: GameState,
  affordable: CardInHand[],
  threatsOnOurSide: ArenaUnit[]
): CandidateAction[] {
  if (threatsOnOurSide.length === 0) return [];

  // The deepest threat is the one about to do damage.
  const primary = threatsOnOurSide[0];
  const clustered = threatsOnOurSide.filter(
    (t) => Math.hypot(t.x - primary.x, t.y - primary.y) <= 0.09
  );
  const out: CandidateAction[] = [];

  for (const card of affordable) {
    const role = roleOf(card.key, card.type, card.elixirCost);
    const knowledge = getCardKnowledge(card.key);

    if (card.type === 'Spell') {
      // Aim over predicted positions across every threat, not just the cluster
      // around the deepest one: the best aim point is often a pair a spell can
      // just span, which only shows up when all candidates are considered.
      const aim = spellAim(card, threatsOnOurSide, opponentTowerPoints(state));
      if (!aim) continue;

      // A spell only defends when it hits several units at once; spending a
      // spell on a single unit is a losing elixir trade, and the more expensive
      // the spell the more it has to catch to be worth casting.
      const minimumHits = role === 'spell_big' ? 3 : 2;
      if (aim.unitsHit < minimumHits) continue;

      out.push({
        id: `defend-spell-${card.slot}`,
        card,
        placement: aim.placement,
        score: 55 + aim.unitsHit * 6 + (aim.hitsTower ? 4 : 0) - card.elixirCost * 3,
        kind: 'spell',
        rationale: `${card.name} covers ${aim.unitsHit} enemy units${aim.hitsTower ? ' and chips the tower' : ''} in the ${threatenedSide(primary.x)} lane`,
      });
      continue;
    }

    if (role === 'win_condition' && card.type !== 'Building') {
      // Win conditions mostly ignore defenders or target buildings; they are a
      // poor answer to an incoming push.
      continue;
    }

    let score = 60 - card.elixirCost * 4;
    const reasons: string[] = [];

    if (role === 'building_defense') {
      score += 14;
      reasons.push('a building pulls the push off its lane');
    }
    if (knowledge?.splash) {
      score += 10;
      reasons.push('splash damage covers multiple attackers');
    }
    if (canHitAir(card.key, card.type)) {
      // We can locate units but cannot tell air from ground, so a defender that
      // covers both is strictly safer than one that can whiff entirely.
      score += 12;
      reasons.push('hits air as well as ground, so it cannot whiff');
    }
    if (role === 'tank' || role === 'support_melee') {
      score += 6;
      reasons.push('holds the lane in melee');
    }
    if (role === 'spirit') {
      score -= 6;
      reasons.push('only a tempo trade, not a real answer');
    }

    // Deeper threats need an answer now, so cheap and fast beats perfect.
    if (primary.y >= URGENT_THREAT_Y) score += 10 - card.elixirCost * 2;

    // Each card offers several genuinely different placements, and each becomes
    // its own candidate so the choice of *where* is made on the same footing as
    // the choice of *what*.
    const placements = defensivePlacements(primary, card, role);
    placements.forEach((placement, index) => {
      out.push({
        id: `defend-${card.slot}-${index}`,
        card,
        placement,
        // The first placement is the card's most natural one; later ones are
        // situational alternatives and start slightly behind.
        score: score - index * 2,
        kind: 'defend',
        rationale:
          `${placement.label}` + (reasons.length ? ` (${reasons.join('; ')})` : ''),
      });
    });
  }

  return out;
}

/** Opponent tower positions, for working out when a spell also chips a tower. */
function opponentTowerPoints(state: GameState): Array<{ x: number; y: number; standing: boolean }> {
  return state.towers
    .filter((t) => t.side === 'opponent')
    .map((t) => ({
      x:
        t.position === 'king'
          ? ARENA.centerX
          : t.position === 'left'
            ? ARENA.leftLaneX
            : ARENA.rightLaneX,
      y: t.position === 'king' ? ARENA.opponentKingY : ARENA.opponentPrincessY,
      standing: t.standing,
    }));
}

function offensiveCandidates(
  state: GameState,
  affordable: CardInHand[],
  threatsOnOurSide: ArenaUnit[]
): CandidateAction[] {
  // Never start a push while something is still alive on our side of the river.
  if (threatsOnOurSide.length > 0) return [];

  const out: CandidateAction[] = [];
  const target = weakestOpponentSide(state);

  for (const card of affordable) {
    const role = roleOf(card.key, card.type, card.elixirCost);
    const remaining = state.elixir - card.elixirCost;

    // A spell is worth throwing offensively when it catches units clumped
    // behind the opponent's tower, or chips a tower that is nearly down.
    if (card.type === 'Spell') {
      const aim = spellAim(card, state.threats, opponentTowerPoints(state));
      if (aim && (aim.unitsHit >= 3 || (aim.hitsTower && aim.unitsHit >= 2))) {
        out.push({
          id: `push-spell-${card.slot}`,
          card,
          placement: aim.placement,
          score: 44 + aim.unitsHit * 5 + (aim.hitsTower ? 6 : 0) - card.elixirCost * 3,
          kind: 'spell',
          rationale: aim.placement.label,
        });
      }
      continue;
    }

    if (role === 'win_condition') {
      if (remaining < PUSH_RESERVE && !state.doubleElixir) continue;

      let score = 50 + remaining * 2;
      if (target.destroyed) score += 20;
      else if (target.damaged) score += 10;
      if (state.doubleElixir) score += 8;

      const context = target.destroyed
        ? ' where the tower is already down'
        : target.damaged
          ? ' against the more damaged tower'
          : '';

      offensivePlacements(card, role, target.side, state.elixir).forEach((placement, index) => {
        out.push({
          id: `push-${card.slot}-${index}`,
          card,
          placement,
          score: score - index * 3,
          kind: 'push',
          rationale: `${placement.label}${context}, leaving ${remaining.toFixed(1)} elixir in reserve`,
        });
      });
      continue;
    }

    // With a clear board and elixir to spare, a support unit is worth putting
    // down to start building pressure, rather than sitting on elixir until it
    // overflows. Started at the back so it arrives at the bridge supported.
    const canOpen = role === 'tank' || role === 'support_ranged' || role === 'support_melee';
    if (canOpen && card.elixirCost >= 4 && state.elixir >= 8) {
      offensivePlacements(card, role, target.side, state.elixir).forEach((placement, index) => {
        out.push({
          id: `build-${card.slot}-${index}`,
          card,
          placement,
          score: 40 + state.elixir - index * 3,
          kind: 'push',
          rationale: placement.label,
        });
      });
    }
  }

  return out;
}

/**
 * Cycling a cheap card is only worth it to avoid wasting elixir at the cap, or
 * to get back to a key card sooner. It is placed at the back where it is safe.
 */
function cycleCandidates(
  state: GameState,
  affordable: CardInHand[],
  leaking: boolean
): CandidateAction[] {
  if (!leaking) return [];

  const cheapest = [...affordable].sort((a, b) => a.elixirCost - b.elixirCost)[0];
  if (!cheapest) return [];

  // Cycle away from whichever lane is under pressure, so the cycled card is
  // never the reason a push gets through.
  const pressured = state.threats.filter((t) => t.onOurSide);
  const safeSide: 'left' | 'right' = pressured.length
    ? threatenedSide(pressured[0].x) === 'left'
      ? 'right'
      : 'left'
    : weakestOpponentSide(state).side;

  return [
    {
      id: `cycle-${cheapest.slot}`,
      card: cheapest,
      placement: cyclePlacement(cheapest, safeSide),
      score: 45,
      kind: 'cycle',
      rationale: `at ${state.elixir.toFixed(1)} elixir we are overflowing and wasting regeneration; cycling ${cheapest.name} is cheaper than leaking`,
    },
  ];
}

/** The opponent side worth attacking: a destroyed or damaged tower first. */
function weakestOpponentSide(state: GameState): {
  side: 'left' | 'right';
  damaged: boolean;
  destroyed: boolean;
} {
  const left = state.towers.find((t) => t.side === 'opponent' && t.position === 'left');
  const right = state.towers.find((t) => t.side === 'opponent' && t.position === 'right');

  if (left && !left.standing) return { side: 'left', damaged: true, destroyed: true };
  if (right && !right.standing) return { side: 'right', damaged: true, destroyed: true };

  const leftHp = left?.hp;
  const rightHp = right?.hp;
  if (leftHp !== undefined && rightHp !== undefined && leftHp !== rightHp) {
    return leftHp < rightHp
      ? { side: 'left', damaged: true, destroyed: false }
      : { side: 'right', damaged: true, destroyed: false };
  }

  // No information yet: commit to the side our own units are already on, so a
  // push builds on a counter-attack instead of splitting our pressure.
  const ourUnits = state.ownUnits.filter((u) => u.y < ARENA.ownPrincessY);
  if (ourUnits.length > 0) {
    const avg = ourUnits.reduce((s, u) => s + u.x, 0) / ourUnits.length;
    return { side: avg < ARENA.centerX ? 'left' : 'right', damaged: false, destroyed: false };
  }
  return { side: 'right', damaged: false, destroyed: false };
}
