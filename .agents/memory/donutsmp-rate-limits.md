---
name: DonutSMP request headroom
description: Safe polling guidance for the two-market DonutSMP scan
---

The provider’s documented per-key request cap is close enough to a full two-market page scan that polling every ten seconds can trigger HTTP 429 responses. Keep a conservative interval that leaves meaningful headroom.

**Why:** A two-market scan can request up to 40 auction pages per cycle; the initial ten-second interval produced partial scans and temporarily stale status even though the API key was valid.

**How to apply:** If the scan page count or number of categories changes, recalculate requests per minute and preserve headroom below the provider limit; keep incomplete scans from replacing the last complete snapshot.