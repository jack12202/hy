import { config } from "./config.js";
import { getProviderAdapter, listProviders } from "./providers/index.js";
import { JsonStore } from "./store.js";
import {
  encodeJson,
  maskCard,
  normalizeProvider,
  requiredString,
  safeJsonParse,
  sha256,
  tryParseJsonText
} from "./utils.js";

const store = new JsonStore();

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
      overwriteRecharge,
      status: "processing",
      message: `任务已创建，等待${providerData.providerLabel}处理。`
    });

    store.createRechargeSession({
      orderId: order.id,
      userEmail: secret.userEmail,
      tokenHash: sha256(secret.userGptToken),
      authDataEncoded: encodeJson(secret.fullAuthData)
    });

    const upstreamPayload = {
      cardInfo: cardInfo.trim(),
      userEmail: secret.userEmail,
      userGptToken: secret.userGptToken,
      fullAuthData: secret.fullAuthData,
      authProvider: typeof secret.authProvider === "string" ? secret.authProvider : "",
      productId: Number(productId || config.defaultProductId),
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

    const upstream = await adapter.startRecharge(upstreamPayload);
    const upstreamTaskId = upstream.data?.taskId || "";
    const message = upstream.data?.message || "充值已提交，正在处理。";
    const status = upstream.ok ? upstream.data?.status || "processing" : "failed";

    store.updateOrder(order.id, {
      upstreamTaskId,
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
        upstreamTaskId,
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
        message,
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

  async queryTaskStatus(input) {
    const order = requiredString(input.orderId)
      ? store.getOrder(input.orderId)
      : requiredString(input.taskId)
        ? store.getOrderByUpstreamTaskId(input.taskId)
        : null;
    const taskId = order?.upstreamTaskId || input.taskId || "";

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
    const nextStatus = taskData.status || "processing";
    const message = taskData.message || "";

    if (order) {
      store.updateOrder(order.id, {
        status: nextStatus,
        message
      });

      store.addLog({
        orderId: order.id,
        step: `${selectedProvider}.status`,
        requestSummary: logPayload({
          taskId,
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
        ...normalizedProviderData(selectedProvider)
      }
    };
  }
};
