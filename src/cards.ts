// Strategic knowledge base for Clash Royale cards: role, targeting, and known
// matchups. This is deterministic game knowledge (not a judgment), so it lives
// in code as facts we hand to Jev as state — Jev only decides what to do with it.

export type CardRole =
  | 'win_condition' // primary tower damage dealer, usually tanky or evasive
  | 'tank' // high HP, soaks damage, no strong attack
  | 'support_ranged' // ranged, kills swarms/support units from range
  | 'support_melee' // melee bruiser, good single-target trades
  | 'swarm' // multiple cheap units, dies to splash damage
  | 'spell_small' // low-damage spell, good for finishing/small swarms
  | 'spell_big' // high-damage spell, good vs tanks/towers/grouped units
  | 'building_defense' // pulls/tanks pushes, doesn't move
  | 'spirit'; // 1-elixir suicide unit, trades for tempo

export type Targeting = 'ground' | 'air' | 'both' | 'buildings_only';

export interface CardKnowledge {
  role: CardRole;
  targets: Targeting;
  // Cards/units this one beats efficiently (positive elixir trade or shuts down).
  countersWell: string[];
  // Cards/units that beat this one efficiently — avoid using it into these alone.
  vulnerableTo: string[];
  notes?: string;
}

const KB: Record<string, CardKnowledge> = {
  skeletons: {
    role: 'swarm',
    targets: 'ground',
    countersWell: [],
    vulnerableTo: ['arrows', 'the log', 'zap', 'fireball'],
    notes: 'Cheap distraction/tank-soak, dies to any splash.',
  },
  'ice spirit': {
    role: 'spirit',
    targets: 'both',
    countersWell: ['skeletons', 'goblins', 'bats'],
    vulnerableTo: [],
    notes: 'Resets charge/dash attacks (e.g. Prince, Sparky, Mega Knight) and freezes a single unit briefly.',
  },
  'fire spirit': { role: 'spirit', targets: 'both', countersWell: ['skeletons', 'goblins', 'minions'], vulnerableTo: [] },
  'electro spirit': { role: 'spirit', targets: 'both', countersWell: ['skeletons', 'goblins'], vulnerableTo: [], notes: 'Also stuns briefly.' },
  'the log': {
    role: 'spell_small',
    targets: 'ground',
    countersWell: ['skeletons', 'goblins', 'minions', 'spear goblins', 'skeleton_army', 'princess'],
    vulnerableTo: [],
    notes: 'Knocks back ground units; does not hit air.',
  },
  zap: {
    role: 'spell_small',
    targets: 'both',
    countersWell: ['skeletons', 'goblins', 'minions', 'bats', 'spear goblins'],
    vulnerableTo: [],
    notes: 'Also resets charge attacks and can finish low-HP swarms.',
  },
  'ice golem': {
    role: 'tank',
    targets: 'ground',
    countersWell: [],
    vulnerableTo: ['inferno tower', 'inferno_dragon'],
    notes: 'Cheap mini-tank, dies then slows/damages nearby units.',
  },
  bats: { role: 'swarm', targets: 'air', countersWell: [], vulnerableTo: ['arrows', 'the log', 'zap', 'wizard', 'musketeer'] },
  goblins: { role: 'swarm', targets: 'ground', countersWell: [], vulnerableTo: ['arrows', 'the log', 'zap'] },
  'spear goblins': { role: 'swarm', targets: 'both', countersWell: [], vulnerableTo: ['arrows', 'the log', 'zap'] },
  bomber: { role: 'support_ranged', targets: 'ground', countersWell: ['skeletons', 'goblins', 'skeleton_army', 'barbarians'], vulnerableTo: ['knight'] },
  rage: { role: 'spell_small', targets: 'both', countersWell: [], vulnerableTo: [], notes: 'Buff spell, pair with a push, not a lone unit.' },
  knight: {
    role: 'tank',
    targets: 'ground',
    countersWell: ['skeletons', 'goblins', 'archers', 'spear goblins'],
    vulnerableTo: ['inferno tower', 'mini p.e.k.k.a'],
  },
  archers: { role: 'support_ranged', targets: 'both', countersWell: ['minions', 'skeletons'], vulnerableTo: ['fireball', 'valkyrie', 'arrows'] },
  arrows: {
    role: 'spell_small',
    targets: 'both',
    countersWell: ['skeleton_army', 'goblins', 'minions', 'bats', 'archers', 'spear goblins', 'minion_horde'],
    vulnerableTo: [],
  },
  cannon: { role: 'building_defense', targets: 'ground', countersWell: ['hog rider', 'giant', 'royal giant'], vulnerableTo: ['fireball', 'lightning'] },
  'mega minion': { role: 'support_ranged', targets: 'both', countersWell: ['minions', 'balloon'], vulnerableTo: ['fireball', 'zap'] },
  minions: { role: 'swarm', targets: 'air', countersWell: [], vulnerableTo: ['arrows', 'the log', 'zap', 'musketeer'], notes: 'Ground troops cannot hit them; use spell/ranged.' },
  tombstone: { role: 'building_defense', targets: 'ground', countersWell: ['hog rider'], vulnerableTo: ['fireball'] },
  skeleton_army: { role: 'swarm', targets: 'ground', countersWell: ['giant', 'pekka'], vulnerableTo: ['arrows', 'the log', 'zap', 'fireball'] },
  miner: { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: [], notes: 'Ignores walls/positioning, lands anywhere.' },
  bandit: { role: 'support_melee', targets: 'ground', countersWell: ['musketeer', 'archers'], vulnerableTo: ['knight', 'valkyrie'] },
  'royal ghost': { role: 'support_melee', targets: 'ground', countersWell: ['musketeer', 'archers'], vulnerableTo: ['valkyrie'] },
  fireball: {
    role: 'spell_big',
    targets: 'both',
    countersWell: ['musketeer', 'wizard', 'witch', 'minions', 'minion_horde', 'three musketeers', 'baby dragon'],
    vulnerableTo: [],
    notes: 'Best value on grouped medium-HP units, not single tanks.',
  },
  musketeer: { role: 'support_ranged', targets: 'both', countersWell: ['minions', 'baby dragon', 'balloon', 'lava hound'], vulnerableTo: ['fireball', 'knight', 'bandit'] },
  'hog rider': { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: ['cannon', 'tombstone', 'ice golem'], notes: 'Fast single tower-targeter; must be tanked/redirected by a building.' },
  valkyrie: { role: 'support_melee', targets: 'ground', countersWell: ['skeleton_army', 'goblins', 'barbarians'], vulnerableTo: ['inferno tower'] },
  'mini p.e.k.k.a': { role: 'support_melee', targets: 'ground', countersWell: ['knight', 'giant', 'pekka', 'valkyrie'], vulnerableTo: ['skeleton_army', 'goblins'] },
  'baby dragon': { role: 'support_ranged', targets: 'both', countersWell: ['minions', 'minion_horde', 'bats'], vulnerableTo: ['fireball', 'musketeer'] },
  poison: { role: 'spell_big', targets: 'both', countersWell: ['skeleton_army', 'goblins', 'minion_horde'], vulnerableTo: [], notes: 'Damage over time, good vs swarms & slows units in it.' },
  tesla: { role: 'building_defense', targets: 'both', countersWell: ['hog rider', 'giant'], vulnerableTo: ['fireball', 'lightning'] },
  'dark prince': { role: 'support_melee', targets: 'ground', countersWell: ['skeleton_army', 'goblins'], vulnerableTo: ['inferno tower'] },
  wizard: { role: 'support_ranged', targets: 'both', countersWell: ['skeleton_army', 'goblins', 'minions'], vulnerableTo: ['fireball', 'knight'] },
  giant: { role: 'tank', targets: 'ground', countersWell: [], vulnerableTo: ['inferno tower', 'mini p.e.k.k.a', 'skeleton_army'], notes: 'Only attacks buildings/towers; pair with support behind it.' },
  balloon: { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: ['musketeer', 'mega minion', 'inferno tower'], notes: 'Air unit, huge tower damage if it connects; must be intercepted by anti-air.' },
  witch: { role: 'support_ranged', targets: 'both', countersWell: ['skeleton_army'], vulnerableTo: ['fireball'] },
  prince: { role: 'support_melee', targets: 'ground', countersWell: ['knight'], vulnerableTo: ['skeleton_army', 'ice spirit'] },
  'inferno tower': { role: 'building_defense', targets: 'ground', countersWell: ['giant', 'golem', 'hog rider', 'pekka', 'lava hound'], vulnerableTo: ['fireball', 'lightning', 'ice spirit'] },
  'royal giant': { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: ['inferno tower', 'mini p.e.k.k.a'], notes: 'Attacks towers from range, unlike Giant.' },
  lightning: { role: 'spell_big', targets: 'both', countersWell: ['inferno tower', 'musketeer', 'wizard', 'sparky'], vulnerableTo: [] },
  rocket: { role: 'spell_big', targets: 'both', countersWell: ['musketeer', 'wizard', 'three musketeers'], vulnerableTo: [], notes: 'Highest single-target spell damage; best on high-value clumps or chip damage.' },
  sparky: { role: 'win_condition', targets: 'ground', countersWell: [], vulnerableTo: ['ice spirit', 'zap', 'the log', 'skeletons'], notes: 'Huge splash but slow charge; interrupt the charge with a cheap unit.' },
  'p.e.k.k.a': { role: 'tank', targets: 'ground', countersWell: ['giant', 'golem', 'knight'], vulnerableTo: ['skeleton_army', 'goblins', 'minion_horde'] },
  'mega knight': { role: 'tank', targets: 'ground', countersWell: ['skeleton_army', 'goblins', 'barbarians'], vulnerableTo: ['inferno tower'], notes: 'Jump deals splash on landing; bait it away from swarms first.' },
  'lava hound': { role: 'win_condition', targets: 'air', countersWell: [], vulnerableTo: ['musketeer', 'mega minion', 'inferno tower'], notes: 'Splits into lava pups on death — have anti-air ready for both.' },
  golem: { role: 'tank', targets: 'ground', countersWell: [], vulnerableTo: ['inferno tower'], notes: 'Splits into golemites on death.' },
  'three musketeers': { role: 'win_condition', targets: 'both', countersWell: [], vulnerableTo: ['fireball', 'poison', 'rocket'], notes: 'Vulnerable to a single spell if they clump.' },
};

