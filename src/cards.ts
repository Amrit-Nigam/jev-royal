// Strategic knowledge about Clash Royale cards: what a card is for, what it can
// hit, and what it beats. This is deterministic game knowledge, so it lives in
// code as facts rather than being asked of a model.
//
// Keys are RoyaleAPI slugs, matching both assets/cards.json and the keys the
// native template matcher returns, so a recognized card looks up directly.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CardType } from './types.js';

export type CardRole =
  | 'win_condition' // primary tower damage dealer
  | 'tank' // soaks damage for a push
  | 'support_ranged' // ranged damage behind a tank
  | 'support_melee' // melee bruiser, strong single-target trades
  | 'swarm' // several cheap bodies, dies to splash
  | 'spell_small' // cheap spell, finishes swarms
  | 'spell_big' // heavy spell, for clumps and towers
  | 'building_defense' // static, pulls and tanks pushes
  | 'spirit'; // one-elixir tempo trade

export type Targeting = 'ground' | 'air' | 'both' | 'buildings_only';

export interface CardKnowledge {
  role: CardRole;
  targets: Targeting;
  /** Units this card answers efficiently. */
  countersWell: string[];
  /** Units that beat this card; avoid using it into these alone. */
  vulnerableTo: string[];
  /** Splash damage, which makes a card strong into swarms. */
  splash?: boolean;
  notes?: string;
}

