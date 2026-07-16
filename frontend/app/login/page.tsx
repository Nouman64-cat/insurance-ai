"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import api from "@/app/services/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

      const { access_token } = response.data;

      // Save token in localStorage
      localStorage.setItem("jwt_token", access_token);

      // Set the default authorization header for subsequent API calls
      api.defaults.headers.common["Authorization"] = `Bearer ${access_token}`;

      // Retrieve and save the user profile details to get their tenant_id and role
      const profileResponse = await api.get<{
        email: string;
        full_name: string;
        tenant_id: string;
        role_id: string;
        role_name: string;
      }>("/auth/me", {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      });

      const userTenantId = profileResponse.data.tenant_id;

      // Save user details & active tenant in localStorage
      localStorage.setItem("tenant_id", userTenantId);
      localStorage.setItem("user_email", profileResponse.data.email);
      localStorage.setItem("user_name", profileResponse.data.full_name);
      localStorage.setItem("user_role", profileResponse.data.role_name);

      // Apply the active tenant header for subsequent client actions
      api.defaults.headers.common["X-Tenant-Id"] = userTenantId;

      // Redirect to the dashboard
      router.push("/");
    } catch (err: any) {
      setError(
        err.response?.data?.detail ??
        err.message ??
        "Invalid credentials or connection error."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-slate-950 overflow-hidden font-sans">
      {/* ── Background decoration elements ── */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[60%] rounded-full bg-blue-900/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[60%] rounded-full bg-violet-900/10 blur-[120px] pointer-events-none" />

      {/* ── Main card container ── */}
      <div className="relative w-full max-w-md mx-4 z-10">
        <div className="card bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 p-8 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
          
          {/* Logo / Header */}
          <div className="flex flex-col items-center mb-8">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20 mb-4 animate-pulse">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6 text-white">
                <path fillRule="evenodd" d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z" clipRule="evenodd" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">
              insurance<span className="text-blue-500">-ai</span>
            </h1>
            <p className="text-xs text-slate-400 mt-1">Underwriting & Decision Portal</p>
          </div>

          {/* Form */}
          <form onSubmit={handleLogin} className="space-y-5">
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-400 font-medium">
                {error}
              </div>
            )}

            {/* Email Address */}
            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-xs font-semibold text-slate-300">
                Email Address
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@adamjeelife.com"
                className="w-full bg-slate-800/40 border border-slate-700/50 rounded-lg px-3.5 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-all"
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label htmlFor="password" className="block text-xs font-semibold text-slate-300">
                  Password
                </label>
              </div>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-800/40 border border-slate-700/50 rounded-lg px-3.5 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500 transition-all"
              />
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white font-semibold text-sm py-2.5 rounded-lg transition-all shadow-md shadow-blue-500/10 hover:shadow-lg hover:shadow-blue-500/20 active:scale-[0.98]"
            >
              {loading ? (
                <>
                  <svg className="animate-spin -ml-1 mr-3 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Authenticating...
                </>
              ) : (
                "Sign In"
              )}
            </button>
          </form>

          {/* Footer inside Card */}
          <div className="mt-6 pt-6 border-t border-slate-800/60 text-center">
            <p className="text-[10px] text-slate-500">
              Authorized personnel only. All access is logged and monitored.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
