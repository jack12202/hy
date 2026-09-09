import { config } from "./config.js";
import { getProviderAdapter, listProviders } from "./providers/index.js";
import { JsonStore } from "./store.js";
import {
  decodeJson,
  decryptSecretText,
  encryptSecretText,
  maskCard,
  normalizeProvider,
  requiredString,
  safeJsonParse,
  sha256,
  tryParseJsonText
} from "./utils.js";

const store = new JsonStore();

const H_CARD_CODE_PATTERN = /^HPLUS[0-9A-F]{32}$/;
const H_CARD_STATUS_LABELS = {
  unused: "未使用",
  locked: "已锁定",
  processing: "处理中",
  success: "充值成功",
  failed: "充值失败",
  disabled: "已禁用"
};

function normalizeHCardCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return H_CARD_CODE_PATTERN.test(code) ? code : "";
}

function maskEmail(value) {
  const email = String(value || "").trim();
  const at = email.indexOf("@");
  if (at <= 0) return "";
  const local = email.slice(0, at);
  return `${local.slice(0, 1)}***@${email.slice(at + 1)}`;
}

function maskAccountId(value) {
  const accountId = String(value || "").trim();
  if (!accountId) return "";
  if (accountId.length <= 8) return `${accountId.slice(0, 1)}***${accountId.slice(-1)}`;
  return `${accountId.slice(0, 4)}****${accountId.slice(-4)}`;
}

function maskedBoundAccount(record) {
  return maskEmail(record.boundEmail) || maskAccountId(record.boundAccountId);
}

function publicHCardMessage(status) {
  if (status === "unused") return "这张卡密尚未使用，可以继续完成充值。";
  if (status === "locked") return "这张卡密已经锁定，请勿重复提交；如需处理请联系客服。";
  if (status === "processing") return "充值正在处理中，请耐心等待，不要重复提交。";
  if (status === "success") return "这张卡密对应的充值已经完成。";
  if (status === "failed") return "本次充值未成功，请联系客服核查。";
  return "这张卡密当前不可使用，请联系客服处理。";
}

function subscriptionPublicData(order = {}) {
  const needsAttention = Boolean(order.subscriptionActionRequired && !order.subscriptionActionHandledAt);
  return {
    subscriptionCancellationStatus: order.subscriptionCancellationStatus || "",
    subscriptionActionRequired: needsAttention,
    subscriptionActionMessage: needsAttention
      ? order.subscriptionActionMessage || "充值成功，但自动续费未关闭，请手动取消连续订阅。"
      : ""
  };
}

function hSubscriptionPatch(order, taskData, nextStatus) {
  if (order?.provider !== "h" || nextStatus !== "success" || (taskData.paymentConfirmed !== true && order.status !== "success")) return {};
  const now = new Date();
  const configuredStatus = taskData.paymentConfirmed === true
    ? taskData.subscriptionCancellationStatus || (taskData.autoCancelDone === true ? "cancelled" : "pending")
    : order.subscriptionCancellationStatus || "pending";
  const existingDeadline = Date.parse(order.subscriptionFollowUpUntil);
  const deadline = Number.isFinite(existingDeadline)
    ? existingDeadline
    : now.getTime() + Math.max(Number(config.hSubscriptionFollowUpSeconds) || 120, 30) * 1000;
  const timedOut = configuredStatus === "pending" && now.getTime() >= deadline;
  const status = timedOut ? "unknown" : configuredStatus;
  const actionRequired = status === "failed";
  const actionMessage = status === "failed"
    ? "充值成功，但自动续费未关闭，请联系用户手动取消连续订阅。"
    : "";
  return {
    subscriptionCancellationStatus: status,
    subscriptionActionRequired: actionRequired,
    subscriptionActionMessage: actionMessage,
    subscriptionActionDetectedAt: actionRequired ? order.subscriptionActionDetectedAt || now.toISOString() : "",
    subscriptionFollowUpUntil: new Date(deadline).toISOString(),
    subscriptionClassifierVersion: taskData.paymentConfirmed === true ? 2 : Number(order.subscriptionClassifierVersion || 0),
    lastStatusSyncAt: now.toISOString(),
    ...(status === "cancelled" ? {
      subscriptionActionRequired: false,
      subscriptionActionMessage: "",
      subscriptionActionDetectedAt: ""
    } : {})
  };
}

function hSubscriptionMessage(defaultMessage, patch) {
  if (patch.subscriptionCancellationStatus === "failed") return "充值成功，但自动续费关闭失败，请用户手动关闭自动续费。";
  if (patch.subscriptionCancellationStatus === "unknown") return "充值成功，自动续费状态暂未确认。";
  if (patch.subscriptionCancellationStatus === "cancelled") return "充值成功，自动续费已关闭。";
  if (patch.subscriptionCancellationStatus === "pending") return "充值成功，正在确认自动续费关闭结果。";
  return defaultMessage;
}

