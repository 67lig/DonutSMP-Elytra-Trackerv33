---
name: OpenRouter AI access
description: OpenRouter billing and provider-access behavior for the market analysis integration.
---

OpenRouter can accept and authenticate a configured key while rejecting model requests with HTTP 402 when the account has never purchased credits.

**Why:** The provider returned an explicit insufficient-credits response even though the requested model was available and the request format was valid.

**How to apply:** Treat HTTP 402 as an account billing/credits issue, preserve the AI quota for the failed request, and surface the provider message instead of retrying or rotating models.