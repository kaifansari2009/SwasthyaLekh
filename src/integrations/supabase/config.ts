// Central Supabase configuration with safe fallback defaults for production deployment
export const DEFAULT_SUPABASE_URL = "https://jbbhqtjhfajohpwwywka.supabase.co";
export const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_k_2LpMcf6aH-XMyiuDmWBA_kSyUrSls";
export const DEFAULT_SUPABASE_PROJECT_ID = "jbbhqtjhfajohpwwywka";

export function resolveSupabaseUrl(): string {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    if (import.meta.env.VITE_SUPABASE_URL) return import.meta.env.VITE_SUPABASE_URL;
    if (import.meta.env["VITE_SUPABASE_URL"]) return import.meta.env["VITE_SUPABASE_URL"];
  }
  if (typeof process !== "undefined" && process.env) {
    if (process.env["SUPABASE_URL"]) return process.env["SUPABASE_URL"];
    if (process.env["VITE_SUPABASE_URL"]) return process.env["VITE_SUPABASE_URL"];
  }
  return DEFAULT_SUPABASE_URL;
}

export function resolveSupabasePublishableKey(): string {
  if (typeof import.meta !== "undefined" && import.meta.env) {
    if (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) return import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    if (import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"]) return import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  }
  if (typeof process !== "undefined" && process.env) {
    if (process.env["SUPABASE_PUBLISHABLE_KEY"]) return process.env["SUPABASE_PUBLISHABLE_KEY"];
    if (process.env["VITE_SUPABASE_PUBLISHABLE_KEY"]) return process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
    if (process.env["SUPABASE_ANON_KEY"]) return process.env["SUPABASE_ANON_KEY"];
  }
  return DEFAULT_SUPABASE_PUBLISHABLE_KEY;
}

