import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { DeckTracker } from './deck.js';
import type { GameState, MatchPhase, TroopUnit } from './types.js';

const execFileAsync = promisify(execFile);
const HELPER_PATH = resolve(process.cwd(), 'bin/helper');

interface OcrTextItem {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface OcrResult {
  rawTexts: OcrTextItem[];
  detectedElixir?: number | null;
  detectedPhase?: string | null;
  towerNumbers: number[];
}

export interface PerceiveOptions {
  provider?: 'local' | 'anthropic';
  anthropicApiKey?: string;
  visionModel?: string;
  deckTracker?: DeckTracker;
}

/**
 * Local Native Vision Perceiver using macOS built-in Apple Vision framework.
 * Requires ZERO external API keys. Runs 100% on-device.
 */
export async function perceiveGameStateLocally(
  imagePath: string,
  deckTracker: DeckTracker
): Promise<GameState> {
  const { stdout } = await execFileAsync(HELPER_PATH, ['ocr', imagePath]);
  const ocrData: OcrResult = JSON.parse(stdout.trim());

  let phase: MatchPhase = 'in-progress';
  if (ocrData.detectedPhase) {
    phase = ocrData.detectedPhase as MatchPhase;
  }

  // Determine elixir (defaults to 6.0 if not directly OCR'd)
  const elixir = ocrData.detectedElixir ?? 6.0;

  // Read cards in hand from deck cycle tracker
  const handCards = deckTracker.getHand().map((card, idx) => ({
    slot: (idx + 1) as 1 | 2 | 3 | 4,
    name: card.name,
    elixirCost: card.elixirCost,
    isPlayable: elixir >= card.elixirCost,
  }));

  const nextCard = deckTracker.getNextCard();

  // Detect potential threats in arena from OCR items in the middle battlefield
  const opponentTroops: TroopUnit[] = [];
  for (const item of ocrData.rawTexts) {
    // In middle battlefield (y between 0.35 and 0.70)
    if (item.y > 0.35 && item.y < 0.70) {
      const lane = item.x < 0.45 ? 'left' : item.x > 0.55 ? 'right' : 'center';
      // If recognized text has high confidence or looks like a troop or level number
      if (item.confidence > 0.7) {
        opponentTroops.push({
          type: item.text.replace(/[^a-zA-Z0-9 ]/g, '').trim() || 'Enemy Troop',
          owner: 'opponent',
          lane,
          approxHpPercent: 80,
          position: { xPercent: item.x, yPercent: item.y },
        });
      }
    }
  }

  return {
    matchPhase: phase,
    elixir,
    cardsInHand: handCards,
    nextCard: nextCard.name,
    opponentTroops: opponentTroops.slice(0, 3),
    ownTroops: [],
    ownTowers: {
      leftPrincessHpPercent: 100,
      rightPrincessHpPercent: 100,
      kingHpPercent: 100,
      leftPrincessStanding: true,
      rightPrincessStanding: true,
      kingStanding: true,
    },
    opponentTowers: {
      leftPrincessHpPercent: 100,
      rightPrincessHpPercent: 100,
      kingHpPercent: 100,
      leftPrincessStanding: true,
      rightPrincessStanding: true,
      kingStanding: true,
    },
    rawSummary: `Local Apple Vision perception: Phase=${phase}, Elixir=${elixir}, Threats=${opponentTroops.length}`,
  };
}

/**
 * Cloud Vision Perceiver using Anthropic Claude API (optional).
 */
export async function perceiveGameStateWithClaude(
  imageBase64: string,
  apiKey: string,
  model = 'claude-3-5-sonnet-20241022'
): Promise<GameState> {
  const anthropic = new Anthropic({ apiKey });

  const systemPrompt = `You are a real-time Clash Royale game state perceiver.
Analyze the provided screenshot of the Clash Royale match running in iPhone Mirroring.
Output ONLY valid, raw JSON (no conversational text, no backticks).
Schema:
{
  "matchPhase": "pre-game" | "in-progress" | "overtime" | "post-game" | "menu",
  "elixir": number (0-10),
  "cardsInHand": [{ "slot": 1|2|3|4, "name": string, "elixirCost": number, "isPlayable": boolean }],
  "nextCard": string | null,
  "opponentTroops": [{ "type": string, "lane": "left"|"right"|"center", "approxHpPercent": number }],
  "ownTroops": [{ "type": string, "lane": "left"|"right"|"center", "approxHpPercent": number }],
  "ownTowers": { "leftPrincessHpPercent": number, "rightPrincessHpPercent": number, "kingHpPercent": number },
  "opponentTowers": { "leftPrincessHpPercent": number, "rightPrincessHpPercent": number, "kingHpPercent": number },
  "rawSummary": string
}`;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    temperature: 0.1,
    system: systemPrompt,
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
            text: 'Extract current Clash Royale game state as JSON.',
          },
        ],
      },
    ],
  });

  const rawText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('')
    .trim();

  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  return JSON.parse(cleaned) as GameState;
}

/**
 * Universal perceiver: automatically selects local Apple Vision when no Anthropic key is set!
 */
export async function perceiveGameState(
  imagePath: string,
  imageBase64: string,
  options: PerceiveOptions = {}
): Promise<GameState> {
  const provider =
    options.provider ||
    (process.env.VISION_PROVIDER as 'local' | 'anthropic') ||
    (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'local');

  if (provider === 'anthropic' && (options.anthropicApiKey || process.env.ANTHROPIC_API_KEY)) {
    const key = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY!;
    return perceiveGameStateWithClaude(imageBase64, key, options.visionModel);
  }

  // Default: Local on-device Apple Vision (Zero Keys Required!)
  const tracker = options.deckTracker || new DeckTracker();
  return perceiveGameStateLocally(imagePath, tracker);
}
