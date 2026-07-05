---
name: Orval response-schema naming collision
description: Naming an OpenAPI response schema the same as orval's auto-generated operation zod const causes a duplicate-export TS2308 error.
---

When adding a new OpenAPI operation, orval's zod codegen auto-generates a
validator const named `Capitalize(operationId) + "Response"` in
`lib/api-zod/src/generated/api.ts` (e.g. operationId `adminRecompute` →
`AdminRecomputeResponse`).

If the referenced `$ref` component schema for that response happens to have
the *exact same name*, the generated `types/` barrel also exports a type
interface with that name, and `lib/api-zod/src/index.ts`'s `export *` from
both generated modules collides — `tsc --build` fails with
`TS2308: Module "./generated/api" has already exported a member named 'X'`.

**Why:** most existing response schemas avoid this because they're named
with an operation-specific prefix baked in differently than the raw
operationId (e.g. `GetContractorMovementResponse` for operationId
`getContractorMovement` — the schema itself is just `ContractorMovementResponse`
elsewhere and doesn't collide). A fresh schema named to exactly match
`Capitalize(operationId) + "Response"` is the trap.

**How to apply:** when defining a new response schema in `openapi.yaml`,
give it a name that is NOT `Capitalize(operationId) + "Response"` — e.g. use
`Result` instead of `Response` as the suffix, or prefix/suffix it
differently from the operationId. Confirmed fix: renaming
`AdminRecomputeResponse` → `AdminRecomputeResult` resolved the collision and
codegen/typecheck passed cleanly.
