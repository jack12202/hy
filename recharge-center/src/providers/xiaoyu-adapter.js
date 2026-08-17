import { config } from "../config.js";
import { requiredString } from "../utils.js";
import { requestJson } from "./http-json.js";

const failedObservations = new Map();

function normalizeCardKey(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsedUrl = new URL(raw);
    const key = parsedUrl.searchParams.get("card") || parsedUrl.searchParams.get("code");
    if (requiredString(key)) return key.trim();
  } catch {
    // Plain card key; preserve case because Xiaoyu keys are case-sensitive.
  }

  return raw;
}

function envelope(raw) {
  const response = raw?.data && typeof raw.data === "object" ? raw.data : {};
  const wrapped = typeof response.code === "number" || Object.prototype.hasOwnProperty.call(response, "data");
  const data = wrapped
    ? response.data && typeof response.data === "object" ? response.data : {}
    : response;
  return {
    ok: raw.ok && (!wrapped || response.code === 0),
    code: response.code,
    message: typeof response.message === "string" ? response.message : "",
    data
  };
}

function errorMessage(raw, fallback) {
  const parsed = envelope(raw);
  return parsed.message || fallback;
}

function currentApiKey() {
  return process.env.XIAOYU_API_KEY ?? config.xiaoyuApiKey;
}

function apiHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey
  };
}

function normalizeVerify(raw, cardCode) {
  const parsed = envelope(raw);
  const item = parsed.data;
  const exists = item.exists === true;
  const isUsed = item.is_used === true;
  const cardStatus = typeof item.status === "string" ? item.status : "unknown";
  const success = parsed.ok && exists && !isUsed && cardStatus !== "frozen";

  let message = "";
  if (!parsed.ok) message = parsed.message || "激活码查询失败，请稍后重试。";
  else if (!exists) message = "激活码不存在，请检查后重新输入。";
  else if (cardStatus === "frozen") message = "该激活码已冻结，请联系管理员。";
  else if (isUsed) message = "卡密已被使用";

  return {
    success,
    provider: "xiaoyu",
    providerLabel: "小雨",
    cardCode,
    exists,
    isUsed,
    cardStatus,
    cardType: typeof item.type === "string" ? item.type : "",
    planType: typeof item.plan_type === "string" ? item.plan_type : "",
    productId: config.defaultProductId,
    message
  };
}

function normalizeStart(raw) {
  const parsed = envelope(raw);
  const item = parsed.data;
  const cardKey = typeof item.card_key === "string" ? item.card_key : "";
  const orderNo = typeof item.order_no === "string" ? item.order_no : "";
  const success = parsed.ok && requiredString(cardKey) && requiredString(orderNo);

  return {
    success,
    provider: "xiaoyu",
    providerLabel: "小雨",
    taskId: cardKey,
    orderNo,
    status: success ? "processing" : "failed",
    message: item.message || parsed.message || (success ? "订单已进入小雨处理队列。" : "充值提交失败。")
  };
}

function confirmedStatus(item, cardKey) {
  const upstreamStatus = typeof item.status === "string" ? item.status : "unknown";
  if (upstreamStatus !== "failed") {
    failedObservations.delete(cardKey);
    return upstreamStatus === "success"
      ? "success"
      : upstreamStatus === "pending"
        ? "queued"
        : "processing";
  }

  const signature = `${item.retry_attempt || 0}:${item.order_no || ""}`;
  if (failedObservations.get(cardKey) !== signature) {
    failedObservations.set(cardKey, signature);
    return "needs_review";
  }

  failedObservations.delete(cardKey);
  return "failed";
}

function normalizeStatus(raw, cardKey) {
  const parsed = envelope(raw);
  const item = parsed.data;
  const status = parsed.ok ? confirmedStatus(item, cardKey) : "needs_review";
  const message = status === "needs_review" && item.status === "failed"
    ? "检测到一次失败结果，正在确认是否触发上游自动重试。"
    : item.failure_reason || item.payment_result?.message || parsed.message || item.status || "正在查询充值结果。";

  return {
    success: parsed.ok,
    provider: "xiaoyu",
    providerLabel: "小雨",
    status,
    upstreamStatus: typeof item.status === "string" ? item.status : "unknown",
    message,
    orderNo: typeof item.order_no === "string" ? item.order_no : "",
    retryAttempt: Number(item.retry_attempt || 0),
    planType: typeof item.plan_type === "string" ? item.plan_type : "",
    paymentAmount: item.payment_amount ?? null,
    paymentCurrency: typeof item.payment_currency === "string" ? item.payment_currency : ""
  };
}

export const xiaoyuAdapter = {
  key: "xiaoyu",
  label: "小雨",

  async verifyCard({ cardInfo }) {
    const cardCode = normalizeCardKey(cardInfo);
    const raw = await requestJson(config.xiaoyuBaseUrl, "/api/v1/card-keys/check-usage", {
      method: "POST",
      payload: { key: cardCode }
    });
    const data = normalizeVerify(raw, cardCode);
    return {
      ok: data.success,
      status: raw.status,
      data
    };
  },

  async queryCardStatus({ cardInfo }) {
    const result = await this.verifyCard({ cardInfo });
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      data: {
        ...result.data,
        cardStatus: result.data.isUsed ? "used" : result.data.success ? "unused" : result.data.cardStatus,
        isDistributed: true
      }
    };
  },

  async startRecharge({ cardInfo, fullAuthData }) {
    const cardCode = normalizeCardKey(cardInfo);
    const token = typeof fullAuthData === "string" ? JSON.parse(fullAuthData) : fullAuthData;
    const apiKey = currentApiKey();
    const useThirdPartyApi = requiredString(apiKey);
    const raw = await requestJson(
      config.xiaoyuBaseUrl,
      useThirdPartyApi ? "/api/v1/third-party/orders/direct" : "/api/v1/orders",
      {
        method: "POST",
        headers: useThirdPartyApi ? apiHeaders(apiKey) : {},
        payload: useThirdPartyApi
          ? {
              orderType: "card_key",
              cardKey: cardCode,
              token
            }
          : {
              cardKey: cardCode,
              token
            }
      }
    );
    const data = normalizeStart(raw);
    return {
      ok: data.success,
      status: raw.status,
      data: data.success ? data : { ...data, message: errorMessage(raw, data.message) }
    };
  },

  async queryTaskStatus({ taskId, cardInfo }) {
    const cardKey = normalizeCardKey(cardInfo || taskId);
    const apiKey = currentApiKey();
    const useThirdPartyApi = requiredString(apiKey);
    const raw = useThirdPartyApi
      ? await requestJson(config.xiaoyuBaseUrl, "/api/v1/third-party/orders/status", {
          method: "POST",
          headers: apiHeaders(apiKey),
          payload: { cardKey }
        })
      : await requestJson(
          config.xiaoyuBaseUrl,
          `/api/v1/orders/status/${encodeURIComponent(cardKey)}`
        );
    const data = normalizeStatus(raw, cardKey);
    return {
      ok: data.success,
      status: raw.status,
      data
    };
  }
};
