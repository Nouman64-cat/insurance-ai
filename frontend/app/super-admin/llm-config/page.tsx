"use client";

import { useState, useEffect, Suspense } from "react";
import api from "@/app/services/api";

// ── Types ────────────────────────────────────────────────────────────────────
type Role = "primary" | "fallback" | "disabled";

interface ProviderStatus {
  provider: string;
  model_name: string;
  role: Role;
  has_key: boolean;
  api_key_last4: string | null;
  updated_at: string;
}

interface ConfigResponse {
  encryption_available: boolean;
  providers: ProviderStatus[];
}

interface TestResult {
  ok: boolean;
  detail: string;
  latency_ms: number;
}

const PROVIDER_META: Record<
  string,
  { label: string; blurb: string; keyHint: string; docs: string }
> = {
  gemini: {
    label: "Google Gemini",
    blurb: "Google AI Studio / Generative Language API",
    keyHint: "AIza… or AQ.…",
    docs: "https://aistudio.google.com/apikey",
  },
  openai: {
    label: "OpenAI",
    blurb: "GPT-4o / GPT-4o-mini via the OpenAI API",
    keyHint: "sk-…",
    docs: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    label: "Anthropic Claude",
    blurb: "Claude models via the Anthropic API",
    keyHint: "sk-ant-…",
    docs: "https://console.anthropic.com/settings/keys",
  },
};

const ROLE_LABEL: Record<Role, string> = {
  primary: "Primary",
  fallback: "Fallback",
  disabled: "Disabled",
};

