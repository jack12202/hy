import crypto from "node:crypto";
import { config } from "../config.js";
import { extractCardCode, requiredString } from "../utils.js";

const sessions = new Map();
const tasks = new Map();

function upstreamUrl(endpoint = "/") {
  return new URL(endpoint, config.ajianBaseUrl).toString();
}

function cleanupExpired() {
  const cutoff = Date.now() - config.ajianSessionTtlMs;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
  for (const [id, task] of tasks) {
    if (task.createdAt < cutoff) tasks.delete(id);
  }
}

function cookieHeader(cookies = "", setCookieHeaders = []) {
  const jar = new Map();
  for (const part of String(cookies).split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index > 0) jar.set(part.slice(0, index), part.slice(index + 1));
  }
  for (const header of setCookieHeaders) {
    const pair = String(header).split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function responseSetCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const value = response.headers.get("set-cookie");
  return value ? value.split(/,(?=[^;,]+=)/) : [];
}

function decodeHtml(value = "") {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function attribute(attrs = "", name) {
  const pattern = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const match = String(attrs).match(pattern);
  return match ? decodeHtml(match[2]) : "";
}

function formFields(markup = "") {
  const fields = {};
  const inputPattern = /<input\b([^>]*)>/gi;
  for (const match of markup.matchAll(inputPattern)) {
    const attrs = match[1] || "";
    const name = attribute(attrs, "name");
    if (!name) continue;
    const type = (attribute(attrs, "type") || "text").toLowerCase();
    if (["submit", "button", "file", "checkbox", "radio"].includes(type)) continue;
    fields[name] = attribute(attrs, "value");
  }
  return fields;
}

function extractForms(html = "") {
  const forms = [];
  const pattern = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  for (const match of html.matchAll(pattern)) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    forms.push({
      action: attribute(attrs, "action") || "/",
      method: (attribute(attrs, "method") || "get").toLowerCase(),
      fields: formFields(body),
      body,
      text: body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    });
  }
  return forms;
}

