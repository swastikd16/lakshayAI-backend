import { createClient } from "@supabase/supabase-js";
import { env } from "./env";

export const supabaseService = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});