// ── Per-provider card ────────────────────────────────────────────────────────
function ProviderCard({
  status,
  otherRoles,
  onSaved,
}: {
  status: ProviderStatus;
  otherRoles: Record<string, Role>;
  onSaved: (next: ProviderStatus) => void;
}) {
  const meta = PROVIDER_META[status.provider] ?? {
    label: status.provider,
    blurb: "",
    keyHint: "",
    docs: "",
  };

  const [model, setModel] = useState(status.model_name);
  const [role, setRole] = useState<Role>(status.role);
  const [newKey, setNewKey] = useState("");
  const [editingKey, setEditingKey] = useState(!status.has_key);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [err, setErr] = useState("");
  const [savedNote, setSavedNote] = useState("");

  useEffect(() => {
    setModel(status.model_name);
    setRole(status.role);
    setEditingKey(!status.has_key);
    setNewKey("");
  }, [status]);

  const dirty =
    model !== status.model_name ||
    role !== status.role ||
    (editingKey && newKey.trim() !== "");

  const roleTaken = (r: Role) =>
    (r === "primary" || r === "fallback") &&
    Object.entries(otherRoles).some(
      ([p, pr]) => p !== status.provider && pr === r,
    );

  const save = async () => {
    setErr("");
    setSavedNote("");
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (model !== status.model_name) body.model_name = model.trim();
      if (role !== status.role) body.role = role;
      if (editingKey && newKey.trim() !== "") body.api_key = newKey.trim();
      const resp = await api.put<ProviderStatus>(
        `/platform/llm-config/${status.provider}`,
        body,
      );
      onSaved(resp.data);
      setSavedNote("Saved.");
      setTest(null);
    } catch (e: any) {
      setErr(e.message ?? "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setErr("");
    setTesting(true);
    setTest(null);
    try {
      const body: Record<string, unknown> = {};
      if (editingKey && newKey.trim() !== "") body.api_key = newKey.trim();
      if (model.trim()) body.model_name = model.trim();
      const resp = await api.post<TestResult>(
        `/platform/llm-config/${status.provider}/test`,
        body,
      );
      setTest(resp.data);
    } catch (e: any) {
      setTest({ ok: false, detail: e.message ?? "Test failed.", latency_ms: 0 });
    } finally {
      setTesting(false);
    }
  };

  const roleBadge =
    status.role === "primary"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : status.role === "fallback"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-slate-100 text-slate-500 border-slate-200";

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-900">{meta.label}</h3>
            <span
              className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${roleBadge}`}
            >
              {ROLE_LABEL[status.role]}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">{meta.blurb}</p>
        </div>
        <span
          className={`text-[11px] font-medium px-2 py-1 rounded-full ${
            status.has_key
              ? "bg-slate-100 text-slate-600"
              : "bg-red-50 text-red-500"
          }`}
        >
          {status.has_key ? `key ••••${status.api_key_last4}` : "no key"}
        </span>
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Role */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">
            Role
          </label>
          <div className="flex gap-2">
            {(["primary", "fallback", "disabled"] as Role[]).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all ${
                  role === r
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
                }`}
              >
                {ROLE_LABEL[r]}
                {roleTaken(r) && role !== r && (
                  <span className="ml-1 text-[10px] opacity-70">(reassign)</span>
                )}
              </button>
            ))}
          </div>
          {roleTaken(role) && role !== status.role && (
            <p className="text-[11px] text-amber-600 mt-1">
              Another provider is currently {ROLE_LABEL[role].toLowerCase()} — saving moves it here.
            </p>
          )}
        </div>

        {/* Model */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">
            Model
          </label>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            placeholder="model id"
          />
        </div>

        {/* API key */}
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">
            API key
          </label>
          {editingKey ? (
            <input
              type="password"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              autoComplete="off"
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              placeholder={meta.keyHint || "paste key"}
            />
          ) : (
            <div className="flex items-center gap-2">
              <span className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-500 font-mono">
                ••••••••••••{status.api_key_last4}
              </span>
              <button
                type="button"
                onClick={() => setEditingKey(true)}
                className="px-3 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50 rounded-lg"
              >
                Replace
              </button>
            </div>
          )}
          {editingKey && status.has_key && (
            <button
              type="button"
              onClick={() => {
                setEditingKey(false);
                setNewKey("");
              }}
              className="text-[11px] text-slate-400 hover:text-slate-600 mt-1"
            >
              Cancel key change
            </button>
          )}
          {meta.docs && (
            <a
              href={meta.docs}
              target="_blank"
              rel="noreferrer"
              className="block text-[11px] text-blue-500 hover:underline mt-1"
            >
              Where to get a key ↗
            </a>
          )}
        </div>

        {/* Test result */}
        {test && (
          <div
            className={`text-xs rounded-lg px-3 py-2 border ${
              test.ok
                ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                : "bg-red-50 border-red-200 text-red-600"
            }`}
          >
            {test.ok ? "✓ " : "✕ "}
            {test.detail}
            {test.latency_ms > 0 && (
              <span className="opacity-60"> ({test.latency_ms} ms)</span>
            )}
          </div>
        )}
        {err && (
          <div className="text-xs rounded-lg px-3 py-2 border bg-red-50 border-red-200 text-red-600">
            {err}
          </div>
        )}
        {savedNote && !dirty && (
          <div className="text-xs text-emerald-600 font-medium">{savedNote}</div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-all disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={runTest}
            disabled={testing || (!status.has_key && newKey.trim() === "")}
            className="px-4 py-2 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:border-slate-300 transition-all disabled:opacity-40"
          >
            {testing ? "Testing…" : "Test key"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────
function LLMConfigContent() {
  const [authorized, setAuthorized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [cfg, setCfg] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const role = localStorage.getItem("user_role");
    if (role !== "SuperAdmin") {
      setAuthorized(false);
      setLoading(false);
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const resp = await api.get<ConfigResponse>("/platform/llm-config");
      setCfg(resp.data);
    } catch (err: any) {
      setError(err.message ?? "Failed to load configuration.");
    } finally {
      setLoading(false);
    }
  };

  const onSaved = (next: ProviderStatus) => {
    setCfg((prev) =>
      prev
        ? {
            ...prev,
            providers: prev.providers.map((p) =>
              // saving a role can demote another provider — reload for truth,
              // but optimistically update the one we changed
              p.provider === next.provider ? next : p,
            ),
          }
        : prev,
    );
    // pull the authoritative state (role reassignments elsewhere)
    load();
  };

  if (!authorized) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 bg-slate-950 text-center font-sans min-h-screen">
        <div className="max-w-md p-6 bg-slate-900 border border-slate-800 rounded-xl shadow-xl">
          <h1 className="text-xl font-bold text-white mb-2">Access Denied</h1>
          <p className="text-slate-400 text-sm mb-6">
            This page is restricted to platform SuperAdmins.
          </p>
          <a
            href="/"
            className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm px-5 py-2.5 rounded-lg transition-all"
          >
            Back to app
          </a>
        </div>
      </div>
    );
  }

  const primary = cfg?.providers.find((p) => p.role === "primary");
  const fallback = cfg?.providers.find((p) => p.role === "fallback");
  const otherRoles: Record<string, Role> = Object.fromEntries(
    (cfg?.providers ?? []).map((p) => [p.provider, p.role]),
  );

  return (
    <div className="px-6 py-5 space-y-5 max-w-screen-lg mx-auto w-full font-sans">
      <div>
        <h1 className="text-xl font-bold text-slate-900 tracking-tight">
          LLM Configuration
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Primary and fallback chat models for the AI agent and risk engine.
          Keys are encrypted at rest and take effect within ~60 seconds — no
          restart.
        </p>
      </div>

      {cfg && !cfg.encryption_available && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">
          <b>CONFIG_ENCRYPTION_KEY is not set.</b> API keys cannot be saved until
          it is configured in the environment. Generate one with{" "}
          <code className="text-xs bg-red-100 px-1 py-0.5 rounded">
            python -c &quot;from cryptography.fernet import Fernet;
            print(Fernet.generate_key().decode())&quot;
          </code>
          .
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600 font-medium">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-20 flex flex-col items-center justify-center gap-3">
          <svg
            className="animate-spin h-7 w-7 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span className="text-xs text-slate-400">Loading configuration…</span>
        </div>
      ) : (
        cfg && (
          <>
            <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-600">
              <span className="font-semibold text-slate-800">Active routing:</span>{" "}
              {primary ? (
                <>
                  {PROVIDER_META[primary.provider]?.label ?? primary.provider}
                  <span className="text-slate-400"> ({primary.model_name})</span>
                </>
              ) : (
                <span className="text-amber-600">
                  no primary set — services fall back to env vars
                </span>
              )}
              {fallback && (
                <>
                  {"  →  "}
                  {PROVIDER_META[fallback.provider]?.label ?? fallback.provider}
                  <span className="text-slate-400"> ({fallback.model_name})</span>
                </>
              )}
            </div>

            <div className="grid gap-4 md:grid-cols-1">
              {cfg.providers.map((p) => (
                <ProviderCard
                  key={p.provider}
                  status={p}
                  otherRoles={otherRoles}
                  onSaved={onSaved}
                />
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
}

export default function LLMConfigPage() {
  return (
    <Suspense fallback={null}>
      <LLMConfigContent />
    </Suspense>
  );
}
