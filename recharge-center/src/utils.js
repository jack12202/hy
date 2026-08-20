import crypto from "node:crypto";

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With"
  });
  res.end(body);
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function maskCard(cardInfo = "") {
  if (cardInfo.length <= 4) return cardInfo;
  return `${cardInfo.slice(0, 4)}****${cardInfo.slice(-4)}`;
}

export function safeJsonParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function sha256(value = "") {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function requiredString(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function normalizeProvider(value, fallback = "sange") {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    provider === "sange" ||
    provider === "ayan" ||
    provider === "czgpt" ||
    provider === "xiaoyu" ||
    provider === "sange_external" ||
    provider === "ayan_external" ||
    provider === "czgpt_external" ||
    provider === "dnscon" ||
    provider === "9977ai"
  ) return provider;
  return fallback;
}

export function extractCardCode(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsedUrl = new URL(raw);
    const code = parsedUrl.searchParams.get("card") || parsedUrl.searchParams.get("code");
    if (requiredString(code)) return code.trim().toUpperCase();
  } catch {
    // Not a URL; continue with plain text parsing.
  }

  const parts = raw
    .split(/[\s:：,，|/\\?&=]+/)
    .map(part => part.trim())
    .filter(Boolean);
  const candidate = parts.length ? parts[parts.length - 1] : raw;
  return candidate.toUpperCase();
}

export function tryParseJsonText(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = safeJsonParse(trimmed);
  return parsed.ok ? parsed.value : value;
}