function adminAlertWebhookPayload(record) {
  const text = [
    "【GPTC 需处理】充值成功但自动续费未关闭",
    `账号：${record.userEmail || "未知"}`,
    `卡密：${record.cardMask || "未知"}`,
    `提交时间：${record.createdAt || "未知"}`,
    "请联系用户进入头像 → 设置 → 账户 → 订阅管理，手动取消连续订阅。",
    `${String(config.publicBaseUrl || "https://www.gptc.cc").replace(/\/$/, "")}/admin/recoveries`
  ].join("\n");
  const type = String(config.adminAlertWebhookType || "generic").toLowerCase();
  if (type === "wecom" || type === "dingtalk") return { msgtype: "text", text: { content: text } };
  if (type === "feishu") return { msg_type: "text", content: { text } };
  return {
    event: "h_subscription_cancellation_required",
    account: record.userEmail || "",
    cardMask: record.cardMask || "",
    createdAt: record.createdAt || "",
    message: "充值成功，但自动续费未关闭，需要人工跟进。",
    adminUrl: `${String(config.publicBaseUrl || "https://www.gptc.cc").replace(/\/$/, "")}/admin/recoveries`
  };
}

function simplifyHCardFailure(message) {
  const value = String(message || "");
  if (/余额|可用卡|卡池|card.*(?:unavailable|balance)/i.test(value)) return "嗨付卡池暂不可用";
  if (/认证|登录|api\s*key|unauthori[sz]ed|forbidden/i.test(value)) return "通道认证异常";
  if (/网络|超时|timeout|fetch|socket|connect/i.test(value)) return "通道网络异常";
  if (/支付|payment/i.test(value)) return "支付未成功";
  return "充值未成功，需人工核查";
}

function parseHCardBatchLine(value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: false, message: "空行" };
  const directCode = normalizeHCardCode(raw);
  if (directCode) return { ok: true, code: directCode };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: "卡密格式不正确" };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !["gptc.cc", "www.gptc.cc"].includes(parsed.hostname.toLowerCase())) {
    return { ok: false, message: "仅支持 gptc.cc 充值链接" };
  }
  if (String(parsed.searchParams.get("provider") || "").trim().toLowerCase() !== "h") {
    return { ok: false, message: "链接不是 h 通道" };
  }
  const code = normalizeHCardCode(parsed.searchParams.get("card"));
  return code ? { ok: true, code } : { ok: false, message: "链接缺少完整 h 卡密" };
}

function defaultProvider() {
  return normalizeProvider(store.getSettings().defaultProvider, normalizeProvider(config.defaultProvider));
}

function resolveProvider(provider) {
  return normalizeProvider(provider, defaultProvider());
}

function parseSecretPayload(secretJsonText) {
  const parsed = safeJsonParse(secretJsonText);
  if (!parsed.ok || typeof parsed.value !== "object" || !parsed.value) {
    return { ok: false, message: "充值密钥格式不完整，请重新复制后再试。" };
  }

  return parseSecretObject(parsed.value);
}

function parseSecretObject(payload) {
  const user = typeof payload.user === "object" && payload.user ? payload.user : {};
  const account = typeof payload.account === "object" && payload.account ? payload.account : {};
  const userEmail = requiredString(payload.userEmail)
    ? payload.userEmail.trim()
    : requiredString(user.email)
      ? user.email.trim()
      : "";
  const userGptToken = requiredString(payload.userGptToken)
    ? payload.userGptToken.trim()
    : requiredString(payload.accessToken)
      ? payload.accessToken.trim()
      : "";
  const fullAuthData =
    typeof payload.fullAuthData === "object" && payload.fullAuthData !== null
      ? payload.fullAuthData
      : payload;

  if (!requiredString(userEmail)) {
    return { ok: false, message: "充值密钥缺少 userEmail。" };
  }
  if (!requiredString(userGptToken)) {
    return { ok: false, message: "充值密钥缺少 userGptToken。" };
  }
  if (typeof fullAuthData !== "object" || fullAuthData === null) {
    return { ok: false, message: "充值密钥缺少 fullAuthData。" };
  }

  return {
    ok: true,
    data: {
      ...payload,
      userEmail,
      userGptToken,
      fullAuthData,
      account
    }
  };
}

function parseRechargeInput(input) {
  if (requiredString(input.secretJsonText)) {
    return parseSecretPayload(input.secretJsonText);
  }

  const fullAuthData = tryParseJsonText(input.fullAuthData);
  return parseSecretObject({
    ...input,
    fullAuthData: typeof fullAuthData === "object" && fullAuthData ? fullAuthData : input
  });
}

function normalizedProviderData(provider) {
  const adapter = getProviderAdapter(provider);
  return {
    provider: adapter.key,
    providerLabel: adapter.label,
    providerMode: adapter.mode || "api",
    redirectUrl: adapter.mode === "redirect" ? adapter.redirectUrl : ""
  };
}

function logPayload(value) {
  return JSON.stringify(value);
}

function protectionKey() {
  return config.recoveryEncryptionKey || config.adminToken || "local-development-only";
}

function encryptProtected(value, context) {
  return encryptSecretText(value, protectionKey(), context);
}

function decryptProtected(value, context) {
  return decryptSecretText(value, protectionKey(), context);
}

function sessionSecretText(session) {
  return decryptProtected(session?.rawSecretCiphertext, "recharge-secret-json")
    || decryptProtected(session?.authDataCiphertext, "recharge-auth-data")
    || (session?.authDataEncoded ? JSON.stringify(decodeJson(session.authDataEncoded) || {}) : "");
}

