import api from "@/app/services/api";

/** Audit Trail client (Audit Service via the gateway at /audit/v1). Read-only, plus chain verification. */

export type Outcome = "SUCCESS" | "FAILURE" | "DENIED";

export interface AuditEvent {
  event_id: string;
  tenant_id: string | null;
  environment_id: string;
  chain_id: string;
  sequence_number: number;
  timestamp: string;
  recorded_at: string;
  actor_id: string | null;
  actor_type: string;
  actor_role: string | null;
  actor_name: string | null;
  service_name: string;
  module: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  case_id: string | null;
  correlation_id: string | null;
  source_event_id: string;
  previous_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  outcome: Outcome;
  metadata: Record<string, unknown>;
  previous_hash: string;
  current_hash: string;
  hash_version: number;
}

export interface NeighbourEvent {
  event_id: string;
  sequence_number: number;
  current_hash: string;
  previous_hash: string;
  action: string;
}

export interface AuditEventDetail extends AuditEvent {
  previous_event: NeighbourEvent | null;
  next_event: NeighbourEvent | null;
}

/** What the ledger still knows about a sequence number (the event row itself may be gone). */
export interface SequenceInfo {
  chain_id: string;
  sequence_number: number;
  present: boolean;
  event_id: string | null;
  recorded: { event_id: string; service_name: string; source_event_id: string; recorded_at: string; current_hash: string } | null;
  expected_hash: string | null;
  hash_confirmed: boolean;
  archived?: { archive_id: string; archive_number: number; start_sequence: number; end_sequence: number } | null;
  recovered?: {
    event: AuditEvent;
    source: "kafka" | "recycle_bin";
    partition: number | null;
    offset: number | null;
    hash_verified: boolean;
  } | null;
  previous_event: NeighbourEvent | null;
  next_event: NeighbourEvent | null;
}

/** Demo-only (ENV_VAR=demo): a deleted event parked in the recycle bin, with its full original content. */
export interface RecycledEvent {
  bin_id: string;
  deleted_at: string;
  deleted_by: string | null;
  event: AuditEvent;
}

export interface EventPage {
  items: AuditEvent[];
  total: number;
  page: number;
  page_size: number;
}

export interface VerificationResult {
  tenant_id: string | null;
  chain_id: string;
  status: "VALID" | "INVALID";
  total_events_checked: number;
  first_invalid_sequence: number | null;
  reason: string | null;
  details: Record<string, unknown>;
  from_sequence: number;
  to_sequence: number | null;
  head_sequence: number;
  head_checked: boolean;
  verified_at: string;
  duration_ms: number;
  run_id?: string | null;
}

export interface VerificationRun {
  run_id: string;
  chain_id: string;
  tenant_id: string | null;
  trigger: "SCHEDULED" | "ON_DEMAND";
  requested_by: string | null;
  finished_at: string;
  duration_ms: number;
  status: "VALID" | "INVALID";
  total_events_checked: number;
  first_invalid_sequence: number | null;
  reason: string | null;
  details: Record<string, unknown>;
  head_sequence: number;
}

export interface ChainSummary {
  chain_id: string;
  scope: "TENANT" | "PLATFORM";
  tenant_id: string | null;
  head_sequence: number;
  head_hash: string;
  genesis_hash: string;
  updated_at: string;
  last_verification: VerificationRun | null;
}

export interface OpsStatus {
  ledger: { events: number; chains: number; last_event_at: string | null };
  verification: { invalid_chains: number; unverified_chains: number; last_run_at: string | null };
  pipeline: { consumer_running?: boolean; running?: boolean; total_lag?: number | null; last_error?: string | null; dead_lettered?: number };
  dead_letters?: { count: number };
}

export interface Facets {
  modules: string[];
  actions: string[];
  entity_types: string[];
  outcomes: string[];
  services: string[];
}

export interface EventFilters {
  q: string;
  module: string;
  action: string;
  entity_type: string;
  outcome: string;
  actor: string;
  tenant: string; // SuperAdmin: a tenant id, "platform", or "" for all
  dateFrom: string; // yyyy-mm-dd
  dateTo: string;
  entity_id: string;
  case_id: string;
  correlation_id: string;
  chain_id: string;
  sequence: string;
}

