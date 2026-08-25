export function cfg(env) {
  const n = (k, d) => Number(env[k] ?? d);
  return {
    maxFiles: n("MAX_FILES_PER_BATCH", 20),
    maxPages: n("MAX_TOTAL_PAGES", 1000),
    concurrency: n("PROCESS_CONCURRENCY", 2),
    chunkSize: n("CHUNK_SIZE", 20),
    maxFileBytes: n("MAX_FILE_SIZE_MB", 500) * 1024 * 1024,
    maxOutputBytes: n("MAX_JOB_OUTPUT_MB", 500) * 1024 * 1024,
    retentionHours: n("JOB_RETENTION_HOURS", 24),
    defaultModel: env.DEFAULT_GEMINI_MODEL || "gemini-3.5-flash",
    geminiBase: env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta"
  };
}
export function jsonError(message, status=400, code="BAD_REQUEST") {
  return Response.json({error: message, code}, {status});
}
export function safeFilename(name) {
  const base = String(name || "document.pdf").replace(/[^\w.\-() ]+/g, "_").replace(/\s+/g," ").trim();
  const out = base || "document.pdf";
  return out.toLowerCase().endsWith(".pdf") ? out : `${out}.pdf`;
}
export function safeId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0,80);
}
export function now() { return new Date().toISOString(); }
export function uid(prefix="job") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-","")}`;
}
export async function sha256Hex(data) {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
export function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