function parseStoredSecret(order, session) {
  const raw = sessionSecretText(session);
  if (!raw) return { ok: false, message: "这笔订单没有可恢复的充值密钥。" };
  const parsed = safeJsonParse(raw);
  const payload = parsed.ok && parsed.value && typeof parsed.value === "object"
    ? parsed.value
    : { fullAuthData: raw };
  const result = parseSecretObject({
    ...payload,
    userEmail: session?.userEmail || payload.userEmail,
    fullAuthData: payload.fullAuthData || payload
  });
  if (!result.ok) return result;
  return { ok: true, data: result.data, rawText: raw };
}

function storedCardCode(order) {
  return decryptProtected(order?.cardInfoCiphertext, "recharge-card-info")
    || (order?.hCardId ? store.getHCardCode(order.hCardId) : "");
}

async function reconcileCzgptStatus(adapter, taskData, cardInfo) {
  if (
    taskData?.status !== "needs_review" ||
    !requiredString(cardInfo) ||
    typeof adapter.queryCardStatus !== "function"
  ) {
    return taskData;
  }

  const cardResult = await adapter.queryCardStatus({ cardInfo: cardInfo.trim() });
  const cardData = cardResult.data || {};
  const cardStatus = cardData.cardStatus || "unknown";
  const base = {
    ...taskData,
    cardStatus,
    cardStatusVerified: cardResult.ok,
    boundEmailMasked: cardData.boundEmailMasked || "",
    usedAt: cardData.usedAt || ""
  };

  if (!cardResult.ok) {
    return {
      ...base,
      status: "needs_review",
      message: "暂未取得最终充值结果，系统会继续查询，请不要重复提交卡密。"
    };
  }

  if (cardStatus === "used") {
    return {
      ...base,
      status: "syncing",
      message: "卡密已使用，说明本次充值已被系统接收；如会员暂未显示，请等待账号状态同步。"
    };
  }

  if (cardStatus === "bound" || cardStatus === "processing") {
    return {
      ...base,
      status: "processing",
      message: "卡密已绑定，系统仍在处理中，请继续等待。"
    };
  }

  if (cardStatus === "unused") {
    return {
      ...base,
      status: "needs_review",
      message: "任务暂未完成，卡密当前仍显示未使用。请先联系客服核查原任务，不要提交第二张卡密。"
    };
  }

  return {
    ...base,
    status: "needs_review",
    message: "充值结果暂时无法确认，系统会继续查询，请不要重复提交或更换卡密。"
  };
}

