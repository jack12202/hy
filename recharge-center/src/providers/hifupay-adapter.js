import { config } from "../config.js";
import { extractCardCode, requiredString } from "../utils.js";
import { requestJson } from "./http-json.js";

function apiKey() {
  return process.env.HIFUPAY_API_KEY ?? config.hifupayApiKey;
}

function apiHeaders() {
  return {
    "Content-Type": "application/json",
    ...(apiKey() ? { "X-Api-Key": apiKey() } : {})
  };
}

function errorMessage(raw, fallback) {
  const body = raw?.data && typeof raw.data === "object" ? raw.data : {};
  return body.error || body.message || fallback;
}

function cardVerifyUrl() {
  return process.env.HIFUPAY_CARD_VERIFY_URL ?? config.hifupayCardVerifyUrl;
}

function normalizeVerify(raw, cardCode) {
  const body = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const success = raw.ok && (body.success === true || body.valid === true) && body.used !== true;
  return {
    success,
    provider: "h",
    providerLabel: "h",
    cardCode,
    productId: config.hifupayProductId,
    message: success ? "" : errorMessage(raw, body.used === true ? "卡密已使用" : "卡密验证失败，请检查后重试。"),
    raw: body
  };
}

function normalizeStart(raw) {
  const body = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const taskId = body.taskId || body.task_id || "";
  const success = raw.ok && Boolean(taskId) && body.success !== false;
  return {
    success,
    provider: "h",
    providerLabel: "h",
    taskId,
    status: success ? "processing" : "failed",
    message: body.message || errorMessage(raw, success ? "充值任务已提交。" : "充值提交失败。"),
    raw: body
  };
}

function normalizeStatus(raw) {
  const body = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const upstreamStatus = String(body.status || "unknown").toLowerCase();
  const status = upstreamStatus === "completed"
    ? body.paymentConfirmed === false ? "needs_review" : "success"
    : upstreamStatus === "failed"
      ? "failed"
      : upstreamStatus === "queued" || upstreamStatus === "pending"
        ? "queued"
        : "processing";

  return {
    success: raw.ok,
    provider: "h",
    providerLabel: "h",
    status,
    upstreamStatus,
    message: body.error || body.message || (status === "success" ? "充值成功。" : "充值处理中，请稍候。"),
    account: typeof body.account === "string" ? body.account : "",
    paymentConfirmed: body.paymentConfirmed === true,
    autoCancelDone: body.autoCancelDone === true,
    logs: Array.isArray(body.logs) ? body.logs : [],
    raw: body
  };
}

function tokenPayload(fullAuthData) {
  return typeof fullAuthData === "string" ? fullAuthData : JSON.stringify(fullAuthData || {});
}

export const hifupayAdapter = {
  key: "h",
  label: "h",

  async verifyCard({ cardInfo }) {
    const cardCode = extractCardCode(cardInfo);
    if (!cardCode) {
      return { ok: false, status: 400, data: { provider: "h", providerLabel: "h", message: "请先输入卡密。" } };
    }

    const endpoint = cardVerifyUrl();
    if (!requiredString(endpoint)) {
      return {
        ok: false,
        status: 503,
        data: { provider: "h", providerLabel: "h", message: "h通道尚未配置自有卡密验证服务。" }
      };
    }

    const raw = await requestJson(endpoint, "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      payload: { cardInfo: cardCode, provider: "h" }
    });
    const data = normalizeVerify(raw, cardCode);
    return { ok: data.success, status: raw.status, data };
  },

  async startRecharge({ fullAuthData }) {
    const key = apiKey();
    if (!requiredString(key)) {
      return { ok: false, status: 503, data: { provider: "h", providerLabel: "h", message: "h通道 API Key 未配置。" } };
    }

    const cardId = process.env.HIFUPAY_CARD_ID ?? config.hifupayCardId;
    if (!requiredString(cardId)) {
      return {
        ok: false,
        status: 503,
        data: { provider: "h", providerLabel: "h", message: "h通道卡片 ID 未配置，当前版本暂不自动选卡。" }
      };
    }

    const raw = await requestJson(config.hifupayBaseUrl, "/api/start", {
      method: "POST",
      headers: apiHeaders(),
      payload: {
        token: tokenPayload(fullAuthData),
        plan: config.hifupayPlan,
        region: config.hifupayRegion,
        proxyRegion: config.hifupayProxyRegion,
        engine: config.hifupayEngine,
        hfpCardId: cardId
      }
    });
    const data = normalizeStart(raw);
    return { ok: data.success, status: raw.status, data };
  },

  async queryTaskStatus({ taskId }) {
    const raw = await requestJson(config.hifupayBaseUrl, `/api/status/${encodeURIComponent(taskId)}`, {
      headers: apiHeaders()
    });
    const data = normalizeStatus(raw);
    return { ok: raw.ok, status: raw.status, data };
  }
};
