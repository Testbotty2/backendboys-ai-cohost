# Advanced Isolation Blueprint

The following are the next infrastructure layers if JUNIORS AI CHAT is moved from a single Render service to a distributed deployment. They are reliability/security isolation features, not anti-detection features.

## Tier 1 — implemented in v10.3

- immutable account event deliveries + per-delivery capability HMAC
- capability-bound runtime ownership
- runtime generation fencing
- per-account queue/backpressure/dead-letter state
- per-account envelope encryption
- hash-chained logs + signed Merkle isolation manifest
- watchdog + quarantine + independent restart
- fail-closed SOCKS5 policy
- per-account runtime directories
- per-account private random state
- account-local emote/repeat/send timing state

## Tier 2 — multi-process

Move each active account brain into a Node child process or worker service. The control plane passes only serialized raw-event envelopes. Give the process a short-lived capability for exactly one permanent account ID. Kill and recreate only that process when its generation changes.

Recommended additions: process memory/CPU limits, per-account process watchdog, Unix-domain sockets or authenticated localhost RPC, read-only configuration, and no fleet-wide credentials inside workers.

## Tier 3 — containers / sandboxing

For stronger boundaries, run account workers in separate containers or sandboxed workloads with a read-only root filesystem, tmpfs scratch space, dropped Linux capabilities, no-new-privileges, seccomp/AppArmor, explicit egress policy and a dedicated network sidecar. gVisor/Firecracker-style isolation can be used where the hosting platform supports it.

## Tier 4 — data-plane isolation

Use per-account Postgres rows plus Row Level Security, separate DB roles or short-lived DB credentials, envelope keys from KMS/HSM, and a transactional outbox. For queues, use account-partitioned Redis Streams/NATS JetStream/Kafka topics so retries and backpressure are physically partitioned.

## Tier 5 — zero-trust service mesh

Use mTLS between capture/control/account services, short-lived workload identities, capability-scoped RPC, signed event envelopes, schema/version checks and service-to-service authorization policy. The supervisor should be unable to read account secrets it does not need.

## Tier 6 — observability and proof of isolation

Add OpenTelemetry traces tagged only with permanent account IDs, per-account SLOs, invariant monitoring, synthetic canary accounts, chaos tests, fault injection, event-replay tests, cross-account leak sentinels, property-based tests and automated state-provenance checks.

## Tier 7 — recovery / change safety

Use versioned account snapshots, point-in-time restore, blue/green worker generations, canary rollout, migration dry-runs, schema compatibility gates, signed release manifests and automatic rollback when isolation invariants fail.

## Super-advanced options

- CQRS/event-sourced account state so every mutation has provenance
- KMS-generated per-account data encryption keys with rotation
- per-account secrets leases instead of long-lived plaintext credentials in process memory
- eBPF-based egress policy/observability in infrastructure that supports it
- deterministic chaos scenarios: kill one worker, expire one token, break one proxy, corrupt one queue, then prove the rest of the fleet is unaffected
- formal runtime invariants such as `account_id` ownership checks at every storage/network/queue boundary
- shadow/canary brain execution that never sends, used to validate a new brain version before promoting it for one account
- per-account resource budgets for model calls, queue depth, CPU time and memory, with admission control rather than fleet-wide failure

The default v10.3 ZIP intentionally does not claim container/microVM/RLS/service-mesh isolation unless those deployment layers are actually configured.
