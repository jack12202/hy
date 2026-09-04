import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const PROVIDER_CONFIG_VERSION = 2;

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

function generateCardCode() {
  return `HPLUS${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
}

function createInitialState() {
  return {
    orders: [],
    rechargeSessions: [],
    rechargeLogs: [],
    hCards: [],
    settings: {
      defaultProvider: config.defaultProvider,
      providerConfigVersion: PROVIDER_CONFIG_VERSION,
      providerUpdatedAt: "",
      providerUpdatedBy: ""
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

  createRechargeSession(input) {
    const state = this.read();
    const session = {
      id: makeId("session"),
      orderId: input.orderId,
      userEmail: input.userEmail || "",
      tokenHash: input.tokenHash || "",
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

  createHCards({ count = 1, productId = 3, expiresInDays = 0 } = {}) {
    const safeCount = Math.min(Math.max(Number(count) || 1, 1), 100);
    const days = Math.max(Number(expiresInDays) || 0, 0);
    const createdAt = nowIso();
    const expiresAt = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : "";
    const state = this.read();
    const result = [];

    for (let index = 0; index < safeCount; index += 1) {
      const code = generateCardCode();
      const card = {
        id: makeId("hcard"),
        provider: "h",
        productId: Number(productId) || 3,
        codeHash: cardCodeHash(code),
        cardMask: cardMask(code),
        status: "unused",
        orderId: "",
        expiresAt,
        createdAt,
        updatedAt: createdAt
      };
      state.hCards.push(card);
      result.push({
        id: card.id,
        code,
        cardMask: card.cardMask,
        status: card.status,
        expiresAt: card.expiresAt,
        link: `https://www.gptc.cc/activate/?provider=h&card=${encodeURIComponent(code)}`
      });
    }

    this.write(state);
    return result;
  }

  listHCards(limit = 100) {
    return this.read().hCards
      .slice(-Math.min(Math.max(Number(limit) || 100, 1), 500))
      .reverse()
      .map(card => ({
        id: card.id,
        provider: card.provider,
        productId: card.productId,
        cardMask: card.cardMask,
        status: card.status,
        orderId: card.orderId || "",
        expiresAt: card.expiresAt || "",
        createdAt: card.createdAt,
        usedAt: card.usedAt || ""
      }));
  }

  getHCardByCode(cardCode) {
    const normalized = String(cardCode || "").trim().toUpperCase();
    if (!normalized) return null;
    const state = this.read();
    return state.hCards.find(card => card.codeHash === cardCodeHash(normalized)) || null;
  }

  verifyHCard(cardCode) {
    const card = this.getHCardByCode(cardCode);
    if (!card) return { ok: false, status: "not_found", message: "激活码不存在，请检查后重新输入。" };

    if (card.status === "unused" && card.expiresAt && Date.parse(card.expiresAt) <= Date.now()) {
      this.updateHCard(card.id, { status: "expired" });
      return { ok: false, status: "expired", message: "激活码已过期，请联系人工处理。" };
    }
    if (card.status === "used") return { ok: false, status: "used", message: "卡密已使用，请勿重复提交。" };
    if (card.status === "reserved") return { ok: false, status: "reserved", message: "卡密正在处理中，请勿重复提交。" };
    if (card.status !== "unused") return { ok: false, status: card.status, message: "当前激活码不可用。" };

    return {
      ok: true,
      status: card.status,
      cardId: card.id,
      productId: card.productId,
      expiresAt: card.expiresAt || ""
    };
  }

  reserveHCard(cardCode, orderId) {
    const result = this.verifyHCard(cardCode);
    if (!result.ok) return result;
    return this.updateHCard(result.cardId, { status: "reserved", orderId })
      ? { ok: true, cardId: result.cardId, productId: result.productId }
      : { ok: false, status: "storage_error", message: "卡密锁定失败，请稍后重试。" };
  }

  completeHCard(cardId, orderId) {
    return this.transitionHCard(cardId, orderId, "used", { usedAt: nowIso() });
  }

  releaseHCard(cardId, orderId) {
    return this.transitionHCard(cardId, orderId, "unused", { usedAt: "" });
  }

  updateHCard(cardId, patch) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return null;
    Object.assign(card, patch, { updatedAt: nowIso() });
    this.write(state);
    return card;
  }

  transitionHCard(cardId, orderId, status, extra = {}) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card || card.status !== "reserved" || card.orderId !== orderId) return false;
    Object.assign(card, { ...extra, status, orderId: status === "unused" ? "" : orderId, updatedAt: nowIso() });
    this.write(state);
    return true;
  }
}