const KB: Record<string, CardKnowledge> = {
  // --- Spirits and one-elixir cycle ---
  skeletons: { role: 'swarm', targets: 'ground', countersWell: ['mini-pekka', 'prince', 'sparky'], vulnerableTo: ['arrows', 'the-log', 'zap'], notes: 'Cheap distraction; dies to any splash.' },
  'ice-spirit': { role: 'spirit', targets: 'both', countersWell: ['skeletons', 'goblins', 'bats'], vulnerableTo: [], notes: 'Freezes briefly and resets charge attacks.' },
  'fire-spirit': { role: 'spirit', targets: 'both', countersWell: ['skeletons', 'goblins', 'minions'], vulnerableTo: [], splash: true },
  'electro-spirit': { role: 'spirit', targets: 'both', countersWell: ['skeletons', 'goblins'], vulnerableTo: [], notes: 'Chains a brief stun; resets charges.' },
  'heal-spirit': { role: 'spirit', targets: 'both', countersWell: ['skeletons'], vulnerableTo: [] },

  // --- Small spells ---
  'the-log': { role: 'spell_small', targets: 'ground', countersWell: ['skeleton-army', 'goblins', 'princess', 'spear-goblins', 'goblin-gang'], vulnerableTo: [], splash: true, notes: 'Rolls through ground units; cannot hit air.' },
  zap: { role: 'spell_small', targets: 'both', countersWell: ['skeletons', 'goblins', 'minions', 'bats', 'spear-goblins'], vulnerableTo: [], splash: true, notes: 'Stuns and resets charge attacks.' },
  arrows: { role: 'spell_small', targets: 'both', countersWell: ['skeleton-army', 'goblins', 'minions', 'bats', 'minion-horde', 'princess', 'goblin-barrel'], vulnerableTo: [], splash: true },
  'barbarian-barrel': { role: 'spell_small', targets: 'ground', countersWell: ['skeleton-army', 'goblins'], vulnerableTo: [], splash: true },
  snowball: { role: 'spell_small', targets: 'both', countersWell: ['bats', 'skeletons', 'minions'], vulnerableTo: [], splash: true, notes: 'Slows and knocks back.' },
  rage: { role: 'spell_small', targets: 'both', countersWell: [], vulnerableTo: [], notes: 'Support buff only; worthless without a push already committed.' },

  // --- Big spells ---
  fireball: { role: 'spell_big', targets: 'both', countersWell: ['musketeer', 'wizard', 'witch', 'minion-horde', 'three-musketeers', 'barbarians'], vulnerableTo: [], splash: true, notes: 'Best value on clumped medium-health units.' },
  poison: { role: 'spell_big', targets: 'both', countersWell: ['skeleton-army', 'goblins', 'minion-horde', 'graveyard'], vulnerableTo: [], splash: true },
  lightning: { role: 'spell_big', targets: 'both', countersWell: ['inferno-tower', 'musketeer', 'wizard', 'sparky'], vulnerableTo: [], splash: true },
  rocket: { role: 'spell_big', targets: 'both', countersWell: ['three-musketeers', 'wizard', 'musketeer'], vulnerableTo: [], splash: true },
  tornado: { role: 'spell_big', targets: 'both', countersWell: ['skeleton-army', 'goblins'], vulnerableTo: [], notes: 'Pulls units together, ideally into the king tower.' },
  earthquake: { role: 'spell_big', targets: 'ground', countersWell: ['skeleton-army', 'goblins', 'cannon', 'tesla'], vulnerableTo: [], splash: true },
  freeze: { role: 'spell_big', targets: 'both', countersWell: [], vulnerableTo: [] },

  // --- Tanks and win conditions ---
  knight: { role: 'tank', targets: 'ground', countersWell: ['skeletons', 'goblins', 'archers', 'spear-goblins', 'bandit'], vulnerableTo: ['inferno-tower', 'mini-pekka', 'skeleton-army'], notes: 'Cheap, reliable mini-tank; good default defender.' },
  'ice-golem': { role: 'tank', targets: 'ground', countersWell: ['goblins'], vulnerableTo: ['inferno-tower'], notes: 'Kites tower-targeting units; slows on death.' },
  giant: { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['inferno-tower', 'mini-pekka', 'skeleton-army'], notes: 'Only attacks buildings; needs support behind it.' },
  'royal-giant': { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['inferno-tower', 'mini-pekka'], notes: 'Outranges towers.' },
  'hog-rider': { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['cannon', 'tombstone', 'tesla', 'skeleton-army'], notes: 'Fast; must be redirected by a building or swarmed.' },
  balloon: { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['musketeer', 'mega-minion', 'inferno-tower'], notes: 'Air; huge tower damage if it connects.' },
  'lava-hound': { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['musketeer', 'inferno-tower'], notes: 'Air tank; splits into pups on death.' },
  golem: { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['inferno-tower', 'pekka'], notes: 'Very expensive; splits on death.' },
  pekka: { role: 'tank', targets: 'ground', countersWell: ['giant', 'golem', 'knight', 'mega-knight'], vulnerableTo: ['skeleton-army', 'minion-horde', 'goblins'], notes: 'Huge single-target damage, helpless against air.' },
  'mega-knight': { role: 'tank', targets: 'ground', countersWell: ['skeleton-army', 'goblins', 'barbarians', 'minion-horde'], vulnerableTo: ['inferno-tower', 'pekka'], splash: true, notes: 'Splash on landing; bait swarms away first.' },
  miner: { role: 'win_condition', targets: 'ground', countersWell: ['princess', 'musketeer'], vulnerableTo: [], notes: 'Deploys anywhere, including onto support units.' },
  graveyard: { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: ['poison', 'arrows', 'valkyrie'] },
  'goblin-barrel': { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: ['arrows', 'the-log', 'zap'], notes: 'Thrown directly onto a tower; punished by any small spell.' },
  'wall-breakers': { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['arrows', 'the-log', 'zap'] },
  'battle-ram': { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['skeleton-army', 'cannon'] },
  'three-musketeers': { role: 'win_condition', targets: 'both', countersWell: ['giant', 'balloon'], vulnerableTo: ['fireball', 'rocket', 'poison'], notes: 'Split them; a single spell kills all three if clumped.' },
  sparky: { role: 'win_condition', targets: 'ground', countersWell: ['barbarians', 'skeleton-army'], vulnerableTo: ['zap', 'the-log', 'ice-spirit', 'skeletons'], splash: true, notes: 'Slow charge; any stun resets it.' },

  // --- Melee support ---
  'mini-pekka': { role: 'support_melee', targets: 'ground', countersWell: ['giant', 'golem', 'pekka', 'knight', 'hog-rider', 'valkyrie'], vulnerableTo: ['skeleton-army', 'goblins', 'minion-horde'], notes: 'Premier single-target tank killer; useless against air.' },
  valkyrie: { role: 'support_melee', targets: 'ground', countersWell: ['skeleton-army', 'goblins', 'barbarians', 'archers', 'goblin-gang'], vulnerableTo: ['inferno-tower', 'mini-pekka'], splash: true, notes: 'Full-circle splash; the reliable answer to ground swarms.' },
  prince: { role: 'support_melee', targets: 'ground', countersWell: ['knight', 'musketeer'], vulnerableTo: ['skeleton-army', 'ice-spirit', 'goblins'] },
  'dark-prince': { role: 'support_melee', targets: 'ground', countersWell: ['skeleton-army', 'goblins', 'barbarians'], vulnerableTo: ['inferno-tower'], splash: true },
  bandit: { role: 'support_melee', targets: 'ground', countersWell: ['musketeer', 'archers'], vulnerableTo: ['knight', 'valkyrie'] },
  'royal-ghost': { role: 'support_melee', targets: 'ground', countersWell: ['musketeer', 'archers'], vulnerableTo: ['valkyrie'], splash: true },
  lumberjack: { role: 'support_melee', targets: 'ground', countersWell: ['musketeer'], vulnerableTo: ['skeleton-army'], notes: 'Drops a Rage on death.' },
  fisherman: { role: 'support_melee', targets: 'ground', countersWell: ['hog-rider', 'giant'], vulnerableTo: ['skeleton-army'], notes: 'Pulls a unit out of its lane.' },
  barbarians: { role: 'swarm', targets: 'ground', countersWell: ['giant', 'hog-rider', 'pekka'], vulnerableTo: ['fireball', 'valkyrie', 'wizard'] },
  'elite-barbarians': { role: 'support_melee', targets: 'ground', countersWell: ['hog-rider'], vulnerableTo: ['skeleton-army', 'valkyrie'] },

  // --- Ranged support ---
  archers: { role: 'support_ranged', targets: 'both', countersWell: ['minions', 'bats', 'balloon'], vulnerableTo: ['fireball', 'valkyrie', 'arrows'] },
  musketeer: { role: 'support_ranged', targets: 'both', countersWell: ['balloon', 'lava-hound', 'baby-dragon', 'minions', 'mega-minion'], vulnerableTo: ['fireball', 'knight', 'bandit'], notes: 'Best general-purpose anti-air.' },
  wizard: { role: 'support_ranged', targets: 'both', countersWell: ['skeleton-army', 'goblins', 'minions', 'bats', 'barbarians'], vulnerableTo: ['fireball', 'knight', 'mini-pekka'], splash: true, notes: 'Splash that hits air; strong into any swarm.' },
  'baby-dragon': { role: 'support_ranged', targets: 'both', countersWell: ['minions', 'minion-horde', 'bats', 'skeleton-army', 'goblins'], vulnerableTo: ['musketeer', 'fireball'], splash: true, notes: 'Air splash; safe from ground-only defenders.' },
  'mega-minion': { role: 'support_ranged', targets: 'both', countersWell: ['balloon', 'minions', 'baby-dragon'], vulnerableTo: ['fireball', 'arrows'] },
  'electro-wizard': { role: 'support_ranged', targets: 'both', countersWell: ['inferno-tower', 'sparky', 'balloon'], vulnerableTo: ['fireball'], notes: 'Stuns on spawn and resets charge attacks.' },
  executioner: { role: 'support_ranged', targets: 'both', countersWell: ['minion-horde', 'barbarians', 'skeleton-army'], vulnerableTo: ['fireball', 'knight'], splash: true },
  witch: { role: 'support_ranged', targets: 'both', countersWell: ['skeleton-army', 'goblins'], vulnerableTo: ['fireball', 'rocket'], splash: true },
  bomber: { role: 'support_ranged', targets: 'ground', countersWell: ['skeleton-army', 'goblins', 'barbarians'], vulnerableTo: ['knight', 'minions'], splash: true },
  princess: { role: 'support_ranged', targets: 'both', countersWell: ['skeleton-army', 'goblins', 'minion-horde'], vulnerableTo: ['the-log', 'arrows', 'fireball'], splash: true },
  'dart-goblin': { role: 'support_ranged', targets: 'both', countersWell: ['minions', 'bats'], vulnerableTo: ['arrows', 'the-log'] },
  'electro-dragon': { role: 'support_ranged', targets: 'both', countersWell: ['balloon', 'minion-horde'], vulnerableTo: ['fireball'], splash: true },
  'flying-machine': { role: 'support_ranged', targets: 'both', countersWell: ['minions'], vulnerableTo: ['arrows'] },
  'magic-archer': { role: 'support_ranged', targets: 'both', countersWell: ['goblins', 'skeleton-army'], vulnerableTo: ['fireball'], splash: true },
  'hunter': { role: 'support_ranged', targets: 'both', countersWell: ['balloon', 'mega-knight', 'pekka'], vulnerableTo: ['fireball'], notes: 'Devastating at point-blank range only.' },

  // --- Swarms ---
  goblins: { role: 'swarm', targets: 'ground', countersWell: ['mini-pekka', 'prince', 'hog-rider'], vulnerableTo: ['arrows', 'the-log', 'zap'] },
  'spear-goblins': { role: 'swarm', targets: 'both', countersWell: [], vulnerableTo: ['arrows', 'the-log', 'zap'] },
  'goblin-gang': { role: 'swarm', targets: 'both', countersWell: ['mini-pekka', 'hog-rider', 'giant'], vulnerableTo: ['arrows', 'the-log', 'zap'] },
  minions: { role: 'swarm', targets: 'air', countersWell: ['giant', 'golem'], vulnerableTo: ['arrows', 'zap', 'wizard'], notes: 'Air only; ground-only defenders cannot touch them.' },
  'minion-horde': { role: 'swarm', targets: 'air', countersWell: ['giant', 'golem', 'pekka'], vulnerableTo: ['arrows', 'fireball', 'wizard'], notes: 'Air only.' },
  bats: { role: 'swarm', targets: 'air', countersWell: ['mini-pekka', 'pekka'], vulnerableTo: ['arrows', 'zap', 'snowball'], notes: 'Air only.' },
  'skeleton-army': { role: 'swarm', targets: 'ground', countersWell: ['giant', 'pekka', 'hog-rider', 'mini-pekka'], vulnerableTo: ['arrows', 'the-log', 'zap', 'fireball', 'valkyrie'] },
  'royal-hogs': { role: 'win_condition', targets: 'buildings_only', countersWell: [], vulnerableTo: ['fireball', 'valkyrie'] },
  'royal-recruits': { role: 'swarm', targets: 'ground', countersWell: ['hog-rider'], vulnerableTo: ['fireball', 'wizard'] },

  // --- Buildings ---
  cannon: { role: 'building_defense', targets: 'ground', countersWell: ['hog-rider', 'giant', 'royal-giant', 'battle-ram'], vulnerableTo: ['fireball', 'lightning', 'earthquake'], notes: 'Cheapest reliable answer to ground win conditions.' },
  tesla: { role: 'building_defense', targets: 'both', countersWell: ['hog-rider', 'giant', 'balloon', 'minions'], vulnerableTo: ['fireball', 'lightning', 'earthquake'], notes: 'Hits air, unlike Cannon.' },
  tombstone: { role: 'building_defense', targets: 'ground', countersWell: ['hog-rider', 'giant'], vulnerableTo: ['fireball', 'poison'] },
  'inferno-tower': { role: 'building_defense', targets: 'both', countersWell: ['golem', 'giant', 'pekka', 'lava-hound', 'mega-knight'], vulnerableTo: ['lightning', 'fireball', 'zap', 'electro-wizard'], notes: 'The answer to big tanks; any stun resets its damage ramp.' },
  'bomb-tower': { role: 'building_defense', targets: 'ground', countersWell: ['skeleton-army', 'barbarians', 'hog-rider'], vulnerableTo: ['fireball', 'lightning'], splash: true },
  mortar: { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: ['fireball', 'lightning'] },
  'x-bow': { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: ['fireball', 'lightning', 'rocket'] },
  'elixir-collector': { role: 'building_defense', targets: 'ground', countersWell: [], vulnerableTo: ['fireball', 'lightning', 'rocket'], notes: 'Pure investment; only safe when already ahead on elixir.' },
  furnace: { role: 'building_defense', targets: 'ground', countersWell: [], vulnerableTo: ['fireball', 'lightning'] },
  'goblin-hut': { role: 'building_defense', targets: 'ground', countersWell: [], vulnerableTo: ['fireball', 'lightning'] },
  'barbarian-hut': { role: 'building_defense', targets: 'ground', countersWell: [], vulnerableTo: ['fireball', 'lightning'] },
  'goblin-cage': { role: 'building_defense', targets: 'ground', countersWell: ['hog-rider', 'giant'], vulnerableTo: ['fireball'] },
};

