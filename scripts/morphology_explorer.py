#!/usr/bin/env python3
"""Open the morphology atlas: a zoomable map of robot designs, browsed before
any of them meets the feasibility gate.

    python scripts/morphology_explorer.py              # http://127.0.0.1:8082
    python scripts/morphology_explorer.py --port 9000

Pick a design, then "Save to the repository" writes it to
`src/draft/robots/atlas_<id>/`, and "Run Draft's gate" compiles it.
"""
from __future__ import annotations

import sys

from draft.explorer.server import main

if __name__ == "__main__":
    sys.exit(main())
