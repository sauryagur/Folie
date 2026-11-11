Vendored verbatim and loaded at runtime by `@grpc/proto-loader` (no codegen). Each tree keeps its upstream
path below an import root, so upstream `import` lines resolve unchanged (`src/server/grpc.ts`: `AX_PROTO`,
`SUBSTRATE_PROTO`).

| Root         | Source                                                                      | Pinned at                |
| ------------ | --------------------------------------------------------------------------- | ------------------------ |
| `ax/`        | google/ax `pkg/apis/v1alpha1/*.proto` (entry `ax.proto`, package `ax.v1alpha1`) | ax `9bf6aef` (2026-11-09) |
| `substrate/` | agent-substrate/substrate `api/ateapi/v1/ateapi.proto` (package `substrate.ateapi.v1`) | Substrate `v1.0.0`       |

The ax checkout `folie up` runs (`../ax` or `FOLIE_AX_DIR`) decides which Substrate gets installed (its `go.mod`),
and Folie's Substrate calls must match that release: Substrate v1.0.0 renamed the package from `ateapi` to
`substrate.ateapi.v1`, which made every egress-policy call from an older Folie fail. `folie up` warns when the ax
checkout pins a different Substrate than `SUBSTRATE_VERSION` in `src/host/ax-pin.ts`. Re-copy both trees and bump
that constant together.
