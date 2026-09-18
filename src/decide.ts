import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk';
import { getCardKnowledge, roleOf } from './cards.js';
import { assess } from './tactics.js';
import type { CandidateAction, GameState, JevDecision } from './types.js';

export interface DecideOptions {
  apiKey?: string;
  minPlayProbability?: number;
  /** Skip the model entirely and play purely from local tactics. */
  localOnly?: boolean;
}

/**
 * Decides what to play.
 *
 * Candidate generation, placement and elixir discipline are computed locally in
 * tactics.ts, because they are deterministic Clash Royale rules rather than
 * judgment calls. The model is consulted only to arbitrate between concrete
 * candidates the tactics layer has already validated, and is skipped entirely
 * when the situation is urgent, since a network round-trip during a push costs
 * the exchange.
 */
export async function decideMove(
  state: GameState,
  options: DecideOptions = {}
): Promise<JevDecision> {
  const assessment = assess(state);

  if (assessment.candidates.length === 0) {
    return {
      shouldPlayNow: false,
      shouldPlayProbability: 0.1,
      action: null,
      confidence: 0.9,
      source: 'hold',
      explanation: assessment.holdReason ?? 'no playable candidate this tick',
      candidates: [],
    };
  }

  if (assessment.urgent) {
    return {
      shouldPlayNow: true,
      shouldPlayProbability: 0.95,
      action: assessment.urgent,
      confidence: 0.9,
      source: 'tactics-urgent',
      explanation: `acting immediately without a model round-trip: ${assessment.urgent.rationale}`,
      candidates: assessment.candidates,
    };
  }

  const apiKey = options.apiKey || process.env.TYPESAFE_API_KEY;
  if (options.localOnly || !apiKey) {
    return localDecision(assessment.candidates, assessment.holdReason, state);
  }

  try {
    return await askJev(state, assessment.candidates, apiKey, options);
  } catch (err) {
    console.warn(`[decide] model call failed (${(err as Error).message}); using local tactics`);
    return localDecision(assessment.candidates, assessment.holdReason, state);
  }
}

function localDecision(
  candidates: CandidateAction[],
  holdReason: string | null,
  state: GameState
): JevDecision {
  const best = candidates[0];
  const worthPlaying = best.score >= 45 || state.elixir >= 9.4;

  if (!worthPlaying) {
    return {
      shouldPlayNow: false,
      shouldPlayProbability: 0.3,
      action: null,
      confidence: 0.6,
      source: 'hold',
      explanation: holdReason ?? `best option (${best.rationale}) is not worth the elixir yet`,
      candidates,
    };
  }

  return {
    shouldPlayNow: true,
    shouldPlayProbability: 0.8,
    action: best,
    confidence: 0.7,
    source: 'tactics-fallback',
    explanation: best.rationale,
    candidates,
  };
}

async function askJev(
  state: GameState,
  candidates: CandidateAction[],
  apiKey: string,
  options: DecideOptions
): Promise<JevDecision> {
  const client = new TypeSafeClient({ apiKey });

  const optionDescriptions: Record<string, string> = {};
  for (const candidate of candidates) {
    optionDescriptions[candidate.id] =
      `${candidate.card.name} (${candidate.card.elixirCost} elixir, ` +
      `${roleOf(candidate.card.key, candidate.card.type, candidate.card.elixirCost)}) ` +
      `placed at ${candidate.placement.label} - ${candidate.rationale}`;
  }

  const response = await client.systemOne({
    state: JSON.parse(
      JSON.stringify({
        game: 'Clash Royale',
        elixir: Number(state.elixir.toFixed(1)),
        doubleElixir: state.doubleElixir,
        timeRemainingSeconds: state.timeRemainingSeconds ?? null,
        hand: state.cardsInHand.map((c) => {
          const knowledge = getCardKnowledge(c.key);
          return {
            name: c.name,
            elixir: c.elixirCost,
            role: roleOf(c.key, c.type, c.elixirCost),
            targets: knowledge?.targets ?? 'unknown',
            playableNow: c.isPlayable,
          };
        }),
        nextCard: state.nextCard ?? null,
        enemyUnitsOnOurSide: state.threats
          .filter((t) => t.onOurSide)
          .map((t) => ({ x: Number(t.x.toFixed(2)), y: Number(t.y.toFixed(2)) })),
        enemyUnitsTotal: state.threats.length,
        ourUnitsInPlay: state.ownUnits.length,
        towers: state.towers.map((t) => ({
          side: t.side,
          position: t.position,
          hp: t.hp ?? null,
          standing: t.standing,
        })),
        perceptionLimits: [
          'Unit positions and ownership are real, read off on-screen health bars and frame motion.',
          'Unit *identities* are unknown: nothing on screen says which card an enemy unit is. Do not assume a specific matchup.',
          'Because enemy units could be air or ground, a defender that hits both is safer than one that can whiff entirely.',
        ],
        strategyPolicy: [
          'Every option listed has already been checked for affordability, legal placement and basic soundness. Choose between them; do not invent a different play.',
          'Defending an active push beats starting a new one: a tower lost costs far more than elixir held.',
          'Prefer the option that wins the elixir trade. Spending 5 elixir to stop a 3-elixir unit loses the exchange even when the defence works.',
          'Holding elixir is correct when nothing threatens us and no option creates real pressure, but elixir at the cap is wasted every second.',
          'In double elixir, committing harder is correct because both sides cycle faster.',
        ],
      })
    ),
    questions: {
      shouldPlayNow: noul(
        'Should we spend elixir on a card right now, rather than holding and letting elixir build?',
        {
          true: 'Play now: there is a threat to answer, or a genuinely good opportunity to apply pressure',
          false: 'Hold: nothing needs answering and no option is worth the elixir yet',
        }
      ),
      bestOption: choice(
        'Which of these specific plays is the best use of elixir right now?',
        optionDescriptions
      ),
    },
  });

  const probability = response.answers.shouldPlayNow.noul;
  const chosenId = response.answers.bestOption.choice;
  const confidence = response.answers.bestOption.confidence;

  const chosen = candidates.find((c) => c.id === chosenId) ?? candidates[0];
  const threshold = options.minPlayProbability ?? 0.55;
  // Elixir at the cap is being actively wasted, so play regardless of the model's
  // preference for holding.
  const mustPlay = state.elixir >= 9.4;
  const shouldPlay = probability >= threshold || mustPlay;

  return {
    shouldPlayNow: shouldPlay,
    shouldPlayProbability: probability,
    action: shouldPlay ? chosen : null,
    confidence,
    source: 'jev',
    explanation: shouldPlay
      ? `${chosen.rationale} (p=${probability.toFixed(2)}, confidence=${confidence.toFixed(2)})`
      : `holding elixir (p=${probability.toFixed(2)})`,
    candidates,
  };
}
