// Shared CORS headers for Edge Functions (Deno). Kept intentionally
// permissive on origin since every function verifies its own auth (JWT or
// the /p/<token> deep-link secret) rather than relying on CORS for security
// (ARCHITECTURE.md §8, §12).
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function handleCorsPreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}
