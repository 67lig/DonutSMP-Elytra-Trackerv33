---
name: Imported artifact registration
description: How imported projects can differ between filesystem metadata and artifact catalog state.
---

Imported projects may include `artifacts/*/.replit-artifact/artifact.toml` and working workflows without being registered in the artifact catalog. In that state, artifact presentation and screenshot helpers may report that the artifact is missing even though the web workflow serves normally.

**Why:** The filesystem metadata and catalog registration are separate pieces of Replit state; imports can provide the former without the latter.

**How to apply:** Treat the running workflow and direct endpoint checks as valid runtime evidence, but do not create a duplicate artifact solely to make presentation tooling resolve an existing imported app.