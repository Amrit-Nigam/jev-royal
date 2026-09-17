import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
  provider?: 'local' | 'anthropic' | 'openai';
  anthropicApiKey?: string;
  openAiApiKey?: string;
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
    if (item.y > 0.35 && item.y < 0.70) {
      const lane = item.x < 0.45 ? 'left' : item.x > 0.55 ? 'right' : 'center';
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
 * Cloud Vision Perceiver using OpenAI GPT-4o / GPT-4o-mini API (optional).
 */
export async function perceiveGameStateWithOpenAI(
  imageBase64: string,
  apiKey: string,
  model = 'gpt-4o-mini'
): Promise<GameState> {
  const openai = new OpenAI({ apiKey });

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

  const response = await openai.chat.completions.create({
    model,
    max_tokens: 1024,
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${imageBase64}`,
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

  const rawText = response.choices[0]?.message?.content || '';
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  return JSON.parse(cleaned) as GameState;
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
 * Universal perceiver: supports OpenAI, Claude, and local on-device Apple Vision.
 * Automatically falls back to local vision if quota or network errors occur.
 */
export async function perceiveGameState(
  imagePath: string,
  imageBase64: string,
  options: PerceiveOptions = {}
): Promise<GameState> {
  const provider =
    options.provider ||
    (process.env.VISION_PROVIDER as 'local' | 'anthropic' | 'openai') ||
    (process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'local');

  const tracker = options.deckTracker || new DeckTracker();

  // 1. OpenAI Vision
  if (provider === 'openai' && (options.openAiApiKey || process.env.OPENAI_API_KEY)) {
    const key = options.openAiApiKey || process.env.OPENAI_API_KEY!;
    try {
      return await perceiveGameStateWithOpenAI(imageBase64, key, options.visionModel || 'gpt-4o-mini');
    } catch (err) {
      console.warn(
        `[perceive:openai] OpenAI vision call failed (${(err as Error).message}). Falling back to local Apple Vision.`
      );
      return perceiveGameStateLocally(imagePath, tracker);
    }
  }

  // 2. Anthropic Claude Vision
  if (provider === 'anthropic' && (options.anthropicApiKey || process.env.ANTHROPIC_API_KEY)) {
    const key = options.anthropicApiKey || process.env.ANTHROPIC_API_KEY!;
    try {
      return await perceiveGameStateWithClaude(imageBase64, key, options.visionModel);
    } catch (err) {
      console.warn(
        `[perceive:anthropic] Anthropic vision call failed (${(err as Error).message}). Falling back to local Apple Vision.`
      );
      return perceiveGameStateLocally(imagePath, tracker);
    }
  }

  // 3. Default: Local on-device Apple Vision (Zero Keys Required!)
  return perceiveGameStateLocally(imagePath, tracker);
}
