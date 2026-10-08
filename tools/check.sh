#!/bin/sh
# Every local check; stops at the first failure and says which.
set -eu
cd "$(dirname "$0")/.."
RUFF="${RUFF:-ruff}"
PYRIGHT="${PYRIGHT:-pyright}"
echo "== python tests"; python3 -m unittest discover -s tests/py -t . -q
echo "== js tests"; node --test "tests/js/**/*.test.mjs" > /dev/null
echo "== pyright"; "$PYRIGHT" > /dev/null
echo "== ruff"; "$RUFF" check tessera tests/py tools
echo "== node --check"; for f in web/js/*.js; do node --check "$f"; done
echo "all checks passed"
