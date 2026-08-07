import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Shows up in the browser console, not to players — copy .env.example to
  // .env and fill in your project's URL + anon key (both are safe to expose
  // in client code; Row Level Security is what actually protects the data).
  console.warn(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — see .env.example"
  );
}

export const supabase = createClient(url, anonKey);
