"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { safeNext, startSso } from "@/lib/sso";
import api from "@/app/services/api";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { tx } from "@/lib/i18n/tx";

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // API expects OAuth2 form data: username and password.
      const formData = new URLSearchParams();
      formData.append("username", email);
      formData.append("password", password);

      const response = await api.post<{ access_token: string; token_type: string }>(
        "/auth/token",
        formData,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const { access_token, first_login } = response.data as { access_token: string; first_login?: boolean };

      // Retrieve user profile details to verify role before modifying portal session
      const profileResponse = await api.get<{
        email: string;
        full_name: string;
        tenant_id: string | null;
        role_id: string;
        role_name: string;
        branch_id: string | null;
      }>("/auth/me", {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      });

      // Save token in localStorage
      localStorage.setItem("jwt_token", access_token);
      // Single sign-on: also publish it for the Automation Chat app, so opening that app needs no second sign-in.
      await startSso(access_token);

      // Set the default authorization header for subsequent API calls
      api.defaults.headers.common["Authorization"] = `Bearer ${access_token}`;

      // null for SuperAdmins — they sit above tenants.
      const userTenantId = profileResponse.data.tenant_id;

      // Save user details & active tenant in localStorage
      if (userTenantId) {
        localStorage.setItem("tenant_id", userTenantId);
      } else {
        localStorage.removeItem("tenant_id");
        localStorage.removeItem("tenant_name");
      }
      localStorage.setItem("user_email", profileResponse.data.email);
      localStorage.setItem("user_name", profileResponse.data.full_name);
      localStorage.setItem("user_role", profileResponse.data.role_name);
      // First ever sign-in of an Admin: the portal starts its welcome tour (components/tour/AdminTour.tsx).
      if (first_login && profileResponse.data.role_name === "Admin") {
        localStorage.setItem("tour_pending", profileResponse.data.email);
      }
      if (profileResponse.data.branch_id) {
        localStorage.setItem("branch_id", profileResponse.data.branch_id);
      } else {
        localStorage.removeItem("branch_id");
      }

      // Apply the active tenant header for subsequent client actions
      if (userTenantId) {
        api.defaults.headers.common["X-Tenant-Id"] = userTenantId;
      } else {
        delete api.defaults.headers.common["X-Tenant-Id"];
      }

      // A validated ?next= (SSO / Automation Chat return) wins; otherwise only Admin
      // lands on the executive dashboard ("/") and other roles go to their work consoles.
      const back = safeNext(new URLSearchParams(window.location.search).get("next"));
      const userRoleName: string = String(profileResponse.data.role_name ?? "").replace(/\s+/g, "") === "ClaimsManager" ? "ClaimsManager" : profileResponse.data.role_name;
      let targetPath = "/";
      if (userRoleName === "SuperAdmin") {
        targetPath = "/super-admin/tenants";
      } else if (userRoleName === "Agent" || userRoleName === "Broker") {
        targetPath = "/proposal";
      } else if (userRoleName === "ClaimsManager") {
        // Claims managers work in their own portal.
        targetPath = (process.env.NEXT_PUBLIC_CLAIMS_URL || "http://localhost:3011") + "/claims/dashboard";
      } else if (userRoleName === "Finance") {
        targetPath = "/finance";
      } else if (userRoleName === "ClaimsAdjuster") {
        targetPath = "/claims";
      } else if (["Medical Underwriter", "Financial Underwriter"].includes(userRoleName)) {
        targetPath = (process.env.NEXT_PUBLIC_UNDERWRITING_URL || "http://localhost:3005") + "/underwriting";
      } else if (userRoleName !== "Admin") {
        targetPath = "/cases";
      }
      window.location.href = back ?? targetPath;
    } catch (err: any) {
      setError(
        err.response?.data?.detail ??
        err.message ??
        t("login.failed")
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-slate-50 overflow-hidden font-sans">
      <div className="absolute top-4 end-4 z-20">
        <LanguageSwitcher />
      </div>

      {/* ── Background decoration elements ── */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[60%] rounded-full bg-blue-200/40 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[60%] rounded-full bg-blue-200/40 blur-[120px] pointer-events-none" />

      {/* ── Main card container ── */}
      <div className="relative w-full max-w-md mx-4 z-10">
        <div className="card bg-white border border-slate-200 p-8 rounded-2xl shadow-[0_20px_50px_rgba(15,23,42,0.08)]">
          
          {/* Logo / Header */}
          <div className="flex flex-col items-center mb-8">
            <img src="/logo-full.png" alt="GetInsuredAI, powered by Rizviz" className="w-[200px] max-w-full h-auto object-contain mb-3" />
            <p className="text-xs text-slate-500 mt-1">{t("login.subtitle")}</p>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} className="space-y-5">
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 font-medium">
                {error}
              </div>
            )}

            {/* Email Address */}
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-xs font-semibold text-slate-700">
                {t("login.email")}
              </label>
              <input
                id="email"
                type="email"
                dir="ltr"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={tx("name@adamjeelife.com")}
                className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-all"
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label htmlFor="password" className="block text-xs font-semibold text-slate-700">
                  {t("login.password")}
                </label>
              </div>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  dir="ltr"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-white border border-slate-300 rounded-lg px-3.5 py-2 pr-10 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? t("login.hidePassword") : t("login.showPassword")}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 hover:text-slate-700 transition-colors"
                >
                  {showPassword ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-[18px] h-[18px]">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-[18px] h-[18px]">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white font-semibold text-sm py-2.5 rounded-lg transition-all shadow-md shadow-blue-500/10 hover:shadow-lg hover:shadow-blue-500/20 active:scale-[0.98]"
            >
              {loading ? (
                <>
                  <svg className="animate-spin -ms-1 me-3 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  {t("login.authenticating")}
                </>
              ) : (
                t("login.signIn")
              )}
            </button>
          </form>

          {/* Footer inside Card */}
          <div className="mt-6 pt-6 border-t border-slate-200 text-center">
            <p className="text-[10px] text-slate-500">
              {t("login.notice")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
