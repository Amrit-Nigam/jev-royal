# Jev Plays Clash Royale — Build Spec

## Goal

A personal, scrappy proof-of-concept (not production-grade) that autonomously plays
Clash Royale on macOS by reading the game through the built-in **iPhone Mirroring**
app, deciding moves with TypeSafe's Jev model, and simulating taps to actually play.

The user will manually open iPhone Mirroring and launch Clash Royale on the iPhone
before starting the agent — no need to script opening iPhone Mirroring itself.

## Why this architecture

TypeSafe/Jev ("System One" model) only accepts **text/JSON state** — no image, audio,
or video input (confirmed against current docs at docs.typesafe.ai). So the pipeline
needs a separate vision step to turn a screenshot into structured JSON before Jev can
reason over it. Jev's job is strictly the *decision* (which card to play, where), not
perception.

## Pipeline (one loop tick ≈ every 1–3 seconds while a match is active)

1. **Locate window** — find the "iPhone Mirroring" app's window and its bounds
   (position + size) on screen.
2. **Capture** — screenshot just that window (not the whole screen).
3. **Perceive (vision step)** — send the screenshot to a vision-capable model
   (e.g. Claude vision via the Anthropic API) with a prompt asking it to return
   structured JSON describing the current game state:
   - elixir count (0–10, can be fractional)
   - cards in hand (name/type per slot, 4 slots) + the next card if visible
   - opponent's visible troops (type, approx lane/position, approx HP if visible)
   - own visible troops (type, approx lane/position)
   - tower HP (own two + opponent's two, and king towers) if visible/estimable
   - match phase (pre-game, in-progress, overtime, post-game/result screen)
   - screen resolution / pixel bounds of the arena and of each hand-card slot, so
     coordinates can be mapped back to taps later
4. **Decide (Jev step)** — send the structured JSON state from step 3 to TypeSafe's
   `systemOne` endpoint as ONE BATCHED call with multiple questions (Choice/Noul/Score),
   e.g.:
   - `shouldPlayNow` (Noul): is now a good time to spend elixir vs. wait/save?
   - `whichCard` (Choice): which of the 4 hand cards to play (or "none")
   - `whichLane` (Choice): left lane / right lane / defensive position near own tower
   - optionally `confidence`/reasoning-adjacent scores to gate risky plays
   Batch these into a single request per tick (10x cheaper/faster per TypeSafe's own
   benchmark data) rather than one call per question.
5. **Act (automation step)** — if the decision says to play a card:
   - map the chosen card's hand-slot to its on-screen pixel coordinates (from step 3's
     slot bounds + the window's on-screen offset from step 1)
   - map the chosen lane/placement to a target pixel coordinate in the arena
   - simulate: tap the card slot, then tap the target placement location
   - this is two simulated clicks in the iPhone Mirroring window, positioned in real
     screen coordinates (window offset + relative offset within the window)
6. **Loop** — repeat from step 2 while match phase is "in-progress"; stop/report when
   phase becomes "post-game" or the window disappears.

## Components to build

- `src/window.ts` — locate the iPhone Mirroring window and its on-screen bounds
  (e.g. via `osascript`/System Events window position+size query, or
  `CGWindowListCopyWindowInfo` via a small native/Swift helper if AppleScript can't
  get exact pixel bounds reliably).
- `src/capture.ts` — screenshot just that window. macOS `screencapture -l<windowID>
  -o output.png` captures a specific window by CoreGraphics window ID without
  needing exact coordinates; getting that window ID is the main plumbing here.
- `src/perceive.ts` — call Anthropic's vision API (Claude) with the screenshot,
  return validated structured JSON (game state) per the schema in step 3.
- `src/decide.ts` — call TypeSafe's JS SDK (`@typesafe-ai/sdk`, `TYPESAFE_API_KEY`
  env var) with a single batched `systemOne` call per tick, per step 4's questions.
- `src/act.ts` — simulate clicks at absolute screen coordinates. Needs a click tool:
  - Option A: `cliclick` (Homebrew: `brew install cliclick`) — simplest, shells out
    `cliclick c:X,Y`.
  - Option B: Python + `pyobjc`/Quartz `CGEventCreateMouseEvent` — no extra CLI
    dependency but adds a Python subprocess or a native binding from Node.
  - Whichever is chosen needs **Accessibility permissions** granted to the terminal/
    process doing the clicking (System Settings → Privacy & Security → Accessibility).
- `src/loop.ts` — orchestrates steps 2–6 on an interval, with basic backoff/retry on
  API errors, and stop conditions (match end detected, window closed, user Ctrl+C).
- `.env` — `TYPESAFE_API_KEY=...`, `ANTHROPIC_API_KEY=...`.

## Setup / dependencies

- Node.js (v20+; v22 already installed) + TypeScript.
- `npm install @typesafe-ai/sdk @anthropic-ai/sdk dotenv`
- `brew install cliclick` (if going with Option A for clicking) — **not yet
  installed on this machine**; needs explicit user approval before installing.
- macOS Accessibility permission grant for whichever process sends synthetic clicks.
- TypeSafe API key from typesafe.ai (not yet provided).
- Anthropic API key (not yet provided).

## Open decisions / things to confirm before/while building

1. **Click tool**: `cliclick` (brew install) vs. Python/Quartz vs. some other
   native approach. Pick one and get user approval to install if it requires brew.
2. **Vision model choice**: Claude vision (Anthropic API directly) is assumed, but
   confirm — could also be done through whatever multimodal access the build
   environment already has, if avoiding a second paid API is preferred.
3. **Reliability bar**: this is explicitly a "personal, for fun" PoC — it does not
   need to reliably win games, handle every UI state (chests, level-up popups,
   emotes, disconnects), or recover gracefully from every edge case. Keep it scrappy;
   don't over-engineer error handling for scenarios that "can't happen" in a casual
   demo run.
4. **Stopping condition**: simplest viable approach is Ctrl+C to stop the loop, plus
   an automatic stop when the vision step reports the match ended.
5. **Legal/ToS note**: Clash Royale's ToS generally prohibits automation/bots.
   This is being built as a personal, non-distributed, small-scale novelty
   (showing someone "an AI can play using my phone mirrored to my Mac"), not for
   competitive advantage, ranked play automation at scale, or distribution to other
   players. Keep it scoped that way — a one-off local demo, not a public bot.

## Non-goals

- No packaging, no UI, no persistence/analytics, no multi-user support.
- No attempt to be unbeatable or strategically optimal — just genuinely autonomous
  and demonstrably working end-to-end (see the board, decide a move, tap it out).
- No scripting of "open iPhone Mirroring" itself — assume it's already open with
  Clash Royale running when the agent starts.