function csrfFromHtml(html = "") {
  const forms = extractForms(html);
  for (const form of forms) {
    if (requiredString(form.fields._csrf)) return form.fields._csrf;
  }
  const meta = html.match(/<meta\b[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i);
  return meta ? decodeHtml(meta[1]) : "";
}

function tokenForm(html = "") {
  return extractForms(html).find(form => /<textarea\b[^>]*name=["']token["']/i.test(form.body)) || null;
}

function confirmationForm(html = "") {
  return extractForms(html).find(form => {
    if (!form.action || /\/recharge\/preview(?:[/?]|$)/i.test(form.action)) return false;
    return /确认|提交|充值|升级/i.test(form.text);
  }) || null;
}

function statusEndpoint(html = "") {
  const match = html.match(/data-status-endpoint=["']([^"']+)["']/i);
  return match ? decodeHtml(match[1]) : "";
}

function alertText(html = "") {
  const match = html.match(/class=["'][^"']*alert-error[^"']*["'][^>]*>([\s\S]*?)<\//i);
  return match ? match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
}

async function requestUpstream(endpoint, { method = "GET", cookies = "", form, json } = {}) {
  const url = upstreamUrl(endpoint);
  const headers = {
    Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    "User-Agent": config.ajianUserAgent,
    Referer: `${new URL(config.ajianBaseUrl).origin}/`,
    Origin: new URL(config.ajianBaseUrl).origin
  };
  if (cookies) headers.Cookie = cookies;

  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }

  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: "manual"
  });
  const nextCookies = cookieHeader(cookies, responseSetCookies(response));
  const location = response.headers.get("location");
  if (location && response.status >= 300 && response.status < 400) {
    const nextMethod = response.status === 307 || response.status === 308 ? method : "GET";
    return requestUpstream(new URL(location, url).toString(), {
      method: nextMethod,
      cookies: nextCookies,
      ...(nextMethod === "GET" ? {} : { form })
    });
  }

  return {
    ok: response.ok,
    status: response.status,
    cookies: nextCookies,
    url,
    text: await response.text()
  };
}

function parsedJson(text = "") {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeStatus(body, task) {
  const value = body && typeof body === "object" ? body : {};
  const upstreamStatus = String(value.status || "unknown").toLowerCase();
  const hasAccount = Boolean(value.account && value.tier);
  const status = upstreamStatus === "completed"
    ? (hasAccount ? "success" : "needs_review")
    : upstreamStatus === "failed"
      ? "failed"
      : upstreamStatus === "waiting"
        ? "needs_review"
        : "processing";

  return {
    success: status !== "failed",
    provider: "j",
    providerLabel: "阿健",
    taskId: task.id,
    status,
    upstreamStatus,
    message: value.error || value.message || (status === "success" ? "充值成功。" : "充值处理中，请稍候。"),
    account: value.account || "",
    tier: value.tier || "",
    completedAt: value.completedAt || "",
    raw: value
  };
}

export const ajianAdapter = {
  key: "j",
  label: "阿健",

  async verifyCard({ cardInfo }) {
    cleanupExpired();
    const cardCode = extractCardCode(cardInfo);
    if (!cardCode) {
      return { ok: false, status: 400, data: { provider: "j", providerLabel: "阿健", message: "请先输入卡密。" } };
    }

    const home = await requestUpstream("/");
    const homeCsrf = csrfFromHtml(home.text);
    if (!home.ok || !homeCsrf) {
      return { ok: false, status: 502, data: { provider: "j", providerLabel: "阿健", message: "阿健充值站暂时无法连接。" } };
    }

    const verified = await requestUpstream("/card/verify", {
      method: "POST",
      cookies: home.cookies,
      form: { _csrf: homeCsrf, cardKey: cardCode }
    });
    const form = tokenForm(verified.text);
    const error = alertText(verified.text);
    if (!verified.ok || !form) {
      return {
        ok: false,
        status: verified.status < 500 ? verified.status : 502,
        data: {
          provider: "j",
          providerLabel: "阿健",
          message: error || "卡密不存在或输入有误。"
        }
      };
    }

    const verificationId = crypto.randomUUID();
    sessions.set(verificationId, {
      id: verificationId,
      cardCode,
      cookies: verified.cookies,
      csrf: form.fields._csrf || csrfFromHtml(verified.text),
      tokenAction: form.action,
      createdAt: Date.now()
    });

    return {
      ok: true,
      status: 200,
      data: {
        success: true,
        provider: "j",
        providerLabel: "阿健",
        providerSessionId: verificationId,
        productId: config.defaultProductId,
        message: "卡密验证通过。"
      }
    };
  },

  async startRecharge({ cardInfo, fullAuthData, providerSessionId }) {
    cleanupExpired();
    const session = sessions.get(providerSessionId);
    const cardCode = extractCardCode(cardInfo);
    if (!session || session.cardCode !== cardCode) {
      return { ok: false, status: 400, data: { provider: "j", providerLabel: "阿健", message: "卡密验证会话已失效，请重新验证卡密。" } };
    }

    const token = typeof fullAuthData === "string" ? fullAuthData : JSON.stringify(fullAuthData || {});
    const preview = await requestUpstream(session.tokenAction, {
      method: "POST",
      cookies: session.cookies,
      form: {
        _csrf: session.csrf,
        cardKey: cardCode,
        token
      }
    });
    session.cookies = preview.cookies;

    const previewError = alertText(preview.text);
    if (!preview.ok) {
      return { ok: false, status: preview.status < 500 ? preview.status : 502, data: { provider: "j", providerLabel: "阿健", message: previewError || "Token 提交失败。" } };
    }

    let result = preview;
    const confirm = confirmationForm(preview.text);
    if (confirm) {
      const fields = { ...confirm.fields };
      if (!fields._csrf) fields._csrf = csrfFromHtml(preview.text) || session.csrf;
      if (confirm.method === "post") {
        result = await requestUpstream(confirm.action, {
          method: "POST",
          cookies: preview.cookies,
          form: fields
        });
      } else {
        result = await requestUpstream(confirm.action, { cookies: preview.cookies });
      }
      session.cookies = result.cookies;
    }

    const endpoint = statusEndpoint(result.text) || statusEndpoint(preview.text);
    const taskId = `j_${crypto.randomUUID()}`;
    const task = {
      id: taskId,
      cookies: result.cookies,
      statusEndpoint: endpoint,
      csrf: csrfFromHtml(result.text) || csrfFromHtml(preview.text) || session.csrf,
      createdAt: Date.now()
    };
    tasks.set(taskId, task);

    if (!endpoint) {
      const body = parsedJson(result.text);
      const message = alertText(result.text) || body?.message || "充值请求已提交，但暂未取得状态查询地址。";
      return {
        ok: false,
        status: 502,
        data: { provider: "j", providerLabel: "阿健", taskId, status: "needs_review", message }
      };
    }

    return {
      ok: true,
      status: 200,
      data: {
        provider: "j",
        providerLabel: "阿健",
        taskId,
        status: "processing",
        message: "充值已提交，正在处理中。"
      }
    };
  },

  async queryTaskStatus({ taskId }) {
    cleanupExpired();
    const task = tasks.get(taskId);
    if (!task || !task.statusEndpoint) {
      return { ok: false, status: 404, data: { provider: "j", providerLabel: "阿健", message: "阿健充值状态会话已失效，请联系客服核查。" } };
    }

    const result = await requestUpstream(task.statusEndpoint, {
      method: "POST",
      cookies: task.cookies,
      json: { _csrf: task.csrf }
    });
    task.cookies = result.cookies;
    const body = parsedJson(result.text) || {};
    const data = normalizeStatus(body, task);
    return { ok: result.ok && data.status !== "failed", status: result.status, data };
  }
};