export const rechargeService = {
  getProviderSettings() {
    const settings = store.getSettings();
    const provider = normalizeProvider(settings.defaultProvider, defaultProvider());
    const adapter = getProviderAdapter(provider);

    return {
      defaultProvider: provider,
      defaultProviderLabel: adapter.label,
      defaultProviderMode: adapter.mode || "api",
      redirectUrl: adapter.mode === "redirect" ? adapter.redirectUrl : "",
      providerUpdatedAt: settings.providerUpdatedAt || "",
      providerUpdatedBy: settings.providerUpdatedBy || "",
      providers: listProviders()
    };
  },

  updateDefaultProvider(provider, updatedBy = "admin") {
    const nextProvider = normalizeProvider(provider, "");
    if (!nextProvider) {
      return { ok: false, status: 400, message: "请选择有效源头。" };
    }

    const settings = store.updateSettings({
      defaultProvider: nextProvider,
      providerUpdatedAt: new Date().toISOString(),
      providerUpdatedBy: updatedBy
    });

    return {
      ok: true,
      status: 200,
      data: {
        ...this.getProviderSettings(),
        providerUpdatedAt: settings.providerUpdatedAt
      }
    };
  },

  createHCards(input = {}) {
    const cards = store.createHCards({
      count: input.count,
      productId: input.productId || config.hifupayProductId,
      source: input.source
    });
    return { ok: true, status: 200, data: { cards } };
  },

  listHCards(limit = 100, all = false, reveal = false, includeArchived = false) {
    return { ok: true, status: 200, data: { cards: store.listHCards(limit, all, reveal, includeArchived) } };
  },

  queryHCardStatus(cardInfo, provider) {
    if (String(provider || "").trim().toLowerCase() !== "h") {
      return { ok: false, status: 400, message: "仅支持查询 h 通道卡密。" };
    }
    const code = normalizeHCardCode(cardInfo);
    if (!code) return { ok: false, status: 400, message: "请输入完整的 HPLUS 卡密。" };
    const record = store.queryHCardsByCodes([code])[0];
    if (!record?.found) return { ok: false, status: 404, message: "未查询到这张卡密，请核对后重新输入。" };
    return {
      ok: true,
      status: 200,
      data: {
        status: record.status,
        statusLabel: H_CARD_STATUS_LABELS[record.status],
        boundAccount: maskedBoundAccount(record),
        canRecharge: record.status === "unused",
        message: record.subscriptionActionRequired
          ? "充值已经成功，但自动续费未关闭，请手动取消连续订阅。"
          : publicHCardMessage(record.status),
        subscriptionCancellationStatus: record.subscriptionCancellationStatus,
        subscriptionActionRequired: record.subscriptionActionRequired,
        subscriptionActionMessage: record.subscriptionActionMessage
      }
    };
  },

  batchQueryHCards(inputs) {
    const lines = Array.isArray(inputs) ? inputs.map(value => String(value || "").trim()).filter(Boolean) : [];
    if (!lines.length) return { ok: false, status: 400, message: "请至少输入一张卡密。" };
    if (lines.length > 100) return { ok: false, status: 400, message: "每次最多查询 100 张卡密。" };

    const parsed = lines.map(parseHCardBatchLine);
    const validCodes = parsed.filter(item => item.ok).map(item => item.code);
    const records = store.queryHCardsByCodes(validCodes);
    let recordIndex = 0;
    const results = parsed.map((item, index) => {
      if (!item.ok) {
        return {
          sequence: index + 1,
          code: "",
          status: "invalid",
          statusLabel: "无效输入",
          boundAccount: "",
          source: "",
          batchId: "",
          createdAt: "",
          submittedAt: "",
          completedAt: "",
          failureReason: item.message
        };
      }
      const record = records[recordIndex++];
      if (!record?.found) {
        return {
          sequence: index + 1,
          code: item.code,
          status: "not_found",
          statusLabel: "未找到",
          boundAccount: "",
          source: "",
          batchId: "",
          createdAt: "",
          submittedAt: "",
          completedAt: "",
          failureReason: "本站数据库中没有这张卡密"
        };
      }
      return {
        sequence: index + 1,
        code: record.code,
        status: record.status,
        statusLabel: H_CARD_STATUS_LABELS[record.status],
        boundAccount: [record.boundEmail, record.boundAccountId].filter(Boolean).join(" / "),
        source: record.source,
        batchId: record.batchId,
        createdAt: record.createdAt,
        submittedAt: record.submittedAt,
        completedAt: record.completedAt,
        failureReason: record.status === "failed" ? simplifyHCardFailure(record.failureMessage) : ""
      };
    });
    return { ok: true, status: 200, data: { results, totalCount: results.length } };
  },

  async refreshHifupayCards() {
    const adapter = getProviderAdapter("h");
    if (typeof adapter.listCards !== "function") {
      return { ok: false, status: 400, message: "h 通道暂不支持读取嗨付卡片列表。" };
    }
    const upstream = await adapter.listCards();
    if (!upstream.ok) {
      return { ok: false, status: upstream.status || 502, message: upstream.data?.message || "读取嗨付卡片列表失败。" };
    }
    return { ok: true, status: 200, data: { cards: store.syncHifupayCards(upstream.data.cards || []) } };
  },

  listHifupayCards() {
    return {
      ok: true,
      status: 200,
      data: {
        cards: store.listHifupayCards(),
        updatedAt: store.getSettings().hifupayCardsUpdatedAt || ""
      }
    };
  },

  setHifupayCardEnabled(cardId, enabled) {
    const result = store.setHifupayCardEnabled(cardId, enabled);
    return {
      ok: result.ok,
      status: result.ok ? 200 : 404,
      data: result.ok ? { cardId: result.cardId, status: result.status } : undefined,
      message: result.message
    };
  },

  setHifupayCardPriority(cardId, priority) {
    const result = store.setHifupayCardPriority(cardId, priority);
    return { ok: result.ok, status: result.ok ? 200 : 404, data: result.ok ? result : undefined, message: result.message };
  },

  clearHifupayReservation(cardId, orderId) {
    const result = store.clearHifupayReservation(cardId, orderId);
    return {
      ok: result.ok,
      status: result.ok ? 200 : 404,
      data: result.ok ? { cardId: result.cardId, status: result.status } : undefined,
      message: result.message
    };
  },

  listRecoverySubmissions() {
    const cutoff = Date.parse("2026-09-04T16:00:00.000Z");
    const recoveries = store.listRecoveryOrders().filter(item => Date.parse(item.createdAt) >= cutoff);
    return {
      ok: true,
      status: 200,
      data: {
        recoveries,
        pendingCount: recoveries.length
      }
    };
  },

  listRechargeSubmissions() {
    const cutoff = Date.parse("2026-09-04T16:00:00.000Z");
    store.purgeRechargeSecretsBefore("2026-09-04T16:00:00.000Z");
    const records = store.listRechargeOrders().filter(item => Date.parse(item.createdAt) >= cutoff);
    return {
      ok: true,
      status: 200,
      data: {
        records,
        totalCount: records.length,
        pendingCount: records.filter(item => ["failed", "needs_review"].includes(item.status) || item.needsAttention).length
      }
    };
  },

  markHSubscriptionHandled(orderId, operator = "admin") {
    const result = store.markHSubscriptionHandled(orderId, operator);
    return {
      ok: result.ok,
      status: result.ok ? 200 : result.status === "not_found" ? 404 : 409,
      data: result.ok ? { orderId: result.orderId, handledAt: result.handledAt } : undefined,
      message: result.message
    };
  },

  async dispatchHSubscriptionAlerts() {
    if (!requiredString(config.adminAlertWebhookUrl)) return { sentCount: 0, skipped: true };
    const pending = store.listPendingHSubscriptionAlerts();
    let sentCount = 0;
    for (const record of pending) {
      let notified = false;
      try {
        const response = await fetch(config.adminAlertWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(adminAlertWebhookPayload(record)),
          signal: AbortSignal.timeout(5000)
        });
        notified = response.ok;
      } catch {
        notified = false;
      }
      store.markHSubscriptionAlertAttempt(record.id, notified);
      if (notified) sentCount += 1;
    }
    return { sentCount, skipped: false };
  },

  async reconcileHSubscriptionStatuses({ limit = 20 } = {}) {
    const orders = store.listHOrdersForSubscriptionSync({
      lookbackHours: config.hSubscriptionSyncLookbackHours,
      limit
    });
    let updatedCount = 0;
    for (const order of orders) {
      try {
        const result = await this.queryTaskStatus({ orderId: order.id }, { forceRefresh: true, suppressAlertDispatch: true });
        if (result.ok) updatedCount += 1;
      } catch {
        // 单笔同步失败不影响其他订单，下一轮会继续尝试。
      }
    }
    const alerts = await this.dispatchHSubscriptionAlerts();
    return { checkedCount: orders.length, updatedCount, alertSentCount: alerts.sentCount };
  },

  getRecoverySubmission(orderId, reveal = false) {
    const record = store.getRecoveryOrder(orderId);
    if (!record) return { ok: false, status: 404, message: "订单不存在。" };
    const { order, session } = record;
    const parsed = parseStoredSecret(order, session);
    const cardInfo = storedCardCode(order);
    return {
      ok: true,
      status: 200,
      data: {
        orderId: order.id,
        provider: order.provider,
        cardMask: order.cardMask,
        status: order.status,
        userEmail: session?.userEmail || parsed.data?.userEmail || "",
        message: order.message || "",
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        hasSecret: parsed.ok,
        ...(reveal ? {
          cardInfo,
          secretJsonText: parsed.ok ? parsed.rawText : "",
          parseMessage: parsed.ok ? "" : parsed.message
        } : {})
      }
    };
  },

  async retryRecovery(orderId, operator = "admin") {
    const record = store.getRecoveryOrder(orderId);
    if (!record) return { ok: false, status: 404, message: "订单不存在。" };
    const { order, session } = record;
    if (!["failed", "needs_review"].includes(order.status)) {
      return { ok: false, status: 409, message: "当前订单不是待人工处理状态。" };
    }
    if (order.upstreamTaskId) {
      return { ok: false, status: 409, message: "订单已有上游任务号，请先查询原任务，避免重复扣费。" };
    }
    const secret = parseStoredSecret(order, session);
    if (!secret.ok) return { ok: false, status: 400, message: secret.message };
    const cardInfo = storedCardCode(order);
    if (!cardInfo) return { ok: false, status: 400, message: "订单没有保存完整卡密，无法自动重试。" };
    const adapter = getProviderAdapter(order.provider);
    if (adapter.mode === "redirect") return { ok: false, status: 400, message: "站外通道不能从这里自动重试。" };

    store.updateOrder(order.id, {
      status: "processing",
      message: "管理员正在重新提交充值。",
      manualRetryAt: new Date().toISOString(),
      manualRetryBy: operator
    });
    let upstream;
    try {
      upstream = await adapter.startRecharge({
        cardInfo,
        orderId: order.id,
        userEmail: secret.data.userEmail,
        accountId: typeof secret.data.account?.id === "string" ? secret.data.account.id : "",
        userGptToken: secret.data.userGptToken,
        fullAuthData: secret.data.fullAuthData,
        providerSessionId: order.providerSessionId || "",
        authProvider: typeof secret.data.authProvider === "string" ? secret.data.authProvider : "",
        productId: order.productId,
        plan: config.hifupayPlan,
        overwriteRecharge: Boolean(order.overwriteRecharge)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "充值通道请求异常。";
      store.updateOrder(order.id, { status: "failed", message: `重新提交失败：${message}` });
      store.addLog({
        orderId: order.id,
        step: `${order.provider}.manual-retry.error`,
        requestSummary: JSON.stringify({ provider: order.provider, cardMask: order.cardMask, operator }),
        responseSummary: message
      });
      return { ok: false, status: 502, message: `重新提交失败：${message}` };
    }
    const upstreamTaskId = upstream.data?.taskId || "";
    const status = upstream.ok ? upstream.data?.status || "processing" : "failed";
    const message = upstream.data?.message || (upstream.ok ? "充值已重新提交，正在处理。" : "重新提交失败。");
    store.updateOrder(order.id, {
      upstreamTaskId,
      ...(upstream.data?.cardId ? { hCardId: upstream.data.cardId } : {}),
      ...(upstream.data?.hifupayCardId ? { hifupayCardId: upstream.data.hifupayCardId } : {}),
      status,
      message
    });
    store.addLog({
      orderId: order.id,
      step: `${order.provider}.manual-retry`,
      requestSummary: JSON.stringify({ provider: order.provider, cardMask: order.cardMask, operator }),
      responseSummary: JSON.stringify({ ok: upstream.ok, status: upstream.status, taskId: upstreamTaskId, message })
    });
    return {
      ok: upstream.ok,
      status: upstream.ok ? 200 : upstream.status && upstream.status < 500 ? 200 : 502,
      data: { orderId: order.id, taskId: upstreamTaskId, status, message, ...normalizedProviderData(order.provider) }
    };
  },

  markRecoverySuccess(orderId, operator = "admin", message = "人工充值成功，系统已同步完成。") {
    const record = store.getRecoveryOrder(orderId);
    if (!record) return { ok: false, status: 404, message: "订单不存在。" };
    const { order } = record;
    if (order.status === "success") {
      return { ok: true, status: 200, data: { orderId: order.id, status: "success", message: order.message } };
    }
    if (order.provider === "h") {
      const hCard = order.hCardId ? null : store.getHCardByCode(storedCardCode(order));
      const hCardId = order.hCardId || hCard?.id || "";
      const completed = hCardId ? store.completeHCard(hCardId, order.id) : false;
      if (!completed) {
        const current = store.getHCardByCode(storedCardCode(order));
        if (current?.status !== "used") {
          return { ok: false, status: 409, message: "卡密当前不是锁定状态，无法同步为已使用。" };
        }
      }
      if (order.hifupayCardId) {
        const secret = parseStoredSecret(order, record.session);
        if (secret.ok) {
          store.recordHifupayResult({
            cardId: order.hifupayCardId,
            orderId: order.id,
            plan: config.hifupayPlan,
            identity: { email: secret.data.userEmail, accountId: secret.data.account?.id || "" },
            paymentConfirmed: true,
            status: "success"
          });
        }
      }
    }
    const updated = store.updateOrder(order.id, {
      status: "success",
      message,
      manualCompletedAt: new Date().toISOString(),
      manualCompletedBy: operator
    });
    store.addLog({
      orderId: order.id,
      step: "manual.success",
      requestSummary: JSON.stringify({ operator }),
      responseSummary: message
    });
    return { ok: true, status: 200, data: { orderId: updated.id, status: updated.status, message: updated.message } };
  },

  unlockHCard(cardId) {
    const result = store.unlockHCard(cardId);
    return {
      ok: result.ok,
      status: result.ok ? 200 : result.status === "used" ? 409 : result.status === "disabled" ? 409 : 400,
      data: result.ok ? { cardId: result.cardId, status: result.status } : undefined,
      message: result.message
    };
  },

  setHCardDisabled(cardId, disabled, reason = "") {
    const result = store.setHCardDisabled(cardId, disabled, reason);
    return {
      ok: result.ok,
      status: result.ok ? 200 : 404,
      data: result.ok ? { cardId: result.cardId, status: result.status } : undefined,
      message: result.message
    };
  },

  archiveHCard(cardId, archived = true) {
    const result = store.archiveHCard(cardId, archived);
    return { ok: result.ok, status: result.ok ? 200 : 404, data: result.ok ? { cardId: result.cardId, status: result.status } : undefined, message: result.message };
  },

  deleteHCard(cardId) {
    const result = store.deleteHCard(cardId);
    return { ok: result.ok, status: result.ok ? 200 : result.status === "not_found" ? 404 : 409, data: result.ok ? { cardId: result.cardId, status: result.status } : undefined, message: result.message };
  },

  bulkHCardAction(cardIds, action) {
    const result = store.bulkHCardAction(cardIds, action);
    return { ok: true, status: 200, data: result };
  },

  purgeRechargeSecretsBefore(cutoffIso) {
    const purgedCount = store.purgeRechargeSecretsBefore(cutoffIso);
    return { ok: true, status: 200, data: { purgedCount, cutoffIso } };
  },

  async verifyCard(cardInfo, provider) {
    if (!requiredString(cardInfo)) {
      return { ok: false, status: 400, message: "请先输入卡密。" };
    }

    const selectedProvider = resolveProvider(provider);
    const adapter = getProviderAdapter(selectedProvider);
    const upstream = await adapter.verifyCard({ cardInfo: cardInfo.trim() });
    const status = upstream.status && upstream.status < 500 ? 200 : 502;

    return {
      ok: upstream.ok,
      status: upstream.ok ? 200 : status,
      data: {
        ...upstream.data,
        selectedProvider,
        defaultProvider: defaultProvider()
      }
    };
  },

  async queryCardStatus(cardInfo, provider) {
    if (!requiredString(cardInfo)) {
      return { ok: false, status: 400, message: "请先输入卡密。" };
    }

    const selectedProvider = resolveProvider(provider);
    const adapter = getProviderAdapter(selectedProvider);
    if (typeof adapter.queryCardStatus !== "function") {
      return { ok: false, status: 400, message: "当前充值通道暂不支持单独查询卡密状态。" };
    }

    const upstream = await adapter.queryCardStatus({ cardInfo: cardInfo.trim() });
    return {
      ok: upstream.ok,
      status: upstream.ok ? 200 : upstream.status && upstream.status < 500 ? upstream.status : 502,
      data: {
        ...upstream.data,
        selectedProvider,
        defaultProvider: defaultProvider()
      },
      message: upstream.data?.message || ""
    };
  },

  parseSecret(secretJsonText) {
    const result = parseSecretPayload(secretJsonText);
    if (!result.ok) {
      return { ok: false, status: 400, message: result.message };
    }

    const secret = result.data;
    const user = typeof secret.user === "object" && secret.user ? secret.user : {};
    const account = typeof secret.account === "object" && secret.account ? secret.account : {};

    return {
      ok: true,
      status: 200,
      data: {
        userEmail: secret.userEmail,
        hasToken: true,
        hasFullAuthData: true,
        userName: typeof user.name === "string" ? user.name : "",
        userId: typeof user.id === "string" ? user.id : "",
        accountId: typeof account.id === "string" ? account.id : "",
        accountPlanType: typeof account.planType === "string" ? account.planType : "",
        accountStructure: typeof account.structure === "string" ? account.structure : "",
        authProvider: typeof secret.authProvider === "string" ? secret.authProvider : "",
        expires: typeof secret.expires === "string" ? secret.expires : ""
      },
      parsedSecret: secret
    };
  },

  async confirmRecharge(input) {
    const { cardInfo, productId, overwriteRecharge, siteSource } = input;

    if (!requiredString(cardInfo)) {
      return { ok: false, status: 400, message: "缺少卡密。" };
    }

    const parsed = parseRechargeInput(input);
    if (!parsed.ok) return { ok: false, status: 400, message: parsed.message };

    const selectedProvider = resolveProvider(input.provider);
    const adapter = getProviderAdapter(selectedProvider);
    const secret = parsed.data;
    const providerData = normalizedProviderData(selectedProvider);
    const cardMask = maskCard(cardInfo.trim());
    const order = store.createOrder({
      siteSource,
      provider: selectedProvider,
      cardMask,
      productId: Number(productId || config.defaultProductId),
      providerSessionId: input.providerSessionId || "",
      cardInfoCiphertext: encryptProtected(cardInfo.trim(), "recharge-card-info"),
      overwriteRecharge,
      subscriptionCancellationStatus: selectedProvider === "h" ? "not_started" : "",
      status: "processing",
      message: `任务已创建，等待${providerData.providerLabel}处理。`
    });

    store.createRechargeSession({
      orderId: order.id,
      userEmail: secret.userEmail,
      tokenHash: sha256(secret.userGptToken),
      authDataCiphertext: encryptProtected(JSON.stringify(secret.fullAuthData), "recharge-auth-data"),
      rawSecretCiphertext: encryptProtected(input.secretJsonText || JSON.stringify(secret.fullAuthData), "recharge-secret-json")
    });

    const upstreamPayload = {
      cardInfo: cardInfo.trim(),
      orderId: order.id,
      userEmail: secret.userEmail,
      accountId: typeof secret.account?.id === "string" ? secret.account.id : "",
      userGptToken: secret.userGptToken,
      fullAuthData: secret.fullAuthData,
      providerSessionId: input.providerSessionId || "",
      authProvider: typeof secret.authProvider === "string" ? secret.authProvider : "",
      productId: Number(productId || config.defaultProductId),
      plan: config.hifupayPlan,
      overwriteRecharge: Boolean(overwriteRecharge)
    };

    store.addLog({
      orderId: order.id,
      step: `${selectedProvider}.start.request`,
      requestSummary: logPayload({
        provider: selectedProvider,
        cardMask,
        userEmail: secret.userEmail,
        productId: upstreamPayload.productId,
        overwriteRecharge: upstreamPayload.overwriteRecharge
      }),
      responseSummary: "pending"
    });

    let upstream;
    try {
      upstream = await adapter.startRecharge(upstreamPayload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "充值通道请求异常。";
      store.updateOrder(order.id, { status: "failed", message: `充值提交失败：${message}` });
      store.addLog({
        orderId: order.id,
        step: `${selectedProvider}.start.error`,
        requestSummary: JSON.stringify({ provider: selectedProvider, cardMask, userEmail: secret.userEmail }),
        responseSummary: message
      });
      return {
        ok: false,
        status: 200,
        data: {
          orderId: order.id,
          taskId: "",
          status: "failed",
          message: `充值提交失败：${message}`,
          ...providerData
        }
      };
    }
    const upstreamTaskId = upstream.data?.taskId || "";
    const message = upstream.data?.message || "充值已提交，正在处理。";
    const status = upstream.ok ? upstream.data?.status || "processing" : "failed";

    store.updateOrder(order.id, {
      upstreamTaskId,
      ...(selectedProvider === "h" ? { hCardId: upstream.data?.cardId || "" } : {}),
      ...(selectedProvider === "h" && upstream.data?.hifupayCardId ? { hifupayCardId: upstream.data.hifupayCardId } : {}),
      status,
      message
    });

    store.addLog({
      orderId: order.id,
      step: `${selectedProvider}.start.response`,
      requestSummary: "completed",
      responseSummary: logPayload({
        ok: upstream.ok,
        status: upstream.status,
        upstreamTaskId: selectedProvider === "xiaoyu" ? maskCard(upstreamTaskId) : upstreamTaskId,
        message
      })
    });

    return {
      ok: upstream.ok,
      status: upstream.ok ? 200 : upstream.status && upstream.status < 500 ? 200 : 502,
      data: {
        orderId: order.id,
        taskId: upstreamTaskId,
        status,
        message: upstream.ok ? "充值请求已提交，正在排队处理，请勿重复提交。" : message,
        queueSubmitted: selectedProvider === "czgpt",
        ...providerData
      }
    };
  },

  async getStatus(orderId) {
    const order = store.getOrder(orderId);
    if (!order) {
      return { ok: false, status: 404, message: "订单不存在。" };
    }

    return this.queryTaskStatus({
      orderId: order.id,
      taskId: order.upstreamTaskId
    });
  },

  async queryTaskStatus(input, options = {}) {
    const order = requiredString(input.orderId)
      ? store.getOrder(input.orderId)
      : requiredString(input.taskId)
        ? store.getOrderByUpstreamTaskId(input.taskId)
        : null;
    const taskId = order?.upstreamTaskId || input.taskId || "";

    const hSubscriptionPending = order?.provider === "h" && order.subscriptionCancellationStatus === "pending";
    if (order?.status === "success" && !options.forceRefresh && !hSubscriptionPending) {
      return {
        ok: true,
        status: 200,
        data: {
          orderId: order.id,
          taskId,
          status: "success",
          message: order.message,
          ...subscriptionPublicData(order),
          ...normalizedProviderData(order.provider)
        }
      };
    }

    if (!requiredString(taskId)) {
      if (order) {
        return {
          ok: true,
          status: 200,
          data: {
            orderId: order.id,
            taskId: "",
            status: order.status,
            message: order.message,
            ...subscriptionPublicData(order),
            ...normalizedProviderData(order.provider)
          }
        };
      }
      return { ok: false, status: 400, message: "缺少任务号。" };
    }

    const selectedProvider = resolveProvider(order?.provider || input.provider);
    const adapter = getProviderAdapter(selectedProvider);
    const upstream = await adapter.queryTaskStatus({
      taskId,
      productId: order?.productId || Number(input.productId || config.defaultProductId),
      cardInfo: input.cardInfo || ""
    });

    const taskData = selectedProvider === "czgpt"
      ? await reconcileCzgptStatus(adapter, upstream.data || {}, input.cardInfo || "")
      : upstream.data || {};
    const reportedStatus = taskData.status || "processing";
    const nextStatus = selectedProvider === "h" && order?.status === "success" ? "success" : reportedStatus;
    const subscriptionPatch = hSubscriptionPatch(order, taskData, nextStatus);
    const message = hSubscriptionMessage(taskData.message || "", subscriptionPatch);

    if (order) {
      if (selectedProvider === "h" && order.hCardId) {
        if (nextStatus === "success") {
          store.completeHCard(order.hCardId, order.id);
        }
      }

      if (
        selectedProvider === "h" &&
        order.hifupayCardId &&
        ["success", "failed", "needs_review"].includes(nextStatus) &&
        (nextStatus !== "success" || order.status !== "success")
      ) {
        if (nextStatus === "success" && taskData.paymentConfirmed === true && typeof adapter.listCards === "function") {
          try {
            const latestCards = await adapter.listCards();
            if (latestCards.ok && Array.isArray(latestCards.data?.cards)) store.syncHifupayCards(latestCards.data.cards);
          } catch {
            // 余额学习失败不影响已经确认的充值结果。
          }
        }
        const storedSecret = store.getRechargeSession(order.id);
        const parsedSecret = parseStoredSecret(order, storedSecret);
        store.recordHifupayResult({
          cardId: order.hifupayCardId,
          orderId: order.id,
          plan: config.hifupayPlan,
          identity: parsedSecret.ok ? { email: parsedSecret.data.userEmail, accountId: parsedSecret.data.account?.id || "" } : {},
          paymentConfirmed: taskData.paymentConfirmed === true,
          status: nextStatus
        });
      }

      store.updateOrder(order.id, {
        status: nextStatus,
        message,
        ...subscriptionPatch,
        lastStatusSyncAt: subscriptionPatch.lastStatusSyncAt || new Date().toISOString()
      });

      if (selectedProvider === "h" && subscriptionPatch.subscriptionActionRequired && !options.suppressAlertDispatch) {
        await this.dispatchHSubscriptionAlerts();
      }

      store.addLog({
        orderId: order.id,
        step: `${selectedProvider}.status`,
        requestSummary: logPayload({
          taskId: selectedProvider === "xiaoyu" ? maskCard(taskId) : taskId,
          productId: order.productId
        }),
        responseSummary: logPayload({
          ok: upstream.ok,
          status: upstream.status,
          upstreamStatus: taskData.upstreamStatus || nextStatus,
          cardStatus: taskData.cardStatus || "",
          queueAhead: taskData.queueAhead ?? null,
          remainingSeconds: taskData.remainingSeconds ?? null,
          message
        })
      });
    }

    const statusResolved = upstream.ok || taskData.cardStatusVerified === true;

    return {
      ok: statusResolved,
      status: statusResolved ? 200 : 502,
      data: {
        orderId: order?.id || "",
        taskId,
        status: nextStatus,
        message,
        upstreamStatus: taskData.upstreamStatus || "",
        cardStatus: taskData.cardStatus || "",
        cardStatusVerified: taskData.cardStatusVerified === true,
        boundEmailMasked: taskData.boundEmailMasked || "",
        usedAt: taskData.usedAt || "",
        queueAhead: taskData.queueAhead ?? null,
        remainingSeconds: taskData.remainingSeconds ?? null,
        ...subscriptionPublicData({ ...order, ...subscriptionPatch }),
        ...normalizedProviderData(selectedProvider)
      }
    };
  }
};
