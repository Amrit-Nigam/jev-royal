#!/usr/bin/env bash
# Downloads the card art and card metadata used to build the recognition index.
#
# Both come from RoyaleAPI's open data repositories:
#   https://github.com/RoyaleAPI/cr-api-assets  (card images)
#   https://github.com/RoyaleAPI/cr-api-data    (elixir costs, types)
#
# The art itself is not committed (it is ~9MB and fully reproducible); only the
# derived assets/card-index.json and assets/cards.json are. Run this, then
# `npm run build-card-index`, if you ever need to rebuild the index.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARDS_DIR="$ROOT/assets/cards"
ASSETS_BASE="https://raw.githubusercontent.com/RoyaleAPI/cr-api-assets/master/cards-150"
DATA_URL="https://raw.githubusercontent.com/RoyaleAPI/cr-api-data/master/docs/json/cards.json"

mkdir -p "$CARDS_DIR"

echo "Fetching card metadata..."
curl -sfL "$DATA_URL" -o "$ROOT/assets/cards.json"

echo "Listing card art..."
LIST=$(mktemp)
curl -sfL "https://api.github.com/repos/RoyaleAPI/cr-api-assets/contents/cards-150" \
  | python3 -c "import json,sys; print('\n'.join(x['name'] for x in json.load(sys.stdin) if x['name'].endswith('.png') and not x['name'].startswith('_')))" \
  > "$LIST"

echo "Downloading $(wc -l < "$LIST" | tr -d ' ') card images..."
(cd "$CARDS_DIR" && xargs -P 12 -I{} curl -sfL -o {} "$ASSETS_BASE/{}" < "$LIST")
rm -f "$LIST"

echo "Done. Now run: npm run build-card-index"
