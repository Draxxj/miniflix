import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 10000;
const VCDN_BASE_URL = "https://cdn.vcdn.me";
const ADMIN_EMAIL = "admmotoshop58@gmail.com";

const required = ["VCDN_API_KEY", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"];
for (const key of required) {
  if (!process.env[key]) console.warn(`Missing environment variable: ${key}`);
}

const supabase = createClient(
  process.env.SUPABASE_URL || "https://example.supabase.co",
  process.env.SUPABASE_PUBLISHABLE_KEY || "missing-key"
);

app.use(cors({ origin: true, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "100kb" }));

async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return res.status(401).json({ error: "unauthorized", message: "Entre na sua conta MiniFlix novamente." });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "invalid_session", message: "Sessão inválida ou expirada. Entre novamente." });
    if (String(data.user.email || "").trim().toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ error: "admin_only", message: "Somente a conta administradora pode enviar vídeos." });
    }
    req.user = data.user;
    next();
  } catch (error) {
    console.error("Auth error:", error);
    return res.status(500).json({ error: "auth_error", message: "Não foi possível validar a conta." });
  }
}

async function vcdnRequest(path, options = {}) {
  if (!process.env.VCDN_API_KEY) throw new Error("A variável VCDN_API_KEY não está configurada no Render.");
  const response = await fetch(`${VCDN_BASE_URL}${path}`, {
    ...options,
    headers: {
      "X-API-Key": process.env.VCDN_API_KEY,
      Accept: "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(body.message || body.error || `VCDN respondeu com HTTP ${response.status}`);
    error.status = response.status;
    error.payload = body;
    throw error;
  }
  return body;
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "miniflix-backend" }));

// Only the authenticated MiniFlix administrator can initialize an upload.
app.post("/api/videos/init", requireAdmin, async (req, res) => {
  try {
    const { filename, size, contentType, title } = req.body || {};
    if (!filename || !Number.isSafeInteger(Number(size)) || Number(size) <= 0) {
      return res.status(400).json({ error: "invalid_upload", message: "Nome ou tamanho do vídeo inválido." });
    }
    const allowed = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"];
    const mime = allowed.includes(contentType) ? contentType : "video/mp4";
    const result = await vcdnRequest("/api/v1/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: String(filename).slice(0, 180), size: Number(size), contentType: mime, title: String(title || filename).slice(0, 180), ladderProfile: "standard" })
    });
    const uploadId = result.uploadId || result.upload_id || result.videoId || result.video_id;
    if (!uploadId) return res.status(502).json({ error: "invalid_vcdn_response", message: "A VCDN não retornou um ID de envio." });
    return res.json({ uploadId, videoId: result.videoId || result.video_id || uploadId, status: result.status || "uploading" });
  } catch (error) {
    console.error("VCDN init error:", error.payload || error.message);
    return res.status(error.status || 502).json({ error: "vcdn_init_failed", message: error.message || "Não foi possível iniciar o envio." });
  }
});

// Forward raw chunks so the VCDN key never reaches the browser. Each chunk is 8 MiB from the frontend.
app.post("/api/videos/:uploadId/chunk", requireAdmin, express.raw({ type: "application/octet-stream", limit: "10mb" }), async (req, res) => {
  try {
    const uploadId = String(req.params.uploadId || "");
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(uploadId)) return res.status(400).json({ error: "invalid_upload_id", message: "ID de envio inválido." });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "empty_chunk", message: "A parte do vídeo está vazia." });
    const result = await vcdnRequest(`/api/v1/upload/${encodeURIComponent(uploadId)}/chunk`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: req.body
    });
    return res.json(result || { ok: true });
  } catch (error) {
    console.error("VCDN chunk error:", error.payload || error.message);
    return res.status(error.status || 502).json({ error: "vcdn_chunk_failed", message: error.message || "Não foi possível enviar uma parte do vídeo." });
  }
});

app.post("/api/videos/complete", requireAdmin, async (req, res) => {
  try {
    const uploadId = String(req.body?.uploadId || "");
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(uploadId)) return res.status(400).json({ error: "invalid_upload_id", message: "ID de envio inválido." });
    const result = await vcdnRequest("/api/v1/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId })
    });
    return res.json({ ...result, uploadId, videoId: result.videoId || result.video_id || uploadId, status: result.status || "processing" });
  } catch (error) {
    console.error("VCDN complete error:", error.payload || error.message);
    return res.status(error.status || 502).json({ error: "vcdn_complete_failed", message: error.message || "A VCDN não confirmou a conclusão do envio." });
  }
});

// Public catalog playback: return a short-lived signed HLS URL. The API key stays on the server.
app.get("/api/videos/:videoId/playback", async (req, res) => {
  try {
    const videoId = String(req.params.videoId || "");
    if (!/^[0-9a-fA-F-]{20,60}$/.test(videoId)) return res.status(400).json({ error: "invalid_video_id", message: "ID do vídeo inválido." });
    const result = await vcdnRequest(`/api/v1/videos/${encodeURIComponent(videoId)}/playback-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttlSeconds: 3600 })
    });
    return res.json({ streamUrl: result.streamUrl || result.stream_url, exp: result.exp, videoId: result.videoId || videoId, status: result.status });
  } catch (error) {
    console.error("VCDN playback error:", error.payload || error.message);
    return res.status(error.status || 502).json({ error: "playback_unavailable", message: error.message || "O vídeo ainda pode estar sendo processado. Tente novamente em alguns minutos." });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`MiniFlix backend listening on ${PORT}`));
