import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { decryptSecretText, encryptSecretText } from "./utils.js";

const PROVIDER_CONFIG_VERSION = 2;
const RECHARGE_SECRET_RETENTION_DAYS = 45;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function cardCodeHash(cardCode) {
  return crypto.createHash("sha256").update(cardCode).digest("hex");
}

function cardMask(cardCode) {
  return cardCode.length <= 8 ? `${cardCode.slice(0, 2)}****${cardCode.slice(-2)}` : `${cardCode.slice(0, 4)}****${cardCode.slice(-4)}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccountId(value) {
  return String(value || "").trim();
}

function hasAccountIdentity(identity = {}) {
  return Boolean(normalizeEmail(identity.email) || normalizeAccountId(identity.accountId));
}

function cardIdentityMatches(card, identity = {}) {
  const email = normalizeEmail(identity.email);
  const accountId = normalizeAccountId(identity.accountId);
  const checks = [];
  if (card.boundEmail) checks.push(email && card.boundEmail === email);
  if (card.boundAccountId) checks.push(accountId && card.boundAccountId === accountId);
  return checks.length > 0 && checks.every(Boolean);
}

function hifupayIdentityMatches(user, identity = {}) {
  const email = normalizeEmail(identity.email);
  const accountId = normalizeAccountId(identity.accountId);
  return Boolean(
    (email && normalizeEmail(user?.email) === email) ||
    (accountId && normalizeAccountId(user?.accountId) === accountId)
  );
}

function hifupayCardId(value) {
  return String(value ?? "").trim();
}

function hifupayRemoteStatus(value) {
  const status = String(value || "active").trim().toLowerCase();
  return status || "active";
}

function hifupayBalance(value) {
  const balance = Number(value);
  return Number.isFinite(balance) ? balance : null;
}

function maxIsoDate(values = []) {
  const dates = values
    .map(value => String(value || ""))
    .filter(Boolean)
    .map(value => ({ value, time: Date.parse(value) }))
    .filter(item => Number.isFinite(item.time))
    .sort((left, right) => right.time - left.time);
  return dates[0]?.value || "";
}

function hCardQueryStatus(card, order) {
  if (card.disabledAt || card.archivedAt || card.status === "expired") return "disabled";
  if (card.status === "unused") return "unused";
  if (card.status === "used" || order?.status === "success") return "success";
  if (order?.status === "failed") return "failed";
  if (
    card.status === "reserved" ||
    ["created", "queued", "processing", "syncing", "needs_review"].includes(order?.status)
  ) return "processing";
  return "locked";
}

function hCardCompletedAt(card, order, status) {
  if (status === "success") return card.usedAt || order?.manualCompletedAt || order?.updatedAt || "";
  if (status === "failed") return order?.updatedAt || "";
  if (status === "disabled") return card.disabledAt || card.archivedAt || card.updatedAt || "";
  return "";
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

function generateCardCode() {
  return `HPLUS${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
}

function createInitialState() {
  return {
    orders: [],
    rechargeSessions: [],
    rechargeLogs: [],
    hCards: [],
    hifupayCards: [],
    settings: {
      defaultProvider: config.defaultProvider,
      providerConfigVersion: PROVIDER_CONFIG_VERSION,
      providerUpdatedAt: "",
      providerUpdatedBy: "",
      hifupayCardsUpdatedAt: ""
    }
  };
}

function normalizeState(state) {
  const initial = createInitialState();
  const savedSettings = state?.settings || {};
  const settings = {
    ...initial.settings,
    ...savedSettings
  };

  if (Number(savedSettings.providerConfigVersion || 0) < PROVIDER_CONFIG_VERSION) {
    settings.defaultProvider = config.defaultProvider;
    settings.providerConfigVersion = PROVIDER_CONFIG_VERSION;
    settings.providerUpdatedAt = nowIso();
    settings.providerUpdatedBy = "provider-config-v2";
  }

  return {
    ...initial,
    ...state,
    orders: Array.isArray(state?.orders) ? state.orders : [],
    rechargeSessions: Array.isArray(state?.rechargeSessions) ? state.rechargeSessions : [],
    rechargeLogs: Array.isArray(state?.rechargeLogs) ? state.rechargeLogs : [],
    hCards: Array.isArray(state?.hCards) ? state.hCards : [],
    hifupayCards: Array.isArray(state?.hifupayCards) ? state.hifupayCards : [],
    settings
  };
}

export class JsonStore {
  constructor(filePath = config.dataFile) {
    this.filePath = filePath;
    ensureDir(filePath);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(createInitialState(), null, 2));
    }
  }

  read() {
    const raw = fs.readFileSync(this.filePath, "utf8");
    return raw.trim() ? normalizeState(JSON.parse(raw)) : createInitialState();
  }

  write(state) {
    ensureDir(this.filePath);
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
  }

  createOrder(input) {
    const state = this.read();
    const order = {
      id: makeId("order"),
      siteSource: input.siteSource || "unknown",
      provider: input.provider || config.defaultProvider,
      cardMask: input.cardMask || "",
      productId: input.productId ?? config.defaultProductId,
      status: input.status || "created",
      upstreamTaskId: input.upstreamTaskId || "",
      hCardId: input.hCardId || "",
      providerSessionId: input.providerSessionId || "",
      cardInfoCiphertext: input.cardInfoCiphertext || "",
      message: input.message || "",
      overwriteRecharge: Boolean(input.overwriteRecharge),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    state.orders.push(order);
    this.write(state);
    return order;
  }

  updateOrder(orderId, patch) {
    const state = this.read();
    const order = state.orders.find((item) => item.id === orderId);
    if (!order) return null;
    Object.assign(order, patch, { updatedAt: nowIso() });
    this.write(state);
    return order;
  }

  getOrder(orderId) {
    const state = this.read();
    return state.orders.find((item) => item.id === orderId) || null;
  }

  getOrderByUpstreamTaskId(upstreamTaskId) {
    const state = this.read();
    return state.orders.find((item) => item.upstreamTaskId === upstreamTaskId) || null;
  }

  getSettings() {
    return this.read().settings;
  }

  updateSettings(patch) {
    const state = this.read();
    state.settings = {
      ...state.settings,
      ...patch
    };
    this.write(state);
    return state.settings;
  }

  getHifupayEstimatedCharge(plan = "plus") {
    const normalizedPlan = String(plan || "plus").toLowerCase();
    if (normalizedPlan !== "plus") return Math.max(Number(config.hifupayEstimatedProChargeUsd) || 0, 0);
    const learned = Number(this.read().settings.hifupayLastPlusChargeUsd);
    return Number.isFinite(learned) && learned > 0 ? learned : Math.max(Number(config.hifupayEstimatedPlusChargeUsd) || 16, 0);
  }

  createRechargeSession(input) {
    const state = this.read();
    const session = {
      id: makeId("session"),
      orderId: input.orderId,
      userEmail: input.userEmail || "",
      tokenHash: input.tokenHash || "",
      authDataCiphertext: input.authDataCiphertext || "",
      rawSecretCiphertext: input.rawSecretCiphertext || "",
      authDataEncoded: input.authDataEncoded || "",
      createdAt: nowIso()
    };
    state.rechargeSessions.push(session);
    this.write(state);
    return session;
  }

  addLog(input) {
    const state = this.read();
    const log = {
      id: makeId("log"),
      orderId: input.orderId || "",
      step: input.step || "",
      requestSummary: input.requestSummary || "",
      responseSummary: input.responseSummary || "",
      createdAt: nowIso()
    };
    state.rechargeLogs.push(log);
    this.write(state);
    return log;
  }

  createHCards({ count = 1, productId = 3, source = "未分类" } = {}) {
    const safeCount = Math.min(Math.max(Number(count) || 1, 1), 100);
    const createdAt = nowIso();
    const batchId = makeId("batch");
    const normalizedSource = String(source || "未分类").trim().slice(0, 40) || "未分类";
    const state = this.read();
    const result = [];

    for (let index = 0; index < safeCount; index += 1) {
      const code = generateCardCode();
      const card = {
        id: makeId("hcard"),
        provider: "h",
        batchId,
        source: normalizedSource,
        productId: Number(productId) || 3,
        codeHash: cardCodeHash(code),
        codeCiphertext: encryptProtected(code, "h-card-code"),
        cardMask: cardMask(code),
        status: "unused",
        orderId: "",
        boundEmail: "",
        boundAccountId: "",
        boundAt: "",
        lockReason: "",
        disabledAt: "",
        disabledReason: "",
        archivedAt: "",
        hasSubmission: false,
        submittedAt: "",
        expiresAt: "",
        createdAt,
        updatedAt: createdAt
      };
      state.hCards.push(card);
      result.push({
        id: card.id,
        sequence: index + 1,
        code,
        cardMask: card.cardMask,
        status: card.status,
        source: card.source,
        batchId,
        createdAt,
        expiresAt: "",
        link: `https://www.gptc.cc/activate/?provider=h&card=${encodeURIComponent(code)}`
      });
    }

    this.write(state);
    return result;
  }

  listHCards(limit = 100, all = false, reveal = false, includeArchived = false) {
    const cards = this.read().hCards.filter(card => includeArchived || !card.archivedAt);
    const selected = all
      ? cards
      : cards.slice(-Math.min(Math.max(Number(limit) || 100, 1), 500));
    return selected
      .reverse()
      .map(card => ({
        id: card.id,
        provider: card.provider,
        batchId: card.batchId || "",
        source: card.source || "未分类",
        productId: card.productId,
        cardMask: card.cardMask,
        ...(reveal && card.codeCiphertext ? { code: decryptProtected(card.codeCiphertext, "h-card-code") } : {}),
        status: card.disabledAt ? "disabled" : card.status,
        orderId: card.orderId || "",
        boundEmail: card.boundEmail || "",
        boundAccountId: card.boundAccountId || "",
        boundAt: card.boundAt || "",
        lockReason: card.lockReason || "",
        disabledAt: card.disabledAt || "",
        disabledReason: card.disabledReason || "",
        archivedAt: card.archivedAt || "",
        hasSubmission: Boolean(card.hasSubmission || card.submittedAt || card.boundAt || card.usedAt),
        submittedAt: card.submittedAt || card.boundAt || "",
        expiresAt: card.expiresAt || "",
        createdAt: card.createdAt,
        usedAt: card.usedAt || ""
      }));
  }

  syncHifupayCards(remoteCards = []) {
    const state = this.read();
    const timestamp = nowIso();
    const cards = Array.isArray(remoteCards) ? remoteCards : [];
    const seenIds = new Set();

    for (const remote of cards) {
      const id = hifupayCardId(remote.id ?? remote.cardId ?? remote.card_id);
      if (!id) continue;
      seenIds.add(id);
      const current = state.hifupayCards.find(item => item.id === id);
      const card = current || {
        id,
        lastFour: "",
        status: "active",
        balance: null,
        expiryDate: "",
        enabled: true,
        priority: 0,
        plusUsers: [],
        inFlightOrders: [],
        createdAt: timestamp
      };
      Object.assign(card, {
        id,
        lastFour: String(remote.lastFour ?? remote.last4 ?? remote.last_four ?? card.lastFour ?? ""),
        status: hifupayRemoteStatus(remote.status ?? remote.state ?? card.status),
        balance: hifupayBalance(remote.balance ?? remote.availableBalance ?? remote.available_balance ?? card.balance),
        expiryDate: String(remote.expiryDate ?? remote.expiry_date ?? remote.expiry ?? card.expiryDate ?? ""),
        updatedAt: timestamp
      });
      if (!Array.isArray(card.plusUsers)) card.plusUsers = [];
      if (!Array.isArray(card.inFlightOrders)) card.inFlightOrders = [];
      if (typeof card.enabled !== "boolean") card.enabled = true;
      if (!state.hifupayCards.includes(card)) state.hifupayCards.push(card);
    }

    for (const card of state.hifupayCards) {
      if (!seenIds.has(card.id)) {
        card.status = "unavailable";
        card.updatedAt = timestamp;
      }
    }

    state.settings.hifupayCardsUpdatedAt = timestamp;
    this.write(state);
    return this.listHifupayCards();
  }

  listHifupayCards() {
    const state = this.read();
    const maxPlusUsers = Math.max(Number(config.hifupayMaxPlusUsers) || 4, 1);
    const learnedCharge = Number(state.settings.hifupayLastPlusChargeUsd);
    const estimatedCharge = Number.isFinite(learnedCharge) && learnedCharge > 0
      ? learnedCharge
      : Math.max(Number(config.hifupayEstimatedPlusChargeUsd) || 16, 0);
    const safetyBuffer = Math.max(Number(config.hifupaySafetyBufferUsd) || 0, 0);
    return state.hifupayCards.map(card => {
      const plusUsers = Array.isArray(card.plusUsers) ? card.plusUsers : [];
      const inFlightOrders = Array.isArray(card.inFlightOrders) ? card.inFlightOrders : [];
      const plusInFlight = inFlightOrders.filter(item => item.plan === "plus").length;
      const reservedBalance = inFlightOrders.reduce((sum, item) => sum + (Number(item.estimatedChargeUsd) || 0), 0);
      const holdUntil = maxIsoDate(plusUsers.map(user => user.upgradeUntil));
      const full = false;
      const expiredHold = full && (!holdUntil || Date.parse(holdUntil) <= Date.now());
      let poolStatus = "ready";
      if (!card.enabled) poolStatus = "disabled";
      else if (hifupayRemoteStatus(card.status) !== "active") poolStatus = "upstream_unavailable";
      else if (full) poolStatus = expiredHold ? "full_expired" : "full_hold";
      else if (card.balance === null || card.balance - reservedBalance < estimatedCharge + safetyBuffer) poolStatus = "low_balance";
      else if (plusInFlight > 0) poolStatus = "reserved";

      return {
        id: card.id,
        lastFour: card.lastFour || "",
        status: hifupayRemoteStatus(card.status),
        poolStatus,
        enabled: card.enabled !== false,
        priority: Number(card.priority) || 0,
        balance: card.balance,
        reservedBalance,
        availableBalance: card.balance === null ? null : Math.max(card.balance - reservedBalance, 0),
        maxPlusUsers,
        plusUsed: plusUsers.length,
        automaticPlusUsed: plusUsers.length,
        plusRemaining: null,
        inFlightCount: inFlightOrders.length,
        holdUntil,
        expiryDate: card.expiryDate || "",
        plusUsers: plusUsers.map(user => ({
          email: user.email || "",
          accountId: user.accountId || "",
          orderId: user.orderId || "",
          plusAt: user.plusAt || "",
          upgradeUntil: user.upgradeUntil || "",
          proAt: user.proAt || ""
        })),
        inFlightOrders: inFlightOrders.map(item => ({
          orderId: item.orderId || "",
          plan: item.plan || "",
          state: item.state || "processing",
          reservedAt: item.reservedAt || ""
        })),
        updatedAt: card.updatedAt || card.createdAt || ""
      };
    }).sort((left, right) => (left.priority - right.priority) || left.id.localeCompare(right.id));
  }

  reserveHifupayCard({ orderId, plan = "plus", identity = {}, estimatedChargeUsd = 0, preferredCardId = "" } = {}) {
    const normalizedOrderId = String(orderId || "").trim();
    const normalizedPlan = String(plan || "plus").trim().toLowerCase();
    if (!normalizedOrderId) return { ok: false, status: "invalid", message: "缺少订单号，无法选择嗨付卡片。" };

    const state = this.read();
    const maxPlusUsers = Math.max(Number(config.hifupayMaxPlusUsers) || 4, 1);
    const charge = Math.max(Number(estimatedChargeUsd) || 0, 0);
    const safetyBuffer = Math.max(Number(config.hifupaySafetyBufferUsd) || 0, 0);
    if (normalizedPlan !== "plus" && charge <= 0) {
      return { ok: false, status: "unavailable", message: "Pro 充值金额尚未配置，暂不自动选择卡片。" };
    }
    const candidates = [];

    for (const card of state.hifupayCards) {
      if (card.inFlightOrders?.some(item => item.orderId === normalizedOrderId)) {
        return { ok: true, cardId: card.id, hifupayCardId: card.id, reused: true };
      }
      if (card.enabled === false || hifupayRemoteStatus(card.status) !== "active") continue;
      if (card.balance === null || card.balance < charge + safetyBuffer) continue;
      const inFlight = Array.isArray(card.inFlightOrders) ? card.inFlightOrders : [];
      const reservedBalance = inFlight.reduce((sum, item) => sum + (Number(item.estimatedChargeUsd) || 0), 0);
      if (card.balance - reservedBalance < charge + safetyBuffer) continue;
      const plusUsers = Array.isArray(card.plusUsers) ? card.plusUsers : [];
      if (normalizedPlan === "plus") {
        if (plusUsers.some(user => hifupayIdentityMatches(user, identity))) continue;
      } else {
        const boundUser = plusUsers.find(user => hifupayIdentityMatches(user, identity));
        if (!boundUser || !boundUser.upgradeUntil || Date.parse(boundUser.upgradeUntil) <= Date.now()) continue;
      }

      candidates.push({ card, plusUsers, inFlight });
    }

    candidates.sort((left, right) => {
      const preferred = hifupayCardId(preferredCardId);
      if (preferred && left.card.id === preferred && right.card.id !== preferred) return -1;
      if (preferred && right.card.id === preferred && left.card.id !== preferred) return 1;
      return (Number(left.card.priority) || 0) - (Number(right.card.priority) || 0) || left.card.id.localeCompare(right.card.id);
    });

    const selected = candidates[0]?.card;
    if (!selected) {
      return {
        ok: false,
        status: "unavailable",
        message: normalizedPlan === "plus"
          ? "当前没有余额充足且状态正常的 Plus 卡片。"
          : "当前账号没有处于 30 天升级期内的嗨付卡片。"
      };
    }

    if (!Array.isArray(selected.inFlightOrders)) selected.inFlightOrders = [];
    selected.inFlightOrders.push({
      orderId: normalizedOrderId,
      plan: normalizedPlan,
      email: normalizeEmail(identity.email),
      accountId: normalizeAccountId(identity.accountId),
      estimatedChargeUsd: charge,
      balanceBefore: selected.balance,
      state: "processing",
      reservedAt: nowIso()
    });
    selected.updatedAt = nowIso();
    this.write(state);
    return { ok: true, cardId: selected.id, hifupayCardId: selected.id, lastFour: selected.lastFour || "", reused: false };
  }

  recordHifupayResult({ cardId, orderId, plan = "plus", identity = {}, paymentConfirmed = false, status = "" } = {}) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不在本地卡池中。" };
    if (!Array.isArray(card.inFlightOrders)) card.inFlightOrders = [];
    if (!Array.isArray(card.plusUsers)) card.plusUsers = [];
    const inFlightIndex = card.inFlightOrders.findIndex(item => item.orderId === String(orderId || ""));
    const inFlight = inFlightIndex >= 0 ? card.inFlightOrders[inFlightIndex] : null;

    if (status === "needs_review" && !paymentConfirmed) {
      if (inFlight) inFlight.state = "needs_review";
      card.updatedAt = nowIso();
      this.write(state);
      return { ok: true, status: "needs_review", cardId: card.id };
    }

    let learnedChargeUsd = null;
    if (paymentConfirmed && plan === "plus" && inFlight && card.inFlightOrders.length === 1) {
      const before = Number(inFlight.balanceBefore);
      const after = Number(card.balance);
      const difference = before - after;
      if (Number.isFinite(difference) && difference >= 10 && difference <= 30) {
        learnedChargeUsd = Math.round(difference * 100) / 100;
        state.settings.hifupayLastPlusChargeUsd = learnedChargeUsd;
        state.settings.hifupayLastPlusChargeUpdatedAt = nowIso();
      }
    }
    if (inFlightIndex >= 0) card.inFlightOrders.splice(inFlightIndex, 1);
    if (paymentConfirmed) {
      const email = normalizeEmail(identity.email || inFlight?.email);
      const accountId = normalizeAccountId(identity.accountId || inFlight?.accountId);
      let user = card.plusUsers.find(item => hifupayIdentityMatches(item, { email, accountId }));
      if (plan === "plus") {
        if (!user) {
          const plusAt = nowIso();
          user = {
            email,
            accountId,
            orderId: String(orderId || ""),
            plusAt,
            upgradeUntil: new Date(Date.now() + Math.max(Number(config.hifupayUpgradeWindowDays) || 30, 1) * 24 * 60 * 60 * 1000).toISOString(),
            proAt: ""
          };
          card.plusUsers.push(user);
        }
      } else if (user) {
        user.proAt = nowIso();
      }
    }
    card.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: paymentConfirmed ? "recorded" : "released", cardId: card.id, learnedChargeUsd };
  }

  clearHifupayReservation(cardId, orderId) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    if (!card || !Array.isArray(card.inFlightOrders)) return { ok: false, status: "not_found", message: "嗨付卡片或预留不存在。" };
    const before = card.inFlightOrders.length;
    card.inFlightOrders = card.inFlightOrders.filter(item => item.orderId !== String(orderId || ""));
    if (before === card.inFlightOrders.length) return { ok: false, status: "not_found", message: "嗨付卡片预留不存在。" };
    card.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: "released", cardId: card.id };
  }

  setHifupayCardEnabled(cardId, enabled) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不存在。" };
    card.enabled = Boolean(enabled);
    card.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: card.enabled ? "enabled" : "disabled", cardId: card.id };
  }

  setHifupayCardPriority(cardId, priority) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不存在。" };
    card.priority = Math.max(Number(priority) || 0, 0);
    card.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: "updated", cardId: card.id, priority: card.priority };
  }

  getHCardCode(cardId) {
    const card = this.read().hCards.find(item => item.id === cardId);
    return card?.codeCiphertext ? decryptProtected(card.codeCiphertext, "h-card-code") : "";
  }

  getHCardByCode(cardCode) {
    const normalized = String(cardCode || "").trim().toUpperCase();
    if (!normalized) return null;
    const state = this.read();
    return state.hCards.find(card => card.codeHash === cardCodeHash(normalized)) || null;
  }

  queryHCardsByCodes(cardCodes = []) {
    const normalizedCodes = (Array.isArray(cardCodes) ? cardCodes : [])
      .map(code => String(code || "").trim().toUpperCase());
    const state = this.read();
    const cardsByHash = new Map(
      state.hCards
        .filter(card => card.provider === "h")
        .map(card => [card.codeHash, card])
    );
    const ordersById = new Map(state.orders.map(order => [order.id, order]));
    const latestOrdersByCardId = new Map();

    for (const order of state.orders) {
      if (order.provider !== "h" || !order.hCardId) continue;
      const current = latestOrdersByCardId.get(order.hCardId);
      if (!current || String(order.updatedAt || order.createdAt).localeCompare(String(current.updatedAt || current.createdAt)) > 0) {
        latestOrdersByCardId.set(order.hCardId, order);
      }
    }

    return normalizedCodes.map(code => {
      const card = cardsByHash.get(cardCodeHash(code));
      if (!card) return { code, found: false };
      const order = (card.orderId && ordersById.get(card.orderId)) || latestOrdersByCardId.get(card.id) || null;
      const status = hCardQueryStatus(card, order);
      return {
        code,
        found: true,
        provider: card.provider,
        status,
        boundEmail: card.boundEmail || "",
        boundAccountId: card.boundAccountId || "",
        source: card.source || "未分类",
        batchId: card.batchId || "",
        createdAt: card.createdAt || "",
        submittedAt: card.submittedAt || card.boundAt || "",
        completedAt: hCardCompletedAt(card, order, status),
        failureMessage: status === "failed" ? order?.message || "" : ""
      };
    });
  }

  verifyHCard(cardCode) {
    const card = this.getHCardByCode(cardCode);
    if (!card) return { ok: false, status: "not_found", message: "激活码不存在，请检查后重新输入。" };

    if (card.archivedAt) return { ok: false, status: "archived", message: "卡密已归档，请联系客服处理。" };
    if (card.disabledAt) return { ok: false, status: "disabled", message: "卡密已被后台禁用，请联系客服处理。" };
    if (card.status === "unused" && card.expiresAt && Date.parse(card.expiresAt) <= Date.now()) {
      this.updateHCard(card.id, { status: "expired" });
      return { ok: false, status: "expired", message: "激活码已过期，请联系人工处理。" };
    }
    if (card.status === "used") return { ok: false, status: "used", message: "卡密已使用，请勿重复提交。" };
    if (card.status === "reserved") return { ok: false, status: "reserved", message: "卡密正在处理中，请勿重复提交。" };
    if (card.status === "locked") return { ok: false, status: "locked", message: "卡密已锁定，请勿重复提交。" };
    if (card.status !== "unused") return { ok: false, status: card.status, message: "当前激活码不可用。" };

    return {
      ok: true,
      status: card.status,
      cardId: card.id,
      productId: card.productId,
      expiresAt: card.expiresAt || ""
    };
  }

  reserveHCard(cardCode, orderId, identity = {}) {
    const normalizedCode = String(cardCode || "").trim().toUpperCase();
    const normalizedOrderId = String(orderId || "").trim();
    if (!normalizedCode || !normalizedOrderId) return { ok: false, status: "invalid", message: "缺少卡密或订单号。" };
    if (!hasAccountIdentity(identity)) return { ok: false, status: "missing_account", message: "缺少账号信息，无法锁定卡密。" };

    const state = this.read();
    const card = state.hCards.find(item => item.codeHash === cardCodeHash(normalizedCode));
    if (!card) return { ok: false, status: "not_found", message: "激活码不存在，请检查后重新输入。" };
    if (card.archivedAt) return { ok: false, status: "archived", message: "卡密已归档，请联系客服处理。" };
    if (card.disabledAt) return { ok: false, status: "disabled", message: "卡密已被后台禁用，请联系客服处理。" };
    if (card.status === "unused" && card.expiresAt && Date.parse(card.expiresAt) <= Date.now()) {
      card.status = "expired";
      card.updatedAt = nowIso();
      this.write(state);
      return { ok: false, status: "expired", message: "激活码已过期，请联系人工处理。" };
    }
    if (card.status === "used") return { ok: false, status: "used", message: "卡密已使用，请勿重复提交。" };
    if (card.status === "reserved") {
      return { ok: false, status: "locked", message: "卡密已锁定，请勿重复提交。" };
    }
    if (card.status === "locked") {
      if (card.orderId && card.orderId !== normalizedOrderId) return { ok: false, status: "locked", message: "卡密已锁定，请勿重复提交。" };
      if (!cardIdentityMatches(card, identity)) {
        return { ok: false, status: "account_mismatch", message: "卡密已绑定其他账号，请联系客服处理。" };
      }
    }
    if (card.status !== "unused" && card.status !== "locked" && card.status !== "reserved") {
      return { ok: false, status: card.status, message: "当前激活码不可用。" };
    }

    const timestamp = nowIso();
    if (card.status === "unused") {
      Object.assign(card, {
        status: "locked",
        boundEmail: normalizeEmail(identity.email),
        boundAccountId: normalizeAccountId(identity.accountId),
        boundAt: card.boundAt || timestamp
      });
    }
    if (!card.codeCiphertext) {
      card.codeCiphertext = encryptProtected(normalizedCode, "h-card-code");
    }
    Object.assign(card, {
      orderId: card.orderId || normalizedOrderId,
      lockReason: "recharge_submitted",
      hasSubmission: true,
      submittedAt: card.submittedAt || timestamp,
      updatedAt: timestamp
    });
    this.write(state);
    return { ok: true, cardId: card.id, productId: card.productId };
  }

  completeHCard(cardId, orderId) {
    return this.transitionHCard(cardId, orderId, "used", { usedAt: nowIso() });
  }

  unlockHCard(cardId) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return { ok: false, status: "not_found", message: "卡密不存在。" };
    if (card.disabledAt) return { ok: false, status: "disabled", message: "请先启用卡密，再执行解锁。" };
    if (card.status === "used") return { ok: false, status: "used", message: "充值成功的卡密不能解锁。" };
    if (card.status !== "locked" && card.status !== "reserved") {
      return { ok: false, status: card.status, message: "当前卡密不需要解锁。" };
    }
    const order = card.orderId ? this.getOrder(card.orderId) : null;
    if (order && order.status !== "failed") {
      return { ok: false, status: "processing", message: "关联订单尚未确认失败，暂不能解锁。" };
    }

    Object.assign(card, {
      status: "unused",
      orderId: "",
      boundEmail: "",
      boundAccountId: "",
      boundAt: "",
      lockReason: "",
      usedAt: "",
      updatedAt: nowIso()
    });
    this.write(state);
    return { ok: true, status: "unused", cardId: card.id };
  }

  setHCardDisabled(cardId, disabled, reason = "") {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return { ok: false, status: "not_found", message: "卡密不存在。" };
    if (disabled) {
      Object.assign(card, {
        disabledAt: card.disabledAt || nowIso(),
        disabledReason: String(reason || "管理员禁用").trim(),
        updatedAt: nowIso()
      });
    } else {
      Object.assign(card, { disabledAt: "", disabledReason: "", updatedAt: nowIso() });
    }
    this.write(state);
    return { ok: true, status: card.disabledAt ? "disabled" : card.status, cardId: card.id };
  }

  archiveHCard(cardId, archived = true) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return { ok: false, status: "not_found", message: "卡密不存在。" };
    Object.assign(card, { archivedAt: archived ? (card.archivedAt || nowIso()) : "", updatedAt: nowIso() });
    this.write(state);
    return { ok: true, status: archived ? "archived" : (card.disabledAt ? "disabled" : card.status), cardId: card.id };
  }

  deleteHCard(cardId) {
    const state = this.read();
    const index = state.hCards.findIndex(item => item.id === cardId);
    if (index < 0) return { ok: false, status: "not_found", message: "卡密不存在。" };
    const card = state.hCards[index];
    const code = card.codeCiphertext ? decryptProtected(card.codeCiphertext, "h-card-code") : "";
    const hasMatchingOrder = state.orders.some(order => {
      if (order.hCardId === card.id || (card.orderId && order.id === card.orderId)) return true;
      const orderCode = order.cardInfoCiphertext ? decryptProtected(order.cardInfoCiphertext, "recharge-card-info") : "";
      return Boolean(code && orderCode && cardCodeHash(orderCode.trim().toUpperCase()) === card.codeHash);
    });
    if (card.hasSubmission || card.submittedAt || card.boundAt || card.usedAt || hasMatchingOrder) {
      return { ok: false, status: "has_submission", message: "这张卡密提交过充值资料，只能归档，不能删除。" };
    }
    if (!["unused", "expired"].includes(card.status) && !card.disabledAt) {
      return { ok: false, status: card.status, message: "只有未使用、已过期或已禁用且没有提交记录的卡密可以删除。" };
    }
    state.hCards.splice(index, 1);
    this.write(state);
    return { ok: true, status: "deleted", cardId };
  }

  bulkHCardAction(cardIds = [], action = "") {
    const ids = [...new Set((Array.isArray(cardIds) ? cardIds : []).map(String).filter(Boolean))];
    const results = ids.map(cardId => {
      if (action === "delete") return { cardId, ...this.deleteHCard(cardId) };
      if (action === "archive") return { cardId, ...this.archiveHCard(cardId, true) };
      if (action === "disable" || action === "enable") return { cardId, ...this.setHCardDisabled(cardId, action === "disable", "管理员批量禁用") };
      return { cardId, ok: false, status: "invalid", message: "不支持的批量操作。" };
    });
    return { total: results.length, successCount: results.filter(item => item.ok).length, failedCount: results.filter(item => !item.ok).length, results };
  }

  updateHCard(cardId, patch) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return null;
    Object.assign(card, patch, { updatedAt: nowIso() });
    this.write(state);
    return card;
  }

  getRechargeSession(orderId) {
    return this.read().rechargeSessions.find(item => item.orderId === orderId) || null;
  }

  purgeExpiredRechargeSecrets(retentionDays = RECHARGE_SECRET_RETENTION_DAYS) {
    const state = this.read();
    const cutoff = Date.now() - Math.max(Number(retentionDays) || RECHARGE_SECRET_RETENTION_DAYS, 1) * 24 * 60 * 60 * 1000;
    const terminalOrders = new Map(state.orders
      .filter(order => order.status === "success")
      .map(order => [order.id, Date.parse(order.manualCompletedAt || order.updatedAt || order.createdAt)]));
    let purged = 0;
    for (const session of state.rechargeSessions) {
      const completedAt = terminalOrders.get(session.orderId);
      if (!Number.isFinite(completedAt) || completedAt > cutoff) continue;
      if (session.rawSecretCiphertext || session.authDataCiphertext || session.authDataEncoded) {
        session.rawSecretCiphertext = "";
        session.authDataCiphertext = "";
        session.authDataEncoded = "";
        session.secretPurgedAt = nowIso();
        purged += 1;
      }
    }
    if (purged) this.write(state);
    return purged;
  }

  purgeRechargeSecretsBefore(cutoffIso) {
    const cutoff = Date.parse(cutoffIso);
    if (!Number.isFinite(cutoff)) return 0;
    const state = this.read();
    const orderTimes = new Map(state.orders.map(order => [order.id, Date.parse(order.createdAt)]));
    let purged = 0;
    for (const session of state.rechargeSessions) {
      const createdAt = orderTimes.get(session.orderId) || Date.parse(session.createdAt);
      if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
      if (session.rawSecretCiphertext || session.authDataCiphertext || session.authDataEncoded) {
        session.rawSecretCiphertext = "";
        session.authDataCiphertext = "";
        session.authDataEncoded = "";
        session.secretPurgedAt = nowIso();
        session.secretPurgeReason = "before-cutoff";
        purged += 1;
      }
    }
    if (purged) this.write(state);
    return purged;
  }

  listRechargeOrders() {
    this.purgeExpiredRechargeSecrets();
    const state = this.read();
    const sessions = new Map(state.rechargeSessions.map(session => [session.orderId, session]));
    return state.orders
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
      .map(order => {
        const session = sessions.get(order.id);
        return {
          id: order.id,
          provider: order.provider,
          cardMask: order.cardMask,
          productId: order.productId,
          status: order.status,
          upstreamTaskId: order.upstreamTaskId || "",
          providerSessionId: order.providerSessionId || "",
          userEmail: session?.userEmail || "",
          message: order.message || "",
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          hasSecret: Boolean(session?.authDataCiphertext || session?.authDataEncoded),
          hasOriginalJson: Boolean(session?.rawSecretCiphertext || session?.authDataCiphertext || session?.authDataEncoded),
          hCardCodeAvailable: Boolean(order.hCardId && this.getHCardCode(order.hCardId))
        };
      });
  }

  listRecoveryOrders() {
    return this.listRechargeOrders().filter(order => ["failed", "needs_review"].includes(order.status));
  }

  getRecoveryOrder(orderId) {
    const state = this.read();
    const order = state.orders.find(item => item.id === orderId) || null;
    if (!order) return null;
    const session = state.rechargeSessions.find(item => item.orderId === orderId) || null;
    return { order, session };
  }

  transitionHCard(cardId, orderId, status, extra = {}) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card || !["locked", "reserved"].includes(card.status) || card.orderId !== orderId) return false;
    const completedPatch = status === "used" ? { disabledAt: "", disabledReason: "" } : {};
    Object.assign(card, { ...completedPatch, ...extra, status, orderId: status === "unused" ? "" : orderId, updatedAt: nowIso() });
    this.write(state);
    return true;
  }
}
