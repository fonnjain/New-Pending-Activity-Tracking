---
name: Anomaly constraint publish
description: Drizzle publish can report a bare drop for the legacy anomaly status CHECK; runtime startup restores the approved constraint.
---

Drizzle's publish diff may detect the legacy `order_review_anomalies_status_check` but omit its replacement when changing the managed schema. This project keeps an idempotent startup upgrade that drops and recreates the constraint with exactly `open`, `explained`, and `superseded`; production must be checked after publishing.

**Why:** The publish tool does not always model an existing CHECK constraint's replacement, so relying on the diff alone can leave the status column unconstrained during rollout.

**How to apply:** Treat the bare CHECK drop as acceptable only when the startup recreation is deployed in the same release, Overwrite data is off, and the production constraint definition is verified afterward.