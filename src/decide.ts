import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';
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

  // Find cards in hand
  const slot1 = gameState.cardsInHand.find((c) => c.slot === 1)?.name || 'Empty slot 1';
  const slot2 = gameState.cardsInHand.find((c) => c.slot === 2)?.name || 'Empty slot 2';
  const slot3 = gameState.cardsInHand.find((c) => c.slot === 3)?.name || 'Empty slot 3';
  const slot4 = gameState.cardsInHand.find((c) => c.slot === 4)?.name || 'Empty slot 4';

  const cardChoices: Record<string, string> = {
    slot1: `Play Slot 1: ${slot1}`,
    slot2: `Play Slot 2: ${slot2}`,
    slot3: `Play Slot 3: ${slot3}`,
    slot4: `Play Slot 4: ${slot4}`,
    none: 'Hold cards and save elixir',
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
          cardsInHand: gameState.cardsInHand.map((c) => ({
            slot: c.slot,
            name: c.name,
            elixirCost: c.elixirCost ?? null,
            isPlayable: c.isPlayable ?? gameState.elixir >= (c.elixirCost ?? 3),
          })),
          nextCard: gameState.nextCard ?? null,
          opponentTroops: gameState.opponentTroops,
          ownTroops: gameState.ownTroops,
          ownTowers: gameState.ownTowers,
          opponentTowers: gameState.opponentTowers,
          timeRemainingSeconds: gameState.timeRemainingSeconds ?? null,
          situationSummary: gameState.rawSummary || '',
        })
      ),
      questions: {
        shouldPlayNow: noul(
          'Is now an appropriate moment to spend elixir and play a card, given our elixir count, opponent threats, or if we are near the 10 elixir cap?',
          {
            true: 'Spend elixir now: either countering an incoming threat, launching a push, or cycling to avoid leaking elixir at 10',
            false: 'Wait and save elixir: no urgent threat, or we need to build more elixir',
          }
        ),
        whichCard: choice(
          'Which card should be played right now to maximize tactical value?',
          cardChoices
        ),
        whichLane: choice(
          'Where on the arena battlefield should this card be placed?',
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

    const chosenCard = playableCards.length > 0 ? playableCards[0] : gameState.cardsInHand[0];
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