// Aliases so slightly different OCR/perception spellings still resolve.
const ALIASES: Record<string, string> = {
  peka: 'p.e.k.k.a',
  pekka: 'p.e.k.k.a',
  'mini peka': 'mini p.e.k.k.a',
  'mini pekka': 'mini p.e.k.k.a',
  minihorde: 'minions',
  minion_horde: 'minions',
  barbarians: 'skeleton_army',
};

export function getCardKnowledge(cardName: string): CardKnowledge | null {
  const key = cardName.toLowerCase().trim();
  return KB[key] ?? (ALIASES[key] ? KB[ALIASES[key]] : null) ?? null;
}

/**
 * Given the current opponent troops on the field, find which hand card is the
 * best-known counter for the single most relevant threat. Returns null if no
 * known matchup applies — Jev should then reason from general roles instead.
 */
export function findBestKnownCounter(
  handCardNames: string[],
  opponentTroopNames: string[]
): { card: string; counters: string } | null {
  for (const threat of opponentTroopNames) {
    const threatKey = threat.toLowerCase().trim();
    for (const card of handCardNames) {
      const kb = getCardKnowledge(card);
      if (kb?.countersWell.some((c) => c === threatKey || threatKey.includes(c))) {
        return { card, counters: threat };
      }
    }
  }
  return null;
}