/**
 * Area-of-effect radius and time-to-land for each spell.
 *
 * Radii are in Clash Royale tiles. `travelSeconds` is roughly how long passes
 * between the tap and the damage landing, which is what a moving target has to
 * be led by: aiming a Fireball where a unit currently stands misses it.
 */
export interface SpellProperties {
  radiusTiles: number;
  travelSeconds: number;
}

const SPELLS: Record<string, SpellProperties> = {
  zap: { radiusTiles: 2.5, travelSeconds: 0.1 },
  snowball: { radiusTiles: 2.5, travelSeconds: 0.5 },
  arrows: { radiusTiles: 4.0, travelSeconds: 1.1 },
  'the-log': { radiusTiles: 3.9, travelSeconds: 0.6 },
  'barbarian-barrel': { radiusTiles: 2.5, travelSeconds: 0.8 },
  fireball: { radiusTiles: 2.5, travelSeconds: 0.9 },
  poison: { radiusTiles: 3.5, travelSeconds: 1.0 },
  lightning: { radiusTiles: 3.5, travelSeconds: 1.2 },
  rocket: { radiusTiles: 2.0, travelSeconds: 1.3 },
  earthquake: { radiusTiles: 3.5, travelSeconds: 0.8 },
  tornado: { radiusTiles: 5.5, travelSeconds: 0.6 },
  freeze: { radiusTiles: 3.0, travelSeconds: 0.8 },
  rage: { radiusTiles: 5.0, travelSeconds: 0.6 },
  'goblin-barrel': { radiusTiles: 1.5, travelSeconds: 1.5 },
  graveyard: { radiusTiles: 4.0, travelSeconds: 1.0 },
};