export const EMPTY_FILTERS: EventFilters = {
  q: "", module: "", action: "", entity_type: "", outcome: "", actor: "", tenant: "", dateFrom: "", dateTo: "",
  entity_id: "", case_id: "", correlation_id: "", chain_id: "", sequence: "",
};

function startOfDayIso(day: string): string | undefined {
  return day ? new Date(`${day}T00:00:00`).toISOString() : undefined;
}

function endOfDayIso(day: string): string | undefined {
  return day ? new Date(`${day}T23:59:59.999`).toISOString() : undefined;
}

export function toParams(f: EventFilters, page: number, pageSize: number): Record<string, string | number> {
  const out: Record<string, string | number> = { page, page_size: pageSize };
  const plain: Array<[keyof EventFilters, string]> = [
    ["q", "q"], ["module", "module"], ["action", "action"], ["entity_type", "entity_type"], ["outcome", "outcome"],
    ["actor", "actor"], ["tenant", "tenant"], ["entity_id", "entity_id"], ["case_id", "case_id"],
    ["correlation_id", "correlation_id"], ["chain_id", "chain_id"],
  ];
  for (const [key, param] of plain) {
    const value = f[key].trim();
    if (value) out[param] = value;
  }
  if (f.sequence.trim()) out.sequence = Number(f.sequence);
  const from = startOfDayIso(f.dateFrom);
  const to = endOfDayIso(f.dateTo);
  if (from) out.from = from;
  if (to) out.to = to;
  return out;
}

export function activeFilterCount(f: EventFilters): number {
  return (Object.keys(f) as Array<keyof EventFilters>).filter((k) => f[k].trim() !== "").length;
}

export const auditApi = {
  events: async (f: EventFilters, page: number, pageSize: number) =>
    (await api.get<EventPage>("/audit/v1/events", { params: toParams(f, page, pageSize) })).data,
  event: async (id: string) => (await api.get<AuditEventDetail>(`/audit/v1/events/${id}`)).data,
  sequence: async (chainId: string, sequence: number) =>
    (await api.get<SequenceInfo>(`/audit/v1/chains/${encodeURIComponent(chainId)}/sequence/${sequence}`)).data,
  facets: async () => (await api.get<Facets>("/audit/v1/events/facets")).data,
  demoEnabled: async () => (await api.get<{ enabled: boolean }>("/audit/v1/demo/status")).data.enabled,
  demoDelete: async (eventId: string) => (await api.post(`/audit/v1/demo/events/${eventId}/delete`)).data,
  demoBin: async () => (await api.get<{ items: RecycledEvent[] }>("/audit/v1/demo/recycle-bin")).data.items,
  demoRestore: async (binId: string) => (await api.post(`/audit/v1/demo/recycle-bin/${binId}/restore`)).data,
  chains: async () => (await api.get<{ items: ChainSummary[] }>("/audit/v1/chains")).data.items,
  status: async () => (await api.get<OpsStatus>("/audit/v1/ops/status")).data,
  verify: async (body: { chain_id?: string; tenant_id?: string } = {}) =>
    (await api.post<VerificationResult>("/audit/v1/verification/run", body)).data,
  runs: async (chainId: string) =>
    (await api.get<{ items: VerificationRun[] }>("/audit/v1/verification/runs", { params: { chain_id: chainId, limit: 8 } })).data.items,
};

// ── Signed checkpoints (Stage 2) ─────────────────────────────────────────────

export type AnchorState =
  | "VERIFIED" | "INVALID_HASH_CHAIN" | "INVALID_SIGNATURE" | "UNTRUSTED_SIGNER" | "MISSING_CHECKPOINT"
  | "CHECKPOINT_MISMATCH" | "UNSIGNED_EVENTS_PENDING" | "VERIFICATION_FAILED";

export interface Checkpoint {
  checkpoint_id: string;
  chain_id: string;
  tenant_id: string | null;
  checkpoint_number: number;
  start_sequence: number;
  end_sequence: number;
  event_count: number;
  last_event_hash: string;
  previous_checkpoint_hash: string;
  checkpoint_hash: string;
  created_at: string;
  signer_id: string;
  signing_key_id: string;
  key_version: number;
  signature_algorithm: string;
  payload_version: number;
  signature: string;
  storage_path: string;
  protected_at: string;
  canonical_payload?: string;
}

