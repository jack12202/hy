import { config } from "../config.js";
import { extractCardCode } from "../utils.js";
import { requestJson } from "./http-json.js";

const SESSION_CARD_TYPES = new Set(["token", "th", "gpt_pro_20x", "gpt_pro_5x"]);

function errorMessage(raw, fallback) {
  const body = raw?.data;
  if (typeof body?.detail === "string" && body.detail.trim()) return body.detail;
  if (typeof body?.message === "string" && body.message.trim()) return body.message;
  return fallback;
}

function maskEmail(value = "") {
  const email = typeof value === "string" ? value.trim() : "";
  const at = email.indexOf("@");
  if (at <= 0) return "";
  const name = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = name.length <= 2 ? name.slice(0, 1) : `${name.slice(0, 2)}…${name.slice(-1)}`;
  return `${visible}@${domain}`;
}

function normalizeVerify(raw, cardCode) {
  const item = Array.isArray(raw.data) ? raw.data[0] || {} : {};
  const cardType = typeof item.type === "string" ? item.type : "";
  const isUnused = item.status === "unused";
  const isSupported = SESSION_CARD_TYPES.has(cardType);
  const isDistributed = item.is_distributed !== false;
  const success = raw.ok && isUnused && isSupported && isDistributed;

  let message = "";
  if (!raw.ok) message = errorMessage(raw, "激活码查询失败，请稍后重试。");
  else if (item.status === "not_found") message = "激活码不存在，请检查后重新输入。";
  else if (!isUnused) message = item.status === "used" ? "卡密已被使用" : "当前激活码不可用。";
  else if (!isDistributed) message = "激活码尚未发放，暂时不能使用。";
  else if (!isSupported) message = "当前页面暂不支持这种卡密类型。";

  return {
    success,
    provider: "czgpt",
    providerLabel: "l",
    cardCode,
    cardType,
    productId: config.defaultProductId,
    message,
    raw: item
  };
}

function normalizeCardStatus(raw) {
  const item = Array.isArray(raw.data) ? raw.data[0] || {} : {};
  const cardStatus = typeof item.status === "string" ? item.status : "unknown";

  return {
    success: raw.ok,
    provider: "czgpt",
    providerLabel: "l",
    cardStatus,
    cardType: typeof item.type === "string" ? item.type : "",
    isDistributed: item.is_distributed !== false,
    boundEmailMasked: maskEmail(item.bound_email),
    usedAt: typeof item.used_at === "string" ? item.used_at : "",
    message: raw.ok ? "" : errorMessage(raw, "卡密状态查询失败，请稍后重试。")
  };
}

function normalizeStart(raw) {
  const body = raw.data || {};
  const taskId = body.task_id || body.taskId || "";
  const success = raw.ok && Boolean(taskId);

  return {
    success,
    provider: "czgpt",
    providerLabel: "l",
    taskId,
    status: success ? "queued" : "failed",
    message: body.message || errorMessage(raw, success ? "充值任务已创建。" : "充值提交失败。"),
    raw: body
  };
}

function normalizeStatus(raw) {
  const body = raw.data || {};
  const upstreamStatus = body.status || "unknown";
  const status =
    upstreamStatus === "succeeded"
      ? "success"
      : upstreamStatus === "pending"
        ? "queued"
        : upstreamStatus === "working"
          ? "processing"
          : "needs_review";

  return {
    success: raw.ok,
    provider: "czgpt",
    providerLabel: "l",
    status,
    upstreamStatus,
    message: body.message || errorMessage(raw, upstreamStatus),
    remainingSeconds: body.remaining_seconds ?? null,
    queueAhead: body.queue_ahead ?? null,
    raw: body
  };
}

export const czgptAdapter = {
  key: "czgpt",
  label: "l",

  async verifyCard({ cardInfo }) {
    const cardCode = extractCardCode(cardInfo);
    const raw = await requestJson(config.resellerBaseUrl, "/api/v1/kami/status", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: cardCode
    });
    const data = normalizeVerify(raw, cardCode);
    return {
      ok: data.success,
      status: raw.status,
      data
    };
  },

  async queryCardStatus({ cardInfo }) {
    const cardCode = extractCardCode(cardInfo);
    const raw = await requestJson(config.resellerBaseUrl, "/api/v1/kami/status", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: cardCode
    });
    const data = normalizeCardStatus(raw);
    return {
      ok: raw.ok,
      status: raw.status,
      data
    };
  },

  async startRecharge({ cardInfo, fullAuthData }) {
    const cardCode = extractCardCode(cardInfo);
    const session = typeof fullAuthData === "string" ? JSON.parse(fullAuthData) : fullAuthData;
    const raw = await requestJson(config.resellerBaseUrl, "/api/v1/kami/use", {
      method: "POST",
      payload: {
        code: cardCode,
        session
      }
    });
    const data = normalizeStart(raw);
    return {
      ok: data.success,
      status: raw.status,
      data
    };
  },

  async queryTaskStatus({ taskId }) {
    const raw = await requestJson(
      config.resellerBaseUrl,
      `/api/v1/kami/task/${encodeURIComponent(taskId)}`
    );
    const data = normalizeStatus(raw);
    return {
      ok: raw.ok,
      status: raw.status,
      data
    };
  }
};