export function getSpellProperties(key: string): SpellProperties | null {
  return SPELLS[key] ?? null;
}

export interface CardMeta {
  key: string;
  name: string;
  elixir: number;
  type: CardType;
}

let metaCache: Record<string, CardMeta> | null = null;

/** Card metadata from the open-source RoyaleAPI dataset. */
export function getCardMeta(key: string): CardMeta | null {
  if (!metaCache) {
    metaCache = {};
    try {
      const raw = readFileSync(resolve(process.cwd(), 'assets/cards.json'), 'utf8');
      for (const card of JSON.parse(raw) as Array<Record<string, unknown>>) {
        const k = String(card.key);
        metaCache[k] = {
          key: k,
          name: String(card.name),
          elixir: Number(card.elixir),
          type: (card.type as CardType) ?? 'unknown',
        };
      }
    } catch {
      // Falling back to an empty cache is fine: callers already carry the
      // elixir cost and type reported by the native matcher.
      metaCache = {};
    }
  }
  return metaCache[key] ?? null;
}

export function getCardKnowledge(key: string): CardKnowledge | null {
  return KB[key] ?? null;
}

/**
 * Role inferred for a card we have no curated entry for, so an unknown card
 * still gets treated sensibly rather than being excluded from play.
 */
export function inferRole(type: CardType, elixir: number): CardRole {
  if (type === 'Building') return 'building_defense';
  if (type === 'Spell') return elixir >= 4 ? 'spell_big' : 'spell_small';
  if (elixir <= 1) return 'spirit';
  if (elixir >= 6) return 'tank';
  return 'support_melee';
}

export function roleOf(key: string, type: CardType, elixir: number): CardRole {
  return getCardKnowledge(key)?.role ?? inferRole(type, elixir);
}

export function targetsOf(key: string, type: CardType): Targeting {
  const known = getCardKnowledge(key);
  if (known) return known.targets;
  return type === 'Spell' ? 'both' : 'ground';
}

/** True when this card can actually shoot air units. */
export function canHitAir(key: string, type: CardType): boolean {
  const t = targetsOf(key, type);
  return t === 'air' || t === 'both';
}
