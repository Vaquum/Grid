#!/bin/sh
# Every local check; stops at the first failure and says which.
set -eu
cd "$(dirname "$0")/.."
RUFF="${RUFF:-ruff}"
PYRIGHT="${PYRIGHT:-pyright}"
echo "== python tests"; python3 -m unittest discover -s tests/py -t . -q
echo "== js tests"; node --test "tests/js/**/*.test.mjs" > /dev/null
echo "== pyright"; "$PYRIGHT" > /dev/null
echo "== ruff"; "$RUFF" check grid tests/py tools
echo "== node --check"; for f in web/js/*.js; do node --check "$f"; done
echo "== build"; python3 tools/build.py --out dist/grid.html
if [ -n "${GRID_PLAYWRIGHT:-}" ]; then
  echo "== browser"; node --test "tests/browser/*.test.mjs" > /dev/null
else
  echo "== browser: skipped (set GRID_PLAYWRIGHT to a playwright index.mjs)"
fi
echo "all checks passed"
