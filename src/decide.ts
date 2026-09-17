import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';
import { findBestKnownCounter, getCardKnowledge } from './cards.js';
import type { GameState, JevDecision, PlacementLane } from './types.js';

export interface DecideOptions {
  apiKey?: string;
  minPlayProbability?: number;
  useFallbackHeuristicOnFailure?: boolean;
}

/**
 * Invokes TypeSafe Jev (System One) with a single batched multi-question call.
 */
export async function decideMove(
  gameState: GameState,
  options: DecideOptions = {}
): Promise<JevDecision> {
  const apiKey = options.apiKey || process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error('TYPESAFE_API_KEY is not configured in environment or .env');
  }

  // Deterministic game knowledge (roles, targeting, known counters) is computed
  // in code and handed to Jev as facts — Jev only judges what to do with them.
  const opponentTroopNames = gameState.opponentTroops.map((t) => t.type);
  const bestKnownCounter = findBestKnownCounter(
    gameState.cardsInHand.map((c) => c.name),
    opponentTroopNames
  );

  const describeCard = (slot: number): string => {
    const card = gameState.cardsInHand.find((c) => c.slot === slot);
    if (!card) return `Empty slot ${slot}`;
    const kb = getCardKnowledge(card.name);
    const cost = card.elixirCost ?? '?';
    const affordable = card.isPlayable ?? (card.elixirCost !== undefined && gameState.elixir >= card.elixirCost);
    const bits = [`${card.name} (${cost} elixir${affordable ? '' : ', NOT enough elixir yet'})`];
    if (kb) {
      bits.push(`role: ${kb.role}, targets: ${kb.targets}`);
      if (kb.countersWell.length) bits.push(`good vs: ${kb.countersWell.join(', ')}`);
      if (kb.vulnerableTo.length) bits.push(`weak vs: ${kb.vulnerableTo.join(', ')}`);
      if (kb.notes) bits.push(kb.notes);
    }
    if (bestKnownCounter?.card === card.name) {
      bits.push(`KNOWN GOOD COUNTER to opponent's ${bestKnownCounter.counters} on the field right now`);
    }
    return bits.join('; ');
  };

  const cardChoices: Record<string, string> = {
    slot1: `Play Slot 1: ${describeCard(1)}`,
    slot2: `Play Slot 2: ${describeCard(2)}`,
    slot3: `Play Slot 3: ${describeCard(3)}`,
    slot4: `Play Slot 4: ${describeCard(4)}`,
    none: 'Hold cards and save elixir: no card is a good positive-elixir-trade or defensive answer right now',
  };

  const laneChoices: Record<string, string> = {
    left_bridge: 'Offensive push at the left bridge',
    right_bridge: 'Offensive push at the right bridge',
    defensive_left: 'Defensive placement in front of our left princess tower',
    defensive_right: 'Defensive placement in front of our right princess tower',
    defensive_center: 'Defensive center pull between our two princess towers',
    back_cycle_left: 'Safe cycle card behind the king tower on the left',
    back_cycle_right: 'Safe cycle card behind the king tower on the right',
  };

  const client = new TypeSafeClient({ apiKey });

  try {
    const response = await client.systemOne({
      state: JSON.parse(
        JSON.stringify({
          game: 'Clash Royale',
          matchPhase: gameState.matchPhase,
          elixir: gameState.elixir,
          cardsInHand: gameState.cardsInHand.map((c) => {
            const kb = getCardKnowledge(c.name);
            return {
              slot: c.slot,
              name: c.name,
              elixirCost: c.elixirCost ?? null,
              isPlayable: c.isPlayable ?? gameState.elixir >= (c.elixirCost ?? 3),
              role: kb?.role ?? 'unknown',
              targets: kb?.targets ?? 'unknown',
              countersWell: kb?.countersWell ?? [],
              vulnerableTo: kb?.vulnerableTo ?? [],
            };
          }),
          nextCard: gameState.nextCard ?? null,
          opponentTroops: gameState.opponentTroops.map((t) => ({
            ...t,
            knownRole: getCardKnowledge(t.type)?.role ?? 'unknown',
          })),
          ownTroops: gameState.ownTroops,
          ownTowers: gameState.ownTowers,
          opponentTowers: gameState.opponentTowers,
          timeRemainingSeconds: gameState.timeRemainingSeconds ?? null,
          situationSummary: gameState.rawSummary || '',
          bestKnownCounter: bestKnownCounter ?? null,
          handTrackingConfidence: gameState.handTrackingConfidence ?? 'high',
          strategyPolicy: [
            gameState.handTrackingConfidence === 'low'
              ? 'handTrackingConfidence is LOW this tick: the reported cardsInHand may not match what is really on screen (a rotation-tracking desync was detected from the elixir trend). Prefer holding elixir or only playing a card you are still fairly confident about, rather than committing to an aggressive plan built on cardsInHand.'
              : 'handTrackingConfidence is high: cardsInHand can be trusted normally.',
            'Opponent/own troops of type "Unidentified activity" mean real on-screen motion was detected in that lane but the exact unit could not be identified (no card art recognition) — treat it as "something is happening there", not a specific known matchup. Do not assume it matches any specific countersWell/vulnerableTo entry unless bestKnownCounter says so.',
            'Defend before you push: if opponent activity is reported on our side of the river, prioritize a positive-elixir-trade defensive answer over starting a new offensive push.',
            'A card is a good defensive answer when its role/targeting beats the threat cheaply (see each card\'s countersWell / vulnerableTo and the opponent troop\'s knownRole) — prefer that over a generic tanky unit.',
            'Do not place swarm cards (role swarm/spirit) directly on top of a threat that has splash damage (e.g. wizard, valkyrie, bomber, baby dragon) — they will trade badly.',
            'Air troops (targets air, e.g. minions, bats, balloon, lava hound) can only be answered by cards that target air or both — a ground-only melee card will not reach them.',
            'Save big spells (spell_big) for grouped/clumped units or high elixir-value targets, not lone tanks with low value.',
            'If elixir is at or near the 10 cap, play something now even if imperfect — leaking elixir at the cap is a worse trade than almost any card.',
            'If no opponent threat is present and elixir is high, a win_condition or bridge push in cardsInHand is a good use of that elixir rather than holding.',
          ],
        })
      ),
      questions: {
        shouldPlayNow: noul(
          'Is now an appropriate moment to spend elixir and play a card, given elixir count, opponent threats on our side of the river, and the strategyPolicy rules in state?',
          {
            true: 'Spend elixir now: countering an incoming threat per the counter/role data, launching a push when no threat exists, or cycling to avoid leaking elixir at 10',
            false: 'Wait and save elixir: no urgent threat and no efficient play available yet',
          }
        ),
        whichCard: choice(
          'Which card should be played right now, applying the role/countersWell/vulnerableTo data and strategyPolicy in state to pick the best elixir trade or push?',
          cardChoices
        ),
        whichLane: choice(
          'Where on the arena battlefield should this card be placed, given opponentTroops positions and whether this is a defensive answer or an offensive push?',
          laneChoices
        ),
      },
    });

    const shouldPlayAns = response.answers.shouldPlayNow;
    const whichCardAns = response.answers.whichCard;
    const whichLaneAns = response.answers.whichLane;

    const prob = shouldPlayAns.noul;
    const minThreshold = options.minPlayProbability ?? 0.55;
    // If elixir is 10 (or >= 9.5), we must play to prevent leaking elixir
    const mustPlayToPreventLeak = gameState.elixir >= 9.5;
    const shouldPlay = (prob >= minThreshold || mustPlayToPreventLeak) && whichCardAns.choice !== 'none';

    return {
      shouldPlayNow: shouldPlay,
      shouldPlayProbability: prob,
      whichCard: whichCardAns.choice as JevDecision['whichCard'],
      cardConfidence: whichCardAns.confidence,
      whichLane: whichLaneAns.choice as PlacementLane,
      laneConfidence: whichLaneAns.confidence,
      explanation: `Jev decided: play=${shouldPlay} (p=${prob.toFixed(2)}), card=${whichCardAns.choice} (${whichCardAns.confidence.toFixed(2)} conf), lane=${whichLaneAns.choice}`,
    };
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.warn(`[decide] TypeSafe API call returned error: ${errorMsg}`);

    if (options.useFallbackHeuristicOnFailure ?? true) {
      console.log('[decide] Using tactical fallback heuristic...');
      return fallbackHeuristic(gameState);
    }
    throw err;
  }
}

