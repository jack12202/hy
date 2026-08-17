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
  resellerBaseUrl: process.env.RESELLER_BASE_URL || "https://666ai.vip",
  xiaoyuBaseUrl: process.env.XIAOYU_BASE_URL || "https://autoserve.de10.online",
  xiaoyuApiKey: process.env.XIAOYU_API_KEY || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  dataFile: process.env.DATA_FILE || path.join(rootDir, "data", "orders.json"),
  logFile: process.env.LOG_FILE || path.join(rootDir, "logs", "server.log"),
  defaultProductId: Number(process.env.DEFAULT_PRODUCT_ID || 3),
  pollingIntervalMs: Number(process.env.POLLING_INTERVAL_MS || 4000),
  maxPollingMs: Number(process.env.MAX_POLLING_MS || 120000)
};
