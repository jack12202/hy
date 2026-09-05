import { config } from "../config.js";
import { JsonStore } from "../store.js";
import { extractCardCode, requiredString } from "../utils.js";
import { requestJson } from "./http-json.js";

function sourceApiKey() {
  return process.env.HIFUPAY_API_KEY ?? config.hifupayApiKey;
}

let authorizedApiKey = "";
const hCardStore = new JsonStore();

function apiHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { "X-Api-Key": apiKey } : {})
  };
}

function errorMessage(raw, fallback) {
  const body = raw?.data && typeof raw.data === "object" ? raw.data : {};
  return body.error || body.message || fallback;
}

function normalizeVerify(result, cardCode) {
  const success = result.ok === true;
  return {
    success,
    provider: "h",
    providerLabel: "h",
    cardCode,
    productId: result.productId || config.hifupayProductId,
    cardId: result.cardId || "",
    expiresAt: result.expiresAt || "",
    status: result.status || "",
    message: success ? "" : result.message || "卡密验证失败，请检查后重试。"
  };
}

function normalizeStart(raw, cardId) {
  const body = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const taskId = body.taskId || body.task_id || "";
  const success = raw.ok && Boolean(taskId) && body.success !== false;
  return {
    success,
    provider: "h",
    providerLabel: "h",
    taskId,
    cardId,
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

function accountIdentity(fullAuthData, userEmail, accountId) {
  let payload = fullAuthData;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  const user = payload?.user && typeof payload.user === "object" ? payload.user : {};
  const account = payload?.account && typeof payload.account === "object" ? payload.account : {};
  return {
    email: userEmail || payload?.userEmail || user.email || "",
    accountId: accountId || account.id || ""
  };
}

async function login() {
  const key = sourceApiKey();
  if (!requiredString(key)) return { ok: false, status: 503, message: "h通道 API Key 未配置。" };
  if (requiredString(authorizedApiKey)) return { ok: true, status: 200, apiKey: authorizedApiKey };

  const raw = await requestJson(config.hifupayBaseUrl, "/api/hfp/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    payload: { apiKey: key, platform: "haifupaytop" }
  });
  const body = raw.data && typeof raw.data === "object" ? raw.data : {};
  if (!raw.ok || body.success !== true || !requiredString(body.apiKey)) {
    return { ok: false, status: raw.status, message: errorMessage(raw, "h通道 API Key 登录失败。") };
  }

  authorizedApiKey = body.apiKey;
  return { ok: true, status: raw.status, apiKey: authorizedApiKey };
}

export const hifupayAdapter = {
  key: "h",
  label: "h",

  async verifyCard({ cardInfo }) {
    const cardCode = extractCardCode(cardInfo);
    if (!cardCode) {
      return { ok: false, status: 400, data: { provider: "h", providerLabel: "h", message: "请先输入卡密。" } };
    }

    const data = normalizeVerify(hCardStore.verifyHCard(cardCode), cardCode);
    return { ok: data.success, status: data.success ? 200 : 400, data };
  },

  async startRecharge({ cardInfo, fullAuthData, orderId, userEmail, accountId }) {
    const cardCode = extractCardCode(cardInfo);
    if (!cardCode || !requiredString(orderId)) {
      return { ok: false, status: 400, data: { provider: "h", providerLabel: "h", message: "缺少卡密或订单号。" } };
    }

    const reservation = hCardStore.reserveHCard(cardCode, orderId, accountIdentity(fullAuthData, userEmail, accountId));
    if (!reservation.ok) {
      return { ok: false, status: 409, data: { provider: "h", providerLabel: "h", message: reservation.message } };
    }

    const cardId = process.env.HIFUPAY_CARD_ID ?? config.hifupayCardId;
    if (!requiredString(cardId)) {
      return {
        ok: false,
        status: 503,
        data: { provider: "h", providerLabel: "h", cardId: reservation.cardId, message: "h通道卡片 ID 未配置，当前版本暂不自动选卡。" }
      };
    }

    const session = await login();
    if (!session.ok) {
      return { ok: false, status: session.status || 502, data: { provider: "h", providerLabel: "h", cardId: reservation.cardId, message: session.message } };
    }

    const raw = await requestJson(config.hifupayBaseUrl, "/api/start", {
      method: "POST",
      headers: apiHeaders(session.apiKey),
      payload: {
        token: tokenPayload(fullAuthData),
        plan: config.hifupayPlan,
        region: config.hifupayRegion,
        proxyRegion: config.hifupayProxyRegion,
        engine: config.hifupayEngine,
        hfpCardId: cardId
      }
    });
    const data = normalizeStart(raw, reservation.cardId);
    return { ok: data.success, status: raw.status, data };
  },

  async queryTaskStatus({ taskId }) {
    const session = await login();
    if (!session.ok) {
      return { ok: false, status: session.status || 502, data: { provider: "h", providerLabel: "h", status: "failed", message: session.message } };
    }

    const raw = await requestJson(config.hifupayBaseUrl, `/api/status/${encodeURIComponent(taskId)}`, {
      headers: apiHeaders(session.apiKey)
    });
    const data = normalizeStatus(raw);
    return { ok: raw.ok, status: raw.status, data };
  }
};