/**
 * Tactical fallback heuristic if the external model is temporarily unavailable.
 */
function fallbackHeuristic(gameState: GameState): JevDecision {
  const hasThreat = gameState.opponentTroops.length > 0;
  const highElixir = gameState.elixir >= 7.0;
  const emergencyElixir = gameState.elixir >= 9.5;

  if (hasThreat || highElixir || emergencyElixir) {
    const playableCards = gameState.cardsInHand.filter(
      (c) => c.elixirCost === undefined || c.elixirCost <= gameState.elixir
    );

    const knownCounter = hasThreat
      ? findBestKnownCounter(
          playableCards.map((c) => c.name),
          gameState.opponentTroops.map((t) => t.type)
        )
      : null;

    const chosenCard =
      (knownCounter && playableCards.find((c) => c.name === knownCounter.card)) ||
      (playableCards.length > 0 ? playableCards[0] : gameState.cardsInHand[0]);
    const slotKey = chosenCard ? (`slot${chosenCard.slot}` as JevDecision['whichCard']) : 'none';

    let targetLane: PlacementLane = 'defensive_center';
    if (hasThreat) {
      const threat = gameState.opponentTroops[0];
      targetLane = threat.lane === 'left' ? 'defensive_left' : 'defensive_right';
    } else if (highElixir) {
      targetLane = 'left_bridge';
    }

    return {
      shouldPlayNow: slotKey !== 'none',
      shouldPlayProbability: 0.8,
      whichCard: slotKey,
      cardConfidence: 0.7,
      whichLane: targetLane,
      laneConfidence: 0.7,
      explanation: `Fallback rule: Threat=${hasThreat}, Elixir=${gameState.elixir}. Playing ${slotKey} at ${targetLane}`,
    };
  }

  return {
    shouldPlayNow: false,
    shouldPlayProbability: 0.2,
    whichCard: 'none',
    cardConfidence: 0.8,
    whichLane: 'defensive_center',
    laneConfidence: 0.5,
    explanation: `Fallback rule: Saving elixir (currently ${gameState.elixir}).`,
  };
}
