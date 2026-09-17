import Anthropic from '@anthropic-ai/sdk';
import type { GameState, MatchPhase } from './types.js';

const SYSTEM_PROMPT = `You are a real-time Clash Royale game state perceiver.
Analyze the provided screenshot of the Clash Royale match running in the iPhone Mirroring window.
You must output ONLY valid, raw JSON (no conversational text, no markdown backticks, just pure JSON).

Schema:
{
  "matchPhase": "pre-game" | "in-progress" | "overtime" | "post-game" | "menu",
  "elixir": number (0 to 10, may have decimals e.g. 5.5),
  "cardsInHand": [
    {
      "slot": 1 | 2 | 3 | 4,
      "name": string (e.g. "Hog Rider", "Fireball", "Knight"),
      "elixirCost": number,
      "isPlayable": boolean
    }
  ],
  "nextCard": string | null,
  "opponentTroops": [
    {
      "type": string (e.g. "Giant", "Baby Dragon", "P.E.K.K.A"),
      "lane": "left" | "right" | "center",
      "approxHpPercent": number (0 to 100)
    }
  ],
  "ownTroops": [
    {
      "type": string,
      "lane": "left" | "right" | "center",
      "approxHpPercent": number (0 to 100)
    }
  ],
  "ownTowers": {
    "leftPrincessHpPercent": number,
    "rightPrincessHpPercent": number,
    "kingHpPercent": number,
    "leftPrincessStanding": boolean,
    "rightPrincessStanding": boolean,
    "kingStanding": boolean
  },
  "opponentTowers": {
    "leftPrincessHpPercent": number,
    "rightPrincessHpPercent": number,
    "kingHpPercent": number,
    "leftPrincessStanding": boolean,
    "rightPrincessStanding": boolean,
    "kingStanding": boolean
  },
  "timeRemainingSeconds": number | null,
  "rawSummary": string (1-2 sentence overview of the battlefield)
}

Guidelines:
1. matchPhase:
   - "in-progress": normal battle is currently active.
   - "overtime": sudden death overtime active.
   - "pre-game": loading screen, battle intro, "VS" banner, or starting elixir fill.
   - "post-game": battle end, "Victory", "Defeat", crown tally, or match results screen.
   - "menu": home deck screen, shop, clan tab, or not currently in a match.
2. cardsInHand: slots 1 to 4 from left to right in the bottom active bar. The far left smaller card preview is "nextCard".
3. Elixir: read the elixir number at the bottom bar (pink bar from 0 to 10).
4. If you cannot see a card name clearly, provide your best guess based on the card art and elixir icon.`;

export interface PerceiveOptions {
  apiKey?: string;
  model?: string;
}

export async function perceiveGameState(
  imageBase64: string,
  options: PerceiveOptions = {}
): Promise<GameState> {
  const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set in environment or .env. Please set ANTHROPIC_API_KEY to enable vision perception.'
    );
  }

  const anthropic = new Anthropic({ apiKey });
  const model = options.model || process.env.VISION_MODEL || 'claude-3-5-sonnet-20241022';

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    temperature: 0.1,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: 'Extract the current Clash Royale game state as JSON.',
          },
        ],
      },
    ],
  });

  const rawText =
    response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('')
      .trim();

  return parseGameStateJson(rawText);
}

/**
 * Robust JSON extraction handling optional markdown fences.
 */
export function parseGameStateJson(raw: string): GameState {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  try {
    const parsed = JSON.parse(cleaned);

    // Normalize defaults
    const state: GameState = {
      matchPhase: (parsed.matchPhase as MatchPhase) || 'in-progress',
      elixir: typeof parsed.elixir === 'number' ? parsed.elixir : 5,
      cardsInHand: Array.isArray(parsed.cardsInHand) ? parsed.cardsInHand : [],
      nextCard: parsed.nextCard || undefined,
      opponentTroops: Array.isArray(parsed.opponentTroops) ? parsed.opponentTroops : [],
      ownTroops: Array.isArray(parsed.ownTroops) ? parsed.ownTroops : [],
      ownTowers: parsed.ownTowers || {
        leftPrincessHpPercent: 100,
        rightPrincessHpPercent: 100,
        kingHpPercent: 100,
        leftPrincessStanding: true,
        rightPrincessStanding: true,
        kingStanding: true,
      },
      opponentTowers: parsed.opponentTowers || {
        leftPrincessHpPercent: 100,
        rightPrincessHpPercent: 100,
        kingHpPercent: 100,
        leftPrincessStanding: true,
        rightPrincessStanding: true,
        kingStanding: true,
      },
      timeRemainingSeconds: parsed.timeRemainingSeconds ?? undefined,
      rawSummary: parsed.rawSummary || '',
    };

    return state;
  } catch (err) {
    throw new Error(
      `Failed to parse vision model response as JSON: ${(err as Error).message}\nRaw response:\n${raw}`
    );
  }
}
