---
name: Usage-audit privacy and daily attribution
description: Durable constraints for authenticated product-usage telemetry and its admin summaries.
---

Usage telemetry must accept only server-controlled page paths, report keys, visibility states, and derived display labels. It must never store supplied report names, arbitrary labels, form/search content, key values, mouse coordinates, or screenshots.

**Why:** Client-provided free text can accidentally or deliberately turn a minimal audit trail into a data-exfiltration channel.

**How to apply:** Add new audited pages and report outputs to the shared client/server allowlists. Keep the client fire-and-forget so tracking outages never block product behavior.

Busy and idle totals must be derived from captured activity segments and split at calendar-day boundaries; page/report events belong to the day they occurred, not the day their session began.

**Why:** An open session can span midnight, and attributing all activity to login day produces misleading per-user/day usage reporting.

**How to apply:** When extending the admin API, slice interval contributions at UTC midnight and retain unknown/null historical values rather than inventing them for legacy sessions.

Exactly one stateful browser heartbeat producer may be mounted for an authenticated tracker session, and the server must serialize each user's session mutations.

**Why:** A legacy body-less heartbeat alongside the stateful tracker can mark the same interval idle and cause overlapping segments; separate browser tabs can race too.

**How to apply:** Do not reintroduce a second heartbeat hook. Keep the per-user transactional advisory lock around every login, heartbeat, usage-event rollover, and logout session mutation.