export interface TrustedKey {
  signer_id: string;
  key_id: string;
  key_version: number;
  environment_id: string;
  tenant_scope: string;
  public_key: string;
  fingerprint: string;
  algorithm: string;
  status: "ACTIVE" | "RETIRED";
  activated_at: string;
  retired_at: string | null;
}

export interface ChainProgress {
  chain_id: string;
  tenant_id: string | null;
  head_sequence: number;
  last_checkpoint_number: number | null;
  last_checkpoint_end_sequence: number | null;
  last_checkpoint_at: string | null;
  pending_events: number;
  event_threshold: number;
  events_until_threshold: number;
  interval_seconds: number;
  oldest_unsigned_at: string | null;
  seconds_until_interval: number | null;
  due: boolean;
  failures: number;
  last_error: string | null;
  alert_open: boolean;
  next_attempt_at: string | null;
}

export interface CheckpointAlert {
  id: number;
  chain_id: string | null;
  kind: string;
  severity: "CRITICAL" | "WARNING" | "INFO";
  message: string;
  raised_at: string;
  /** True only while the problem still exists; resolved alerts stay in the record but are not shown as current. */
  open: boolean;
}

export interface CheckpointStatus {
  signing_enabled: boolean;
  provider: string;
  environment_id: string;
  environment_label: string;
  server_time: string;
  storage_available: boolean;
  signer: { key_available?: boolean; reachable?: boolean; problem?: string | boolean | null; active_key?: TrustedKey | null } | null;
  registry: { ok: boolean; problem?: string; keys: TrustedKey[] } | null;
  chains: ChainProgress[];
  alerts: CheckpointAlert[];
}

export interface AnchoredFinding {
  state: AnchorState;
  code: string;
  message: string;
  checkpoint_number: number | null;
  source: string | null;
}

export interface AnchoredResult {
  chain_id: string;
  state: AnchorState;
  hash_chain_valid: boolean | null;
  signatures_valid: boolean | null;
  signer_trusted: boolean | null;
  anchored: boolean | null;
  pending_events: number;
  checkpoints_checked: number;
  last_checkpoint_number: number | null;
  findings: AnchoredFinding[];
  verified_at: string;
  duration_ms: number;
  run_id?: string | null;
}

export interface AnchoredRun {
  run_id: string;
  chain_id: string;
  trigger: "SCHEDULED" | "ON_DEMAND";
  requested_by: string | null;
  verified_at: string;
  state: AnchorState;
  hash_chain_valid: boolean | null;
  signatures_valid: boolean | null;
  signer_trusted: boolean | null;
  anchored: boolean | null;
  pending_events: number;
  checkpoints_checked: number;
  findings: AnchoredFinding[];
}

export interface CheckpointVerification {
  checkpoint_id: string;
  checkpoint_number: number;
  state: AnchorState;
  signature_valid: boolean | null;
  signer_trusted: boolean | null;
  stored_copy_matches: boolean | null;
  signing_key_id: string;
  key_version: number;
  findings: Array<{ code: string; message: string }>;
}

export const checkpointApi = {
  status: async () => (await api.get<CheckpointStatus>("/audit/v1/checkpoints/status")).data,
  list: async (chainId: string, page: number, pageSize: number) =>
    (await api.get<{ items: Checkpoint[]; total: number }>("/audit/v1/checkpoints", { params: { chain_id: chainId, page, page_size: pageSize } })).data,
  detail: async (id: string) => (await api.get<Checkpoint>(`/audit/v1/checkpoints/${id}`)).data,
  verifyOne: async (id: string) => (await api.post<CheckpointVerification>(`/audit/v1/checkpoints/${id}/verify`, {})).data,
  verifyChain: async (chainId: string) => (await api.post<AnchoredResult>("/audit/v1/checkpoints/verify", { chain_id: chainId })).data,
  history: async (chainId: string) =>
    (await api.get<{ items: AnchoredRun[] }>("/audit/v1/checkpoints/verifications", { params: { chain_id: chainId, limit: 8 } })).data.items,
  create: async (chainId: string) =>
    (await api.post<{ status: string; error?: string | null; error_code?: string | null }>("/audit/v1/checkpoints/create", { chain_id: chainId })).data,
  rotate: async () => (await api.post<TrustedKey>("/audit/v1/signing/rotate", {})).data,
};

