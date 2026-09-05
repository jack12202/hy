import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

export const config = {
  rootDir,
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 8788),
  frontendFile: process.env.FRONTEND_FILE || "",
  defaultProvider: process.env.DEFAULT_PROVIDER || "czgpt",
  upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || "https://kkk.ow800.com",
  upstreamAuthToken: process.env.UPSTREAM_AUTH_TOKEN || "",
  upstreamAuthHeader: process.env.UPSTREAM_AUTH_HEADER || "Authorization",
  upstreamAuthScheme: process.env.UPSTREAM_AUTH_SCHEME || "Bearer",
  ayanBaseUrl: process.env.AYAN_BASE_URL || "https://api.987ai.vip",
  ajianBaseUrl: process.env.AJIAN_BASE_URL || "https://ajian.chat",
  ajianSessionTtlMs: Number(process.env.AJIAN_SESSION_TTL_MS || 20 * 60 * 1000),
  ajianUserAgent: process.env.AJIAN_USER_AGENT || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139 Safari/537.36",
  resellerBaseUrl: process.env.RESELLER_BASE_URL || "https://666ai.vip",
  xiaoyuBaseUrl: process.env.XIAOYU_BASE_URL || "https://autoserve.de10.online",
  xiaoyuApiKey: process.env.XIAOYU_API_KEY || "",
  hifupayBaseUrl: process.env.HIFUPAY_BASE_URL || "https://sdk.hifupay.com",
  hifupayApiKey: process.env.HIFUPAY_API_KEY || "",
  hifupayCardId: process.env.HIFUPAY_CARD_ID || "7172",
  hifupayPlan: process.env.HIFUPAY_PLAN || "plus",
  hifupayRegion: process.env.HIFUPAY_REGION || "PH",
  hifupayProxyRegion: process.env.HIFUPAY_PROXY_REGION || "PH3",
  hifupayEngine: process.env.HIFUPAY_ENGINE || "oaics",
  hifupayMaxPlusUsers: Number(process.env.HIFUPAY_MAX_PLUS_USERS || 4),
  hifupayUpgradeWindowDays: Number(process.env.HIFUPAY_UPGRADE_WINDOW_DAYS || 30),
  hifupayEstimatedPlusChargeUsd: Number(process.env.HIFUPAY_ESTIMATED_PLUS_CHARGE_USD || 16),
  hifupayEstimatedProChargeUsd: Number(process.env.HIFUPAY_ESTIMATED_PRO_CHARGE_USD || 0),
  hifupaySafetyBufferUsd: Number(process.env.HIFUPAY_SAFETY_BUFFER_USD || 2),
  hifupayProductId: Number(process.env.HIFUPAY_PRODUCT_ID || 3),
  adminToken: process.env.ADMIN_TOKEN || "",
  recoveryEncryptionKey: process.env.RECOVERY_ENCRYPTION_KEY || "",
  dataFile: process.env.DATA_FILE || path.join(rootDir, "data", "orders.json"),
  logFile: process.env.LOG_FILE || path.join(rootDir, "logs", "server.log"),
  defaultProductId: Number(process.env.DEFAULT_PRODUCT_ID || 3),
  pollingIntervalMs: Number(process.env.POLLING_INTERVAL_MS || 4000),
  maxPollingMs: Number(process.env.MAX_POLLING_MS || 120000)
};
