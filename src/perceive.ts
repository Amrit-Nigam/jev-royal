import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { DeckTracker } from './deck.js';
import type { GameState, MatchPhase, TowerStatus, TroopUnit } from './types.js';

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

interface TowerNumber {
  value: number;
  x: number;
  y: number;
}

interface OcrResult {
  rawTexts: OcrTextItem[];
  detectedElixir?: number | null;
  detectedPhase?: string | null;
  towerNumbers: TowerNumber[];
}

interface MotionCell {
  side: 'own' | 'opponent';
  lane: 'left' | 'center' | 'right';
  intensity: number;
}

interface MotionResult {
  cells: MotionCell[];
}

export interface PerceiveOptions {
  provider?: 'local' | 'anthropic' | 'openai';
  anthropicApiKey?: string;
  openAiApiKey?: string;
  visionModel?: string;
  deckTracker?: DeckTracker;
  /** Previous tick's captured frame, used for local motion-based threat detection. */
  previousImagePath?: string;
  /** Elixir actually observed on the previous tick, for hand-tracking confidence. */
  previousElixir?: number;
  /** Elixir cost of whatever was played last tick (if anything), for the same check. */
  previousPlayCost?: number;
}

/**
 * Local Native Vision Perceiver using macOS built-in Apple Vision framework.
 * Requires ZERO external API keys. Runs 100% on-device.
 */
export async function perceiveGameStateLocally(
  imagePath: string,
  deckTracker: DeckTracker,
  options: PerceiveOptions = {}
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

  // Hand-tracking confidence: DeckTracker only *simulates* the FIFO rotation —
  // it never actually reads the hand off the screen. If the elixir we just
  // observed doesn't roughly match what spending last tick's card should have
  // left us with, the simulated rotation has likely desynced from reality, and
  // Jev should be told to treat cardsInHand as unreliable rather than act on it
  // with false confidence.
  let handTrackingConfidence: 'high' | 'low' = 'high';
  if (options.previousElixir !== undefined && options.previousPlayCost !== undefined) {
    const elapsedTicks = 1; // one loop tick between the two readings
    const regenPerTick = (Number(process.env.TICK_INTERVAL_MS) || 2000) / 1000 / 2.8;
    const expectedElixir = options.previousElixir - options.previousPlayCost + regenPerTick * elapsedTicks;
    if (Math.abs(elixir - expectedElixir) > 2.5) {
      handTrackingConfidence = 'low';
    }
  }

  // Troop identity can't come from OCR (troops carry no readable text), so
  // instead of guessing a name from nearby text, detect real frame-to-frame
  // motion and report it as an unidentified threat/activity signal — true but
  // vague beats a fabricated troop name.
  const opponentTroops: TroopUnit[] = [];
  const ownTroops: TroopUnit[] = [];
  if (options.previousImagePath) {
    try {
      const { stdout: motionOut } = await execFileAsync(HELPER_PATH, [
        'motion',
        options.previousImagePath,
        imagePath,
      ]);
      const motion: MotionResult = JSON.parse(motionOut.trim());
      for (const cell of motion.cells) {
        const troop: TroopUnit = {
          type: 'Unidentified activity',
          owner: cell.side === 'opponent' ? 'opponent' : 'own',
          lane: cell.lane,
        };
        (cell.side === 'opponent' ? opponentTroops : ownTroops).push(troop);
      }
    } catch {
      // Motion detection is best-effort; proceed without it if it fails.
    }
  }

  // Tower HP: map each detected number to a tower by screen position instead
  // of pretending every tower is always at 100%. Opponent towers are in the
  // top half of the mirrored screen, our own in the bottom half; king towers
  // sit in the center column, princess towers to either side.
  const ownTowers: TowerStatus = {};
  const opponentTowers: TowerStatus = {};
  for (const num of ocrData.towerNumbers) {
    const target = num.y < 0.5 ? opponentTowers : ownTowers;
    if (num.x < 0.38) {
      target.leftPrincessHpRaw = num.value;
    } else if (num.x > 0.62) {
      target.rightPrincessHpRaw = num.value;
    } else {
      target.kingHpRaw = num.value;
    }
  }

  return {
    matchPhase: phase,
    elixir,
    cardsInHand: handCards,
    nextCard: nextCard.name,
    opponentTroops: opponentTroops.slice(0, 6),
    ownTroops: ownTroops.slice(0, 6),
    ownTowers,
    opponentTowers,
    handTrackingConfidence,
    rawSummary: `Local perception: Phase=${phase}, Elixir=${elixir}, OpponentActivity=${opponentTroops.length}, HandConfidence=${handTrackingConfidence}`,
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
      return perceiveGameStateLocally(imagePath, tracker, options);
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
      return perceiveGameStateLocally(imagePath, tracker, options);
    }
  }

  // 3. Default: Local on-device Apple Vision (Zero Keys Required!)
  return perceiveGameStateLocally(imagePath, tracker, options);
}
