import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null | undefined;

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
  );
}

export function getBrowserSupabase() {
  if (browserClient !== undefined) return browserClient;
  if (typeof window === "undefined" || !isSupabaseConfigured()) {
    browserClient = null;
    return browserClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim();

  browserClient = createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
    },
    global: {
      fetch: (input, init = {}) => {
        // 远程会话不可用时应尽快切到本地存储，不能把整个聊天界面锁住。
        const timeoutSignal = AbortSignal.timeout(4_000);
        const signal = init.signal
          ? AbortSignal.any([init.signal, timeoutSignal])
          : timeoutSignal;

        return fetch(input, { ...init, signal });
      },
    },
  });

  return browserClient;
}