/** Plain-language labels. "Verified" means the chain AND its signed anchors check out; it is never a claim of tamper-proofing. */
export const ANCHOR_LABEL: Record<AnchorState, string> = {
  VERIFIED: "Verified",
  INVALID_HASH_CHAIN: "Invalid hash chain",
  INVALID_SIGNATURE: "Invalid signature",
  UNTRUSTED_SIGNER: "Untrusted signer",
  MISSING_CHECKPOINT: "Missing checkpoint",
  CHECKPOINT_MISMATCH: "Checkpoint mismatch",
  UNSIGNED_EVENTS_PENDING: "Unsigned events pending",
  VERIFICATION_FAILED: "Verification failed",
};

export const ANCHOR_HELP: Record<AnchorState, string> = {
  VERIFIED: "The hash chain is intact and every signed checkpoint verifies against a trusted key and the independently stored copy.",
  INVALID_HASH_CHAIN: "The SHA-256 hash chain itself is broken: an event was changed, removed or reordered.",
  INVALID_SIGNATURE: "A checkpoint's digital signature does not verify: the checkpoint was altered or forged.",
  UNTRUSTED_SIGNER: "A checkpoint is signed by a key this installation does not trust.",
  MISSING_CHECKPOINT: "A signed checkpoint that should exist is missing from the database or from the protected store.",
  CHECKPOINT_MISMATCH: "The ledger no longer matches what a signed checkpoint committed to (history was rewritten or truncated), or the database copy differs from the protected copy.",
  UNSIGNED_EVENTS_PENDING: "Everything signed so far checks out. The newest events are not covered by a checkpoint yet.",
  VERIFICATION_FAILED: "Verification could not be completed (for example the protected checkpoint store or key registry is unavailable). Nothing is reported as verified.",
};

