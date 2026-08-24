export function authorize(request, env) {
  const secret = env.API_AUTH_SECRET;
  if (!secret) return true;
  const h=request.headers.get("Authorization") || "";
  return h === `Bearer ${secret}`;
}
export function corsHeaders(env){
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods":"GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type,Authorization",
    "Access-Control-Expose-Headers":"Content-Disposition,Content-Length",
    "Vary":"Origin"
  };
}
