import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "./config.js";
import { rechargeService } from "./recharge-service.js";
import { readJsonBody, sendJson } from "./utils.js";

const frontendCandidates = [
  config.frontendFile,
  path.join(config.rootDir, "充值中心原型.html"),
  path.join(config.rootDir, "..", "activate", "index.html")
].filter(Boolean);

function resolveFrontendPath() {
  return frontendCandidates.find(candidate => fs.existsSync(candidate)) || frontendCandidates[0];
}

function servePrototype(res) {
  const frontendPath = resolveFrontendPath();
  const html = fs.readFileSync(frontendPath, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function adminProviderLabel(provider, publicLabel) {
  return provider === "czgpt" || provider === "czgpt_external" ? "廖" : publicLabel;
}

function adminProviderSettings(settings) {
  return {
    ...settings,
    defaultProviderLabel: adminProviderLabel(settings.defaultProvider, settings.defaultProviderLabel),
    providers: settings.providers.map(provider => ({
      ...provider,
      label: adminProviderLabel(provider.key, provider.label)
    }))
  };
}

function serveProviderAdmin(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>源头切换后台｜GPTC.cc</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #132033;
      background: #f4f7fb;
      display: grid;
      place-items: center;
      padding: 20px;
    }
    main {
      width: min(440px, 100%);
      background: #fff;
      border: 1px solid #dbe4ee;
      border-radius: 14px;
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
      padding: 22px;
    }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 18px; color: #64748b; line-height: 1.6; }
    label { display: grid; gap: 8px; margin-top: 14px; font-weight: 800; }
    label.hidden { display: none; }
    input {
      width: 100%;
      min-height: 46px;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 0 12px;
      font: inherit;
    }
    .provider-group { margin-top: 18px; }
    .provider-group + .provider-group { padding-top: 18px; border-top: 1px solid #e2e8f0; }
    .group-title { margin: 0; color: #0f172a; font-size: 16px; font-weight: 950; }
    .group-help { margin: 4px 0 0; color: #64748b; font-size: 13px; line-height: 1.5; }
    .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(82px, 1fr)); gap: 10px; margin-top: 10px; }
    button {
      min-height: 52px;
      border: 1px solid #cbd5e1;
      border-radius: 12px;
      background: #f8fafc;
      color: #0f172a;
      font: inherit;
      font-weight: 900;
      cursor: pointer;
    }
    button.active { color: #fff; background: #0f766e; border-color: #0f766e; }
    .status {
      margin-top: 16px;
      padding: 12px;
      border-radius: 10px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e3a8a;
      line-height: 1.6;
    }
    .status.error { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .hint {
      margin-top: 12px;
      font-size: 13px;
      color: #64748b;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <main>
    <h1>GPTC 源头切换</h1>
    <p>先选择充值方式，再点击对应源头。站内使用 GPTC 页面，反代和站外方式会自动打开对应充值页。</p>
    <label id="tokenField">
      管理密码
      <input id="adminToken" type="password" autocomplete="current-password" placeholder="请输入 ADMIN_TOKEN">
    </label>
    <div class="provider-group">
      <h2 class="group-title">站内充值</h2>
      <p class="group-help">用户留在 GPTC 页面完成充值。</p>
      <div class="choices">
        <button type="button" data-provider="sange">三哥</button>
        <button type="button" data-provider="ayan">阿妍</button>
        <button type="button" data-provider="czgpt">廖</button>
        <button type="button" data-provider="xiaoyu">小雨</button>
      </div>
    </div>
    <div class="provider-group">
      <h2 class="group-title">反代充值</h2>
      <p class="group-help">用户仍在 GPTC 域名下，页面和充值接口由 GPTC 安全转发。</p>
      <div class="choices">
        <button type="button" data-provider="xiaoyu_proxy">小雨</button>
      </div>
    </div>
    <div class="provider-group">
      <h2 class="group-title">站外充值</h2>
      <p class="group-help">用户进入激活页后，自动跳到所选源头。</p>
      <div class="choices">
        <button type="button" data-provider="sange_external">三哥</button>
        <button type="button" data-provider="ayan_external">阿妍</button>
        <button type="button" data-provider="czgpt_external">廖</button>
        <button type="button" data-provider="dnscon">白</button>
        <button type="button" data-provider="9977ai">七七</button>
      </div>
    </div>
    <div class="status" id="statusBox">输入管理密码后，点击源头即可切换。</div>
    <div class="hint" id="tokenHint"></div>
  </main>
  <script>
    const tokenInput = document.getElementById("adminToken");
    const tokenField = document.getElementById("tokenField");
    const tokenHint = document.getElementById("tokenHint");
    const statusBox = document.getElementById("statusBox");
    const buttons = Array.from(document.querySelectorAll("[data-provider]"));
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const tokenFromHash = hashParams.get("token") || "";
    const tokenFromQuery = params.get("token") || "";
    const tokenFromUrl = tokenFromHash || tokenFromQuery;
    tokenInput.value = tokenFromUrl || localStorage.getItem("gptcProviderAdminToken") || "";
    if (tokenFromUrl) {
      tokenField.classList.add("hidden");
      tokenHint.textContent = tokenFromHash
        ? "已通过本机私密链接进入。#token 不会发送到服务器日志。"
        : "已通过旧版私密链接进入。页面已隐藏地址栏 token。";
      localStorage.setItem("gptcProviderAdminToken", tokenFromUrl);
      if (tokenFromQuery) {
        const cleanUrl = window.location.pathname + (window.location.hash || "");
        window.history.replaceState(null, "", cleanUrl);
      }
    }

    function setStatus(message, error = false) {
      statusBox.textContent = message;
      statusBox.classList.toggle("error", error);
    }

    function setActive(provider) {
      buttons.forEach((button) => button.classList.toggle("active", button.dataset.provider === provider));
    }

    function providerLocationLabel(data) {
      return data.defaultProviderMode === "redirect"
        ? "站外充值"
        : data.defaultProviderMode === "proxy"
          ? "反代充值"
          : "站内充值";
    }

    async function api(path, options = {}) {
      const token = tokenInput.value.trim();
      if (!token) throw new Error("请先输入管理密码。");
      localStorage.setItem("gptcProviderAdminToken", token);
      const response = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Token": token,
          ...(options.headers || {})
        }
      });
      const data = await response.json();
      if (!data.success) throw new Error(data.message || "操作失败。");
      return data.data;
    }

    async function loadCurrent() {
      try {
        const data = await api("/api/admin/provider");
        setActive(data.defaultProvider);
        setStatus("当前默认方式：" + providerLocationLabel(data) + " · " + data.defaultProviderLabel + (data.providerUpdatedAt ? "\\n最后切换：" + data.providerUpdatedAt : ""));
      } catch (error) {
        setStatus(error.message, true);
      }
    }

    async function switchProvider(provider) {
      try {
        const data = await api("/api/admin/provider", {
          method: "POST",
          body: JSON.stringify({ provider })
        });
        setActive(data.defaultProvider);
        setStatus("已切换为：" + providerLocationLabel(data) + " · " + data.defaultProviderLabel);
      } catch (error) {
        setStatus(error.message, true);
      }
    }

    buttons.forEach((button) => {
      button.addEventListener("click", () => switchProvider(button.dataset.provider));
    });
    if (tokenInput.value) loadCurrent();
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function serveProviderSwitchResult(res, result) {
  const success = result.ok;
  const title = success ? "源头已切换" : "切换失败";
  const locationLabel = result.data?.defaultProviderMode === "redirect"
    ? "站外充值"
    : result.data?.defaultProviderMode === "proxy"
      ? "反代充值"
      : "站内充值";
  const providerLabel = adminProviderLabel(result.data?.defaultProvider, result.data?.defaultProviderLabel);
  const message = success
    ? `当前默认方式：${locationLabel} · ${providerLabel}`
    : result.message || "请检查链接或管理 token。";
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}｜GPTC.cc</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #132033;
      background: #f4f7fb;
    }
    main {
      width: min(420px, 100%);
      padding: 24px;
      border-radius: 14px;
      background: #fff;
      border: 1px solid #dbe4ee;
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
      text-align: center;
    }
    h1 { margin: 0 0 10px; font-size: 26px; }
    p { margin: 0; color: #475569; line-height: 1.7; }
    a {
      margin-top: 18px;
      min-height: 46px;
      padding: 0 16px;
      border-radius: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #0f766e;
      color: #fff;
      text-decoration: none;
      font-weight: 900;
    }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/admin/provider">打开切换后台</a>
  </main>
</body>
</html>`;
  res.writeHead(success ? 200 : result.status || 400, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function readAdminToken(req, url, body = {}) {
  return (
    req.headers["x-admin-token"] ||
    url.searchParams.get("adminToken") ||
    url.searchParams.get("token") ||
    body.adminToken ||
    ""
  ).toString();
}

function assertAdmin(req, url, body = {}) {
  if (!config.adminToken) {
    return { ok: false, status: 403, message: "请先在服务端配置 ADMIN_TOKEN。" };
  }
  if (readAdminToken(req, url, body) !== config.adminToken) {
    return { ok: false, status: 401, message: "管理密码不正确。" };
  }
  return { ok: true };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS" && url.pathname.startsWith("/api/recharge/")) {
      sendJson(res, 200, { success: true });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/activate" || url.pathname === "/activate/")) {
      servePrototype(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/provider" || url.pathname === "/admin/provider/")) {
      serveProviderAdmin(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin/provider/switch") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        serveProviderSwitchResult(res, auth);
        return;
      }
      const result = rechargeService.updateDefaultProvider(url.searchParams.get("provider"), "direct-link");
      serveProviderSwitchResult(res, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "recharge-center-mvp", provider: rechargeService.getProviderSettings().defaultProvider });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/recharge/provider") {
      sendJson(res, 200, { success: true, data: rechargeService.getProviderSettings() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/provider") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      sendJson(res, 200, { success: true, data: adminProviderSettings(rechargeService.getProviderSettings()) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/provider") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.updateDefaultProvider(body.provider, "admin");
      sendJson(res, result.status, result.ok ? { success: true, data: adminProviderSettings(result.data) } : { success: false, message: result.message });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/verify-card") {
      const body = await readJsonBody(req);
      const result = await rechargeService.verifyCard(body.cardInfo, body.provider);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.data?.message || result.message || "验卡失败。", data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/query-card-status") {
      const body = await readJsonBody(req);
      const result = await rechargeService.queryCardStatus(body.cardInfo, body.provider);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message || "卡密状态查询失败。", data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/parse-secret") {
      const body = await readJsonBody(req);
      const result = rechargeService.parseSecret(body.secretJsonText);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/confirm") {
      const body = await readJsonBody(req);
      const result = await rechargeService.confirmRecharge(body);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message || "充值提交失败。", data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recharge/query-task-status") {
      const body = await readJsonBody(req);
      const result = await rechargeService.queryTaskStatus(body);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message || "状态查询失败。", data: result.data });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/recharge/status/")) {
      const orderId = decodeURIComponent(url.pathname.replace("/api/recharge/status/", ""));
      const result = await rechargeService.getStatus(orderId);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    sendJson(res, 404, { success: false, message: "Not found" });
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      message: error instanceof Error ? error.message : "Unknown server error"
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Recharge center MVP listening on http://${config.host}:${config.port}`);
});