export type Tone = "good" | "bad" | "wait" | "neutral";
export function anchorTone(state: AnchorState): Tone {
  if (state === "VERIFIED") return "good";
  if (state === "UNSIGNED_EVENTS_PENDING") return "wait";
  return "bad";
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

// ── Presentation helpers ─────────────────────────────────────────────────────

export type IntegrityState = "valid" | "invalid" | "pending";

/** Accurate wording only: this is a hash-chain check, not a guarantee of tamper-proofing. */
export const INTEGRITY_LABEL: Record<IntegrityState, string> = {
  valid: "Chain valid",
  invalid: "Integrity violation",
  pending: "Verification pending",
};

export function integrityState(result: { status?: string } | null | undefined): IntegrityState {
  if (!result?.status) return "pending";
  return result.status === "VALID" ? "valid" : "invalid";
}

export const REASONS: Record<string, string> = {
  EVENT_HASH_MISMATCH: "An event's content no longer matches its recorded hash, so the record was modified after it was written.",
  PREVIOUS_HASH_MISMATCH: "An event's link to the event before it is broken.",
  EVENTS_REORDERED: "Events appear to have been reordered: an event points to a different position in the chain.",
  SEQUENCE_GAP: "One or more events are missing from the sequence.",
  GENESIS_MISMATCH: "The first event does not start from the chain's genesis hash.",
  CHAIN_HEAD_SEQUENCE_MISMATCH: "The chain head does not match the last recorded event; events may be missing from the end of the chain.",
  CHAIN_HEAD_HASH_MISMATCH: "The chain head hash does not match the last recorded event.",
  TENANT_MISMATCH: "An event belongs to a different tenant than the chain it is stored in.",
  ENVIRONMENT_MISMATCH: "An event or chain belongs to a different environment.",
  CHAIN_IDENTITY_MISMATCH: "The chain's identity does not match its environment and tenant.",
  UNSUPPORTED_HASH_VERSION: "An event was written with a hash version this service cannot verify.",
  CANONICALIZATION_ERROR: "An event contains a value that cannot be hashed deterministically.",
  CHAIN_NOT_FOUND: "No such chain exists.",
};

export function describeReason(code: string | null | undefined): string {
  if (!code) return "";
  return REASONS[code] ?? code;
}

export function shortHash(hash: string | null | undefined, size = 10): string {
  if (!hash) return "—";
  return hash.length > size * 2 + 1 ? `${hash.slice(0, size)}…${hash.slice(-size)}` : hash;
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/[_.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return `${date} · ${time}`;
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "never";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (Number.isNaN(seconds)) return "—";
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export function showValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value === "" ? "—" : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export interface ChangeRow {
  field: string;
  before: unknown;
  after: unknown;
  kind: "added" | "removed" | "changed" | "same";
}

/** Field-by-field comparison of previous_value / new_value (either may be null: a creation or a deletion). */
export function changeRows(previous: Record<string, unknown> | null, next: Record<string, unknown> | null): ChangeRow[] {
  const before = previous ?? {};
  const after = next ?? {};
  const fields = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  return fields.map((field) => {
    const hasBefore = field in before;
    const hasAfter = field in after;
    const same = hasBefore && hasAfter && JSON.stringify(before[field]) === JSON.stringify(after[field]);
    const kind: ChangeRow["kind"] = same ? "same" : !hasBefore ? "added" : !hasAfter ? "removed" : "changed";
    return { field, before: before[field], after: after[field], kind };
  });
}

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ── Archive & retention (Stage 3) ────────────────────────────────────────────

export type JobState = "ELIGIBLE" | "VERIFYING" | "EXPORTING" | "UPLOADING" | "VALIDATING" | "ARCHIVED" | "HOT_CLEANUP_ELIGIBLE" | "HOT_CLEANUP_COMPLETED" | "FAILED";

export interface ArchiveJob {
  job_id: string;
  chain_id: string;
  tenant_id: string | null;
  archive_number: number;
  start_sequence: number;
  end_sequence: number;
  event_count: number;
  state: JobState;
  resume_state: JobState | null;
  attempts: number;
  last_error_code: string | null;
  last_error: string | null;
  next_attempt_at: string | null;
  cleanup_after: string | null;
  updated_at: string;
}

export interface ArchiveEntry {
  archive_id: string;
  chain_id: string;
  tenant_id: string | null;
  archive_number: number;
  start_sequence: number;
  end_sequence: number;
  event_count: number;
  size_bytes: number;
  uncompressed_bytes: number;
  ratio: number | null;
  compression_algorithm: string;
  encryption_algorithm: string;
  first_occurred_at: string;
  last_occurred_at: string;
  modules: string[];
  lock_mode: string | null;
  lock_retain_until: string | null;
  retention_until: string | null;
  cleanup_approved_at: string | null;
  created_at: string;
  verifications?: ArchiveVerificationRecord[];
}

export interface ArchiveVerificationRecord {
  kind: string;
  state: "VERIFIED" | "FAILED";
  code: string | null;
  verified_at: string;
  requested_by: string | null;
}

export interface ArchiveVerificationResult {
  archive_id: string;
  state: "VERIFIED" | "FAILED";
  deep: boolean;
  findings: Array<{ code: string; message: string }>;
  details: Record<string, unknown>;
  duration_ms: number;
}

export interface ArchivePolicy {
  category: string;
  hot_retention_months: number;
  cold_retention_years: number | null;
  allow_hot_cleanup: boolean;
  approved: boolean;
  scope: string;
}

export interface LegalHold {
  hold_id: string;
  tenant_id: string | null;
  chain_id: string | null;
  reason: string;
  case_reference: string | null;
  placed_by: string;
  placed_at: string;
  active: boolean;
}

export interface ArchiveStatus {
  enabled: boolean;
  config: { hot_retention_months: number; schedule: string; compression: string; encryption: string; bucket: string; auto_hot_cleanup: boolean;
            cleanup_mode: string; cleanup_safety_days: number; object_lock_mode: string; object_lock_days: number; test_mode: boolean };
  storage: { reachable: boolean; versioning: boolean | null; object_lock: boolean | null; private: boolean | null; problem: string | null } | null;
  master_key: { available: boolean } | null;
  summary: { archives: number; archived_events: number; stored_bytes: number; uncompressed_bytes: number; compression_ratio: number | null;
             first_event_at: string | null; last_event_at: string | null; last_archived_at: string | null; cleanup_approved: number; jobs: Record<string, number> };
  hot: { events: number; oldest_event_at: string | null; newest_recorded_at: string | null };
  pending_jobs: ArchiveJob[];
  failed_jobs: ArchiveJob[];
  recent_jobs: ArchiveJob[];
  holds: LegalHold[];
  policies: ArchivePolicy[];
  partitions: Array<{ partition: string; month: string; events: number; bytes: number }> | null;
}

export interface RetrievalCriteria {
  chain_id?: string; entity_id?: string; actor_id?: string; case_id?: string; module?: string; action?: string; since?: string; until?: string;
  from_sequence?: number; to_sequence?: number;
}

export interface Retrieval {
  retrieval_id: string;
  state: "PENDING" | "RUNNING" | "READY" | "FAILED" | "EXPIRED";
  criteria: RetrievalCriteria;
  archives: Array<{ archive_id: string; archive_number: number }>;
  event_count: number;
  verified: boolean | null;
  error: string | null;
  created_at: string;
  expires_at: string;
}

export interface ArchivedEvent extends AuditEvent {
  archived: true;
  verified: true;
  archive_id: string;
}

export interface CleanupPartition {
  partition: string; month: string; events: number; status: "REMOVABLE" | "BLOCKED" | "KEEP" | "EMPTY"; reasons: string[]; action?: string;
}

export const archiveApi = {
  status: async () => (await api.get<ArchiveStatus>("/audit/v1/archive/status")).data,
  catalog: async (page: number, pageSize: number, chainId?: string) =>
    (await api.get<{ items: ArchiveEntry[]; total: number }>("/audit/v1/archive/catalog", { params: { page, page_size: pageSize, chain_id: chainId || undefined } })).data,
  detail: async (id: string) => (await api.get<ArchiveEntry>(`/audit/v1/archive/catalog/${id}`)).data,
  verify: async (id: string, deep: boolean) => (await api.post<ArchiveVerificationResult>("/audit/v1/archive/verify", { archive_id: id, deep })).data,
  evidence: async (id: string) => (await api.get<Blob>(`/audit/v1/archive/catalog/${id}/evidence`, { responseType: "blob" })).data,
  retry: async (jobId: string) => (await api.post(`/audit/v1/archive/jobs/${jobId}/retry`, {})).data,
  plan: async (dryRun: boolean) => (await api.post<{ dry_run: boolean; planned: Array<{ chain_id: string; start_sequence: number; end_sequence: number }> }>("/audit/v1/archive/run", { dry_run: dryRun })).data,
  retrieve: async (criteria: RetrievalCriteria) => (await api.post<Retrieval>("/audit/v1/archive/retrievals", criteria)).data,
  retrieval: async (id: string) => (await api.get<Retrieval>(`/audit/v1/archive/retrievals/${id}`)).data,
  retrievalEvents: async (id: string, page: number, pageSize: number) =>
    (await api.get<{ items: ArchivedEvent[]; total: number }>(`/audit/v1/archive/retrievals/${id}/events`, { params: { page, page_size: pageSize } })).data,
  placeHold: async (body: { tenant_id?: string; chain_id?: string; reason: string; case_reference?: string }) => (await api.post<LegalHold>("/audit/v1/archive/holds", body)).data,
  releaseHold: async (id: string, reason: string) => (await api.post<LegalHold>(`/audit/v1/archive/holds/${id}/release`, { reason })).data,
  cleanupPlan: async () => (await api.get<{ partitions: CleanupPartition[]; automatic: boolean; mode: string }>("/audit/v1/archive/cleanup/plan")).data,
  cleanup: async (dryRun: boolean) =>
    (await api.post<{ removed_months: string[]; partitions: CleanupPartition[] }>("/audit/v1/archive/cleanup", dryRun ? { dry_run: true } : { dry_run: false, confirm: "REMOVE-HOT-PARTITIONS" })).data,
};

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export const JOB_LABEL: Record<JobState, string> = {
  ELIGIBLE: "Planned", VERIFYING: "Verifying", EXPORTING: "Exporting", UPLOADING: "Uploading", VALIDATING: "Validating", ARCHIVED: "Archived",
  HOT_CLEANUP_ELIGIBLE: "Ready for hot cleanup", HOT_CLEANUP_COMPLETED: "Hot copy removed", FAILED: "Failed",
};
