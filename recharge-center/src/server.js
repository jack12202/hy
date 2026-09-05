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
    <p>先选择站内或站外充值，再点击对应源头。站内在 GPTC 完成，站外会直接打开对应充值页。</p>
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
        <button type="button" data-provider="j">阿健</button>
        <button type="button" data-provider="czgpt">廖</button>
        <button type="button" data-provider="xiaoyu">小雨</button>
        <button type="button" data-provider="h">h</button>
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
    <div class="hint"><a href="/admin/cards">打开 h 通道卡密生成后台</a></div>
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
      return data.defaultProviderMode === "redirect" ? "站外充值" : "站内充值";
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

function serveHCardAdmin(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>h 通道卡密｜GPTC.cc</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 20px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #132033; background: #f4f7fb; }
    main { width: min(1100px, 100%); margin: 0 auto; }
    section { background: #fff; border: 1px solid #dbe4ee; border-radius: 14px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08); padding: 22px; margin-bottom: 16px; }
    h1, h2 { margin: 0 0 8px; }
    h1 { font-size: 26px; }
    h2 { font-size: 18px; }
    p, .hint { color: #64748b; line-height: 1.6; }
    .auth-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: end; }
    .form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; align-items: end; margin-top: 18px; }
    label { display: grid; gap: 8px; font-weight: 800; }
    input, select { width: 100%; min-height: 44px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font: inherit; background:#fff; }
    button { min-height: 44px; border: 0; border-radius: 10px; padding: 0 18px; color: #fff; background: #0f766e; font: inherit; font-weight: 900; cursor: pointer; }
    button.secondary { color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; }
    .status { margin-top: 16px; padding: 12px; border-radius: 10px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; line-height: 1.6; white-space: pre-wrap; }
    .status.error { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .generated { display: grid; gap: 10px; margin-top: 14px; max-height: 420px; overflow:auto; }
    .card { padding: 12px; border: 1px solid #dbe4ee; border-radius: 10px; background: #f8fafc; overflow-wrap: anywhere; }
    .card code { display: block; color: #0f172a; font-weight: 900; }
    .card a { display: block; margin-top: 5px; color: #2563eb; font-size: 13px; }
    .row-actions { display: flex; gap: 8px; }
    .row-actions button { min-height: 34px; padding: 0 10px; font-size: 13px; }
    .row-actions button.danger { color: #9f1239; background: #fff1f2; border: 1px solid #fda4af; }
    .action-link { display: inline-flex; align-items: center; min-height: 44px; padding: 0 18px; border-radius: 10px; color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; font-weight: 900; text-decoration: none; }
    .page-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
    .output-actions { display:none; gap:10px; flex-wrap:wrap; margin-top:14px; padding-top:14px; border-top:1px solid #e2e8f0; }
    .summary { display:none; margin-top:16px; padding:14px; border-radius:12px; background:#f0fdfa; color:#115e59; font-weight:800; }
    .card-code { display: inline-block; min-width: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 900; }
    .copy-card { min-height: 32px !important; padding: 0 9px !important; margin-left: 8px; font-size: 12px !important; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
    th, td { padding: 10px 8px; text-align: left; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    th { color: #475569; }
    .hint { margin: 10px 0 0; font-size: 13px; }
    @media (max-width: 640px) { .auth-row, .form { grid-template-columns: 1fr; } button { width: 100%; } section { padding: 16px; } }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>卡密工作台</h1>
      <p>按销售来源生成卡密，并复制或下载适合 Excel、卡网和客户交付的格式。</p>
      <div class="auth-row">
        <label>
          管理密码
          <input id="adminToken" type="password" autocomplete="current-password" placeholder="请输入 ADMIN_TOKEN">
        </label>
        <button class="secondary" id="verifyAdmin" type="button">验证管理密码</button>
      </div>
      <div class="form">
        <label>生成数量<input id="count" type="number" min="1" max="100" value="10"></label>
        <label>销售来源<select id="source"><option>卡网</option><option>微信</option><option>漫飞公司</option><option value="custom">其他</option></select><input id="customSource" type="text" maxlength="40" placeholder="请备注来源，例如：秋风店铺" hidden></label>
        <button id="generate" type="button">生成卡密</button>
      </div>
      <div class="status" id="statusBox">输入管理密码，选择数量和来源后生成。</div>
      <div class="page-actions"><a class="action-link" href="/admin/cards/library">卡密库</a><a class="action-link" href="/admin/hifupay/cards">嗨付卡池</a><a class="action-link" href="/admin/recoveries">充值记录</a></div>
      <div class="summary" id="batchSummary"></div>
      <div class="output-actions" id="outputActions"><button class="secondary" id="copyCodes">复制全部卡密</button><button class="secondary" id="copyLinks">复制全部链接</button><button class="secondary" id="downloadCodes">下载卡密 TXT</button><button class="secondary" id="downloadLinks">下载链接 TXT</button></div>
      <div class="generated" id="generated"></div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("adminToken");
    const statusBox = document.getElementById("statusBox");
    const generated = document.getElementById("generated");
    let generatedCards = [];
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const tokenFromHash = hashParams.get("token") || "";
    const tokenFromQuery = params.get("token") || "";
    const token = tokenFromHash || tokenFromQuery || localStorage.getItem("gptcProviderAdminToken") || "";
    tokenInput.value = token;
    if (tokenFromHash || tokenFromQuery) {
      localStorage.setItem("gptcProviderAdminToken", token);
      if (tokenFromQuery) window.history.replaceState(null, "", window.location.pathname + (window.location.hash || ""));
    }

    function setStatus(message, error = false) {
      statusBox.textContent = message;
      statusBox.classList.toggle("error", error);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[character]));
    }

    function formatDate(value) {
      if (!value) return "永久";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
    }

    async function copyCardCode(button) {
      const code = button.dataset.cardCode || "";
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "已复制";
        window.setTimeout(() => { button.textContent = "复制"; }, 1200);
      } catch { setStatus("复制失败，请手动选择卡密复制。", true); }
    }

    async function api(path, options = {}) {
      const currentToken = tokenInput.value.trim();
      if (!currentToken) throw new Error("请先输入管理密码。");
      localStorage.setItem("gptcProviderAdminToken", currentToken);
      const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", "X-Admin-Token": currentToken, ...(options.headers || {}) } });
      const data = await response.json();
      if (!data.success) throw new Error(data.message || "操作失败。");
      return data.data;
    }

    function currentSource() {
      const selected = document.getElementById("source").value;
      return selected === "custom" ? document.getElementById("customSource").value.trim() : selected;
    }
    function outputText(type) {
      return generatedCards.map(card => type === "links" ? card.link : card.code).join("\n");
    }
    async function copyOutput(type) {
      if (!generatedCards.length) return;
      await navigator.clipboard.writeText(outputText(type));
      setStatus(type === "links" ? "全部充值链接已复制。" : "全部卡密已复制，可直接粘贴到 Excel。");
    }
    function downloadOutput(type) {
      if (!generatedCards.length) return;
      const source = currentSource() || "未分类";
      const date = new Date().toLocaleDateString("sv-SE");
      const name = date + "-" + source.replace(/[\\/:*?\"<>|]/g, "-") + "-" + generatedCards.length + "张-" + (type === "links" ? "充值链接" : "卡密") + ".txt";
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([outputText(type)], { type: "text/plain;charset=utf-8" }));
      link.download = name;
      link.click();
      URL.revokeObjectURL(link.href);
    }
    function syncCustomSource() {
      const source = document.getElementById("source");
      const customSource = document.getElementById("customSource");
      const isCustom = source.value === "custom";
      customSource.hidden = !isCustom;
      customSource.required = isCustom;
    }
    document.getElementById("source").addEventListener("change", syncCustomSource);
    window.addEventListener("pageshow", syncCustomSource);
    syncCustomSource();
    tokenInput.addEventListener("input", () => {
      setStatus("点击“验证管理密码”后即可确认是否正确。");
    });
    document.getElementById("verifyAdmin").addEventListener("click", async () => {
      try {
        await api("/api/admin/h-cards?limit=1");
        setStatus("管理密码验证成功，可以生成卡密。");
      } catch (error) { setStatus(error.message || "管理密码验证失败。", true); }
    });
    document.getElementById("copyCodes").onclick = () => copyOutput("codes");
    document.getElementById("copyLinks").onclick = () => copyOutput("links");
    document.getElementById("downloadCodes").onclick = () => downloadOutput("codes");
    document.getElementById("downloadLinks").onclick = () => downloadOutput("links");

    document.getElementById("generate").addEventListener("click", async () => {
      try {
        const source = currentSource();
        if (!source) throw new Error("请输入销售来源。");
        const data = await api("/api/admin/h-cards", { method: "POST", body: JSON.stringify({ count: Number(document.getElementById("count").value), source, productId: 3 }) });
        generatedCards = data.cards;
        generated.innerHTML = data.cards.map(card => '<div class="card"><code>' + escapeHtml(card.code) + '</code><a href="' + escapeHtml(card.link) + '" target="_blank" rel="noreferrer">' + escapeHtml(card.link) + '</a></div>').join("");
        document.getElementById("outputActions").style.display = "flex";
        const summary = document.getElementById("batchSummary");
        summary.style.display = "block";
        summary.textContent = "本批次：" + source + " · " + data.cards.length + " 张 · " + new Date().toLocaleString("zh-CN", { hour12:false });
        setStatus("已生成 " + data.cards.length + " 张卡密。请立即复制或下载保存。");
      } catch (error) { setStatus(error.message, true); }
    });
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  res.end(html);
}

function serveHCardLibraryAdmin(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>h 通道卡密库｜GPTC.cc</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 20px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #132033; background: #f4f7fb; }
    main { width: min(1180px, 100%); margin: 0 auto; }
    section { background: #fff; border: 1px solid #dbe4ee; border-radius: 14px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08); padding: 22px; margin-bottom: 16px; }
    h1 { margin: 0 0 8px; font-size: 26px; }
    p, .hint { color: #64748b; line-height: 1.6; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .top-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .back-link, button { min-height: 44px; border-radius: 10px; padding: 0 16px; font: inherit; font-weight: 900; cursor: pointer; }
    .back-link { display: inline-flex; align-items: center; color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; text-decoration: none; }
    button { border: 0; color: #fff; background: #0f766e; }
    button.secondary { color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; }
    button.danger { color: #9f1239; background: #fff1f2; border: 1px solid #fda4af; }
    button:disabled { opacity: .55; cursor: wait; }
    label { display: grid; gap: 8px; max-width: 620px; font-weight: 800; }
    input, select { width: 100%; min-height: 44px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font: inherit; background:#fff; }
    .toolbar { display: flex; align-items: end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
    .bulk-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; padding:12px; background:#f8fafc; border-radius:10px; }
    .check { width:18px; min-height:18px; }
    .status { margin-top: 16px; padding: 12px; border-radius: 10px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; line-height: 1.6; white-space: pre-wrap; }
    .status.error { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .count { color: #475569; font-weight: 800; }
    .table-wrap { overflow-x: auto; margin-top: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 11px 8px; text-align: left; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    th { color: #475569; }
    .row-actions { display: flex; gap: 8px; }
    .row-actions button { min-height: 34px; padding: 0 10px; font-size: 13px; }
    .card-code { display: inline-block; min-width: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 900; }
    .copy-card { min-height: 32px !important; padding: 0 9px !important; margin-left: 8px; font-size: 12px !important; }
    .hint { margin: 10px 0 0; font-size: 13px; }
    @media (max-width: 640px) { body { padding: 12px; } section { padding: 16px; } .toolbar { align-items: stretch; } .toolbar button, .top-actions > * { width: 100%; justify-content: center; } }
  </style>
</head>
<body>
  <main>
    <section>
      <div class="topbar">
        <div><h1>h 通道卡密库</h1><p class="hint">按来源、状态和生成日期筛选，支持批量管理。提交过资料的卡密只能归档，不能删除。</p></div>
        <div class="top-actions"><a class="back-link" href="/admin/cards">返回生成页</a><a class="back-link" href="/admin/hifupay/cards">嗨付卡池</a><a class="back-link" href="/admin/recoveries">充值记录</a><button class="secondary" id="refresh" type="button">刷新列表</button></div>
      </div>
      <label>
        管理密码
        <input id="adminToken" type="password" autocomplete="current-password" placeholder="请输入 ADMIN_TOKEN">
      </label>
      <div class="status" id="statusBox">输入管理密码后，可以查看和管理卡密。</div>
    </section>
    <section>
      <div class="toolbar"><label>搜索<input id="cardSearch" type="search" placeholder="账号或卡密"></label><label>来源<select id="sourceFilter"><option value="">全部来源</option></select></label><label>状态<select id="cardStatusFilter"><option value="">全部状态</option><option value="unused">未使用</option><option value="locked">已锁定</option><option value="used">已使用</option><option value="disabled">已禁用</option><option value="archived">已归档</option></select></label><label>生成日期<input id="dateFilter" type="date"></label><label style="display:flex;grid-auto-flow:column;align-items:center;justify-content:start"><input id="showArchived" type="checkbox" class="check">显示归档</label><span class="count" id="libraryCount">-</span></div>
      <div class="bulk-actions"><button class="secondary" id="selectAll">全选当前结果</button><button class="secondary" id="invertSelection">反选</button><button data-bulk-action="disable">批量禁用</button><button class="secondary" data-bulk-action="enable">批量启用</button><button class="secondary" data-bulk-action="archive">批量归档</button><button class="danger" data-bulk-action="delete">批量删除</button><strong id="selectedCount">已选 0 张</strong></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th><input id="selectPage" type="checkbox" class="check" title="全选当前结果"></th><th>序号</th><th>卡密</th><th>来源</th><th>状态</th><th>绑定账号</th><th>生成时间</th><th>操作</th></tr></thead>
          <tbody id="libraryCards"></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("adminToken");
    const statusBox = document.getElementById("statusBox");
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const tokenFromHash = hashParams.get("token") || "";
    const tokenFromQuery = params.get("token") || "";
    const token = tokenFromHash || tokenFromQuery || localStorage.getItem("gptcProviderAdminToken") || "";
    tokenInput.value = token;
    if (tokenFromHash || tokenFromQuery) {
      localStorage.setItem("gptcProviderAdminToken", token);
      if (tokenFromQuery) window.history.replaceState(null, "", window.location.pathname + (window.location.hash || ""));
    }

    function setStatus(message, error = false) {
      statusBox.textContent = message;
      statusBox.classList.toggle("error", error);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[character]));
    }

    function formatDate(value) {
      if (!value) return "永久";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
    }

    async function copyCardCode(button) {
      const code = button.dataset.cardCode || "";
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "已复制";
        window.setTimeout(() => { button.textContent = "复制"; }, 1200);
      } catch { setStatus("复制失败，请手动选择卡密复制。", true); }
    }

    async function api(path, options = {}) {
      const currentToken = tokenInput.value.trim();
      if (!currentToken) throw new Error("请先输入管理密码。");
      localStorage.setItem("gptcProviderAdminToken", currentToken);
      const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", "X-Admin-Token": currentToken, ...(options.headers || {}) } });
      const data = await response.json();
      if (!data.success) throw new Error(data.message || "操作失败。");
      return data.data;
    }

    const statusLabels = { unused: "未使用", locked: "已锁定", reserved: "处理中", used: "已使用", disabled: "已禁用", expired: "已过期", archived: "已归档" };
    let allCards = [];
    let filteredCards = [];
    const selectedCards = new Set();

    function renderRows(cards) {
      return cards.map((card, index) => {
        const effectiveStatus = card.archivedAt ? "archived" : card.status;
        const actionHtml = [
          card.archivedAt ? '<button type="button" data-card-action="restore" data-card-id="' + escapeHtml(card.id) + '">恢复</button>' : "",
          !card.archivedAt && card.hasSubmission ? '<button class="secondary" type="button" data-card-action="archive" data-card-id="' + escapeHtml(card.id) + '">归档</button>' : "",
          !card.archivedAt && !card.hasSubmission && ["unused", "expired", "disabled"].includes(card.status) ? '<button class="danger" type="button" data-card-action="delete" data-card-id="' + escapeHtml(card.id) + '">删除</button>' : "",
          !card.archivedAt && (card.status === "locked" || card.status === "reserved")
            ? '<button type="button" data-card-action="unlock" data-card-id="' + escapeHtml(card.id) + '">解锁</button>'
            : "",
          !card.archivedAt && card.status === "disabled"
            ? '<button type="button" data-card-action="enable" data-card-id="' + escapeHtml(card.id) + '">启用</button>'
            : !card.archivedAt ? '<button class="danger" type="button" data-card-action="disable" data-card-id="' + escapeHtml(card.id) + '">禁用</button>' : ""
        ].filter(Boolean).join("");
        const account = [card.boundEmail, card.boundAccountId].filter(Boolean).join(" / ") || "-";
        const code = card.code || card.cardMask || "-";
        return '<tr><td><input class="check row-check" type="checkbox" data-card-id="' + escapeHtml(card.id) + '"' + (selectedCards.has(card.id) ? ' checked' : '') + '></td><td>' + (index + 1) + '</td><td><span class="card-code">' + escapeHtml(code) + '</span>' + (card.code ? '<button class="secondary copy-card" type="button" data-card-code="' + escapeHtml(card.code) + '" onclick="copyCardCode(this)">复制</button>' : '') + '</td><td>' + escapeHtml(card.source || "未分类") + '</td><td>' + escapeHtml(statusLabels[effectiveStatus] || effectiveStatus) + '</td><td>' + escapeHtml(account) + '</td><td>' + escapeHtml(formatDate(card.createdAt)) + '</td><td><div class="row-actions">' + actionHtml + '</div></td></tr>';
      }).join("") || '<tr><td colspan="8">暂无匹配卡密</td></tr>';
    }

    function applyFilter() {
      const keyword = document.getElementById("cardSearch").value.trim().toLowerCase();
      const source = document.getElementById("sourceFilter").value;
      const status = document.getElementById("cardStatusFilter").value;
      const date = document.getElementById("dateFilter").value;
      filteredCards = allCards.filter(card => {
        const effectiveStatus = card.archivedAt ? "archived" : card.status;
        const matchesKeyword = !keyword || [card.code, card.cardMask, card.boundEmail, card.boundAccountId].some(value => String(value || "").toLowerCase().includes(keyword));
        return matchesKeyword && (!source || card.source === source) && (!status || effectiveStatus === status) && (!date || String(card.createdAt || "").slice(0, 10) === date);
      });
      document.getElementById("libraryCards").innerHTML = renderRows(filteredCards);
      document.getElementById("libraryCount").textContent = filteredCards.length + " / " + allCards.length + " 张";
      document.getElementById("selectedCount").textContent = "已选 " + selectedCards.size + " 张";
      document.getElementById("selectPage").checked = filteredCards.length > 0 && filteredCards.every(card => selectedCards.has(card.id));
    }

    async function loadLibrary() {
      try {
        const includeArchived = document.getElementById("showArchived").checked ? "&archived=1" : "";
        const data = await api("/api/admin/h-cards?all=1&reveal=1" + includeArchived);
        allCards = data.cards;
        const sourceFilter = document.getElementById("sourceFilter");
        const selectedSource = sourceFilter.value;
        const sources = [...new Set(allCards.map(card => card.source || "未分类"))].sort();
        sourceFilter.innerHTML = '<option value="">全部来源</option>' + sources.map(source => '<option value="' + escapeHtml(source) + '">' + escapeHtml(source) + '</option>').join("");
        sourceFilter.value = selectedSource;
        applyFilter();
        setStatus("已加载全部卡密。");
      } catch (error) { setStatus(error.message, true); }
    }

    document.getElementById("refresh").addEventListener("click", loadLibrary);
    document.getElementById("cardSearch").addEventListener("input", applyFilter);
    document.getElementById("sourceFilter").addEventListener("change", applyFilter);
    document.getElementById("cardStatusFilter").addEventListener("change", applyFilter);
    document.getElementById("dateFilter").addEventListener("change", applyFilter);
    document.getElementById("showArchived").addEventListener("change", loadLibrary);
    document.getElementById("libraryCards").addEventListener("change", event => {
      const checkbox = event.target.closest(".row-check");
      if (!checkbox) return;
      checkbox.checked ? selectedCards.add(checkbox.dataset.cardId) : selectedCards.delete(checkbox.dataset.cardId);
      applyFilter();
    });
    function selectFiltered(mode) {
      filteredCards.forEach(card => mode === "all" ? selectedCards.add(card.id) : selectedCards.has(card.id) ? selectedCards.delete(card.id) : selectedCards.add(card.id));
      applyFilter();
    }
    document.getElementById("selectAll").onclick = () => selectFiltered("all");
    document.getElementById("invertSelection").onclick = () => selectFiltered("invert");
    document.getElementById("selectPage").onchange = event => {
      filteredCards.forEach(card => event.target.checked ? selectedCards.add(card.id) : selectedCards.delete(card.id));
      applyFilter();
    };
    document.querySelectorAll("[data-bulk-action]").forEach(button => button.onclick = async () => {
      const action = button.dataset.bulkAction;
      const ids = [...selectedCards];
      if (!ids.length) return setStatus("请先勾选卡密。", true);
      if (!confirm("确认对已选 " + ids.length + " 张卡密执行“" + button.textContent.trim() + "”？")) return;
      try {
        const data = await api("/api/admin/h-cards/bulk", { method:"POST", body:JSON.stringify({ cardIds:ids, action }) });
        selectedCards.clear();
        await loadLibrary();
        setStatus("批量操作完成：成功 " + data.successCount + " 张，未处理 " + data.failedCount + " 张。");
      } catch (error) { setStatus(error.message, true); }
    });
    document.getElementById("libraryCards").addEventListener("click", async event => {
      const button = event.target.closest("[data-card-action]");
      if (!button) return;
      button.disabled = true;
      try {
        const action = button.dataset.cardAction;
        if (action === "delete" && !confirm("确认永久删除这张未提交过资料的卡密？删除后无法恢复。")) { button.disabled = false; return; }
        if (action === "archive" && !confirm("确认归档这张卡密？充值记录会继续保留。")) { button.disabled = false; return; }
        await api("/api/admin/h-cards/" + encodeURIComponent(button.dataset.cardId) + "/" + action, { method: "POST", body: "{}" });
        await loadLibrary();
        setStatus(action === "unlock" ? "卡密已解锁，可绑定新账号。" : action === "disable" ? "卡密已禁用。" : action === "enable" ? "卡密已启用。" : action === "delete" ? "卡密已永久删除。" : action === "archive" ? "卡密已归档。" : "卡密已恢复。");
      } catch (error) {
        setStatus(error.message, true);
        button.disabled = false;
      }
    });
    if (token) loadLibrary();
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  res.end(html);
}

function serveHifupayCardAdmin(res) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>嗨付卡池｜GPTC.cc</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:20px;background:#f4f7fb;color:#132033;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1200px;margin:auto}section{padding:22px;margin-bottom:16px;background:#fff;border:1px solid #dbe4ee;border-radius:14px;box-shadow:0 18px 48px rgba(15,23,42,.08)}h1,h2{margin:0 0 8px}p{color:#64748b;line-height:1.6}.top,.actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.actions{justify-content:flex-start}label{display:grid;gap:8px;margin-top:16px;font-weight:800;max-width:620px}input{min-height:44px;padding:0 12px;border:1px solid #cbd5e1;border-radius:10px;font:inherit}button,a{min-height:42px;padding:0 14px;border-radius:10px;font:inherit;font-weight:900;cursor:pointer}button{border:0;background:#0f766e;color:#fff}button.secondary,a{background:#ecfdf5;color:#0f766e;border:1px solid #99f6e4;text-decoration:none;display:inline-flex;align-items:center}button.danger{background:#fff1f2;color:#9f1239;border:1px solid #fda4af}.status{margin-top:16px;padding:12px;border-radius:10px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;white-space:pre-wrap}.error{background:#fff1f2;border-color:#fda4af;color:#9f1239}.table{overflow:auto;margin-top:14px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:11px 8px;text-align:left;vertical-align:top;border-bottom:1px solid #e2e8f0;white-space:nowrap}th{color:#475569}td.accounts{white-space:normal;min-width:260px;line-height:1.5}.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#ecfdf5;color:#047857;font-weight:900}.warn{background:#fff7ed;color:#c2410c}.bad{background:#fff1f2;color:#be123c}.hint{margin:8px 0 0;font-size:13px}@media(max-width:640px){body{padding:12px}section{padding:16px}.actions a,.actions button{width:100%;justify-content:center}}
</style></head><body><main>
<section><div class="top"><div><h1>嗨付卡池</h1><p>这里管理真正提交充值的嗨付卡片，不是用户拿到的激活卡密。系统只读取余额和状态，不会自动开卡、提余额或注销卡片。</p></div><div class="actions"><a href="/admin/cards">卡密生成</a><a href="/admin/cards/library">卡密库</a><a href="/admin/recoveries">充值记录</a></div></div>
<label>管理密码<input id="token" type="password" autocomplete="current-password" placeholder="请输入 ADMIN_TOKEN"></label><div class="actions" style="margin-top:14px"><button id="refresh">刷新嗨付卡片</button><button class="secondary" id="local">查看本地记录</button></div><div class="status" id="status">输入管理密码后，可以读取嗨付卡池。</div></section>
<section><div class="top"><div><h2>卡片状态</h2><p class="hint">系统按顺序优先使用同一张卡；每次充值前读取嗨付实时余额，低于最近一次 Plus 实际扣款时自动切换。首次按 $16 预估，不设置安全余量。</p></div><strong id="count">0 张</strong></div><div class="table"><table><thead><tr><th>卡片</th><th>顺序</th><th>余额</th><th>本站成功记录</th><th>状态</th><th>保留截止</th><th>绑定账号</th><th>操作</th></tr></thead><tbody id="cards"><tr><td colspan="8">暂无记录</td></tr></tbody></table></div></section>
</main><script>
const token=document.getElementById("token"),statusBox=document.getElementById("status"),params=new URLSearchParams(location.search),hash=new URLSearchParams(location.hash.replace(/^#/,""));token.value=hash.get("token")||params.get("token")||localStorage.getItem("gptcProviderAdminToken")||"";if(token.value)localStorage.setItem("gptcProviderAdminToken",token.value);
const esc=value=>String(value??"").replace(/[&<>\"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[c]));const date=value=>{if(!value)return"-";const d=new Date(value);return Number.isNaN(d.getTime())?String(value):d.toLocaleString("zh-CN",{hour12:false})};const money=value=>value===null||value===undefined?"未知":"$"+Number(value).toFixed(2);const labels={ready:"可用",low_balance:"余额偏低",reserved:"处理中",full_hold:"已满·保留中",full_expired:"已满·待处理",disabled:"已禁用",upstream_unavailable:"上游不可用"};
async function api(path,options={}){const current=token.value.trim();if(!current)throw Error("请先输入管理密码。");localStorage.setItem("gptcProviderAdminToken",current);const response=await fetch(path,{...options,headers:{"Content-Type":"application/json","X-Admin-Token":current,...(options.headers||{})}});const data=await response.json();if(!data.success)throw Error(data.message||"操作失败。");return data.data}
function render(cards){return cards.map(card=>{const accounts=(card.plusUsers||[]).map(user=>esc((user.email||user.accountId||"未知账号")+(user.upgradeUntil?"（可升级至 "+date(user.upgradeUntil)+"）":""))).join("<br>")||"-";const pending=(card.inFlightOrders||[]).map(item=>'<br><small>待确认 '+esc(item.orderId)+' <button class="secondary" data-action="release" data-id="'+esc(card.id)+'" data-order-id="'+esc(item.orderId)+'">释放</button></small>').join("");const cls=["disabled"].includes(card.poolStatus)?"bad":["low_balance","reserved","upstream_unavailable"].includes(card.poolStatus)?"warn":"";const action=card.enabled?'<button class="danger" data-action="disable" data-id="'+esc(card.id)+'">禁用</button>':'<button class="secondary" data-action="enable" data-id="'+esc(card.id)+'">启用</button>';return '<tr><td>ID '+esc(card.id)+'<br>****'+esc(card.lastFour||"----")+'</td><td><input style="width:72px" type="number" min="0" data-setting="priority" data-id="'+esc(card.id)+'" value="'+esc(card.priority)+'"></td><td>'+esc(money(card.balance))+'<br><small>可用 '+esc(money(card.availableBalance))+'</small></td><td>'+esc(card.automaticPlusUsed)+' 人</td><td><span class="badge '+cls+'">'+esc(labels[card.poolStatus]||card.poolStatus||"未知")+'</span></td><td>'+esc(date(card.holdUntil))+'</td><td class="accounts">'+accounts+pending+'</td><td>'+action+'</td></tr>'}).join("")||'<tr><td colspan="8">暂无记录</td></tr>'}
async function load(refresh=false){try{const data=await api("/api/admin/hifupay/cards"+(refresh?"?refresh=1":""));document.getElementById("cards").innerHTML=render(data.cards||[]);document.getElementById("count").textContent=(data.cards||[]).length+" 张";statusBox.textContent=refresh?"已刷新嗨付卡片余额和状态。":(data.updatedAt?"已加载本地卡池记录，最后同步："+date(data.updatedAt):"暂无本地卡池记录，请先刷新。");statusBox.classList.remove("error")}catch(error){statusBox.textContent=error.message;statusBox.classList.add("error")}}
document.getElementById("refresh").onclick=()=>load(true);document.getElementById("local").onclick=()=>load(false);document.getElementById("cards").onchange=async event=>{const input=event.target.closest("[data-setting]");if(!input)return;input.disabled=true;try{await api("/api/admin/hifupay/cards/"+encodeURIComponent(input.dataset.id)+"/settings",{method:"POST",body:JSON.stringify({field:input.dataset.setting,value:Number(input.value)})});statusBox.textContent="卡片顺序已保存。";statusBox.classList.remove("error");await load(false)}catch(error){statusBox.textContent=error.message;statusBox.classList.add("error");input.disabled=false}};document.getElementById("cards").onclick=async event=>{const button=event.target.closest("[data-action]");if(!button)return;if(button.dataset.action==="release"&&!confirm("确认释放这笔待确认占用？请先确认嗨付没有扣款。"))return;button.disabled=true;try{await api("/api/admin/hifupay/cards/"+encodeURIComponent(button.dataset.id)+"/"+button.dataset.action,{method:"POST",body:button.dataset.action==="release"?JSON.stringify({orderId:button.dataset.orderId}):"{}"});await load(false)}catch(error){statusBox.textContent=error.message;statusBox.classList.add("error");button.disabled=false}};if(token.value)load(false);
</script></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end(html);
}

function serveRecoveryAdmin(res) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>充值记录｜GPTC.cc</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; padding: 20px; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #132033; background: #f4f7fb; }
    main { width: min(1180px, 100%); margin: 0 auto; }
    section { background: #fff; border: 1px solid #dbe4ee; border-radius: 14px; box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08); padding: 22px; margin-bottom: 16px; }
    h1, h2 { margin: 0 0 8px; }
    h1 { font-size: 26px; }
    h2 { font-size: 19px; }
    p, .hint { color: #64748b; line-height: 1.6; }
    .topbar, .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .top-actions, .row-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .back-link, button { min-height: 44px; border-radius: 10px; padding: 0 16px; font: inherit; font-weight: 900; cursor: pointer; }
    .back-link { display: inline-flex; align-items: center; color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; text-decoration: none; }
    button { border: 0; color: #fff; background: #0f766e; }
    button.secondary { color: #0f766e; background: #ecfdf5; border: 1px solid #99f6e4; }
    button.danger { color: #9f1239; background: #fff1f2; border: 1px solid #fda4af; }
    button:disabled { opacity: .55; cursor: wait; }
    label { display: grid; gap: 8px; max-width: 620px; margin-top: 16px; font-weight: 800; }
    input, select { width: 100%; min-height: 44px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 0 12px; font: inherit; background: #fff; }
    .status { margin-top: 16px; padding: 12px; border-radius: 10px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; line-height: 1.6; white-space: pre-wrap; }
    .status.error { background: #fff1f2; border-color: #fda4af; color: #9f1239; }
    .count { color: #475569; font-weight: 900; }
    .table-wrap { overflow-x: auto; margin-top: 14px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 11px 8px; text-align: left; vertical-align: top; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    th { color: #475569; }
    td.message { max-width: 300px; white-space: normal; line-height: 1.5; }
    .row-actions button { min-height: 34px; padding: 0 10px; font-size: 13px; }
    .empty { padding: 28px 8px; color: #64748b; text-align: center; }
    .hint { margin: 10px 0 0; font-size: 13px; }
    @media (max-width: 640px) { body { padding: 12px; } section { padding: 16px; } .top-actions > *, .toolbar button { width: 100%; justify-content: center; } }
  </style>
</head>
<body>
  <main>
    <section>
      <div class="topbar">
        <div><h1>充值记录</h1><p class="hint">查看全部通道的提交记录。JSON 加密保存，成功订单完成45天后自动清除敏感内容。</p></div>
        <div class="top-actions"><a class="back-link" href="/admin/cards">卡密生成</a><a class="back-link" href="/admin/cards/library">卡密库</a></div>
      </div>
      <label>管理密码<input id="adminToken" type="password" autocomplete="current-password" placeholder="请输入 ADMIN_TOKEN"></label>
      <div class="top-actions" style="margin-top:14px"><button id="enableAlerts" type="button">开启桌面提醒</button><button class="secondary" id="refresh" type="button">立即刷新</button></div>
      <div class="status" id="statusBox">输入管理密码后，可以查看全部充值记录。</div>
    </section>
    <section>
      <div class="toolbar"><label>搜索记录<input id="recordSearch" type="search" placeholder="输入账号或卡密"></label><label>状态<select id="statusFilter"><option value="">全部状态</option><option value="processing">处理中</option><option value="success">成功</option><option value="failed">失败</option><option value="needs_review">待确认</option></select></label><label>通道<select id="providerFilter"><option value="">全部通道</option></select></label><span class="count" id="recoveryCount">0 条</span></div>
      <p class="hint">“重新提交”会再次调用充值通道，只有确认上一次没有成功扣费时再使用；“标记成功”只修改本站显示状态，不会调用充值通道。</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>账号</th><th>卡密/通道</th><th>状态</th><th>结果说明</th><th>提交时间</th><th>操作</th></tr></thead>
          <tbody id="recoveries"><tr><td class="empty" colspan="6">暂无充值记录</td></tr></tbody>
        </table>
      </div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById("adminToken");
    const statusBox = document.getElementById("statusBox");
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = hashParams.get("token") || params.get("token") || localStorage.getItem("gptcProviderAdminToken") || "";
    tokenInput.value = token;
    if (token) localStorage.setItem("gptcProviderAdminToken", token);
    let previousIds = new Set();
    let firstLoad = true;
    let audioContext = null;
    let allRecords = [];

    function setStatus(message, error = false) {
      statusBox.textContent = message;
      statusBox.classList.toggle("error", error);
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>\"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;", "'": "&#39;" }[character]));
    }
    function formatDate(value) {
      if (!value) return "-";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
    }
    async function api(path, options = {}) {
      const currentToken = tokenInput.value.trim();
      if (!currentToken) throw new Error("请先输入管理密码。");
      localStorage.setItem("gptcProviderAdminToken", currentToken);
      const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", "X-Admin-Token": currentToken, ...(options.headers || {}) } });
      const data = await response.json();
      if (!data.success) throw new Error(data.message || "操作失败。");
      return data.data;
    }
    function statusLabel(status) {
      return ({ needs_review: "待确认", failed: "失败", success: "成功", processing: "处理中", syncing: "同步中", created: "已创建" })[status] || status;
    }
    function renderRows(items) {
      if (!items.length) return '<tr><td class="empty" colspan="6">暂无匹配记录</td></tr>';
      return items.map(item => '<tr>'
        + '<td>' + escapeHtml(item.userEmail || "-") + '</td>'
        + '<td>' + escapeHtml(item.cardMask || "-") + '<br><small>通道 ' + escapeHtml(item.provider) + '</small></td>'
        + '<td>' + escapeHtml(statusLabel(item.status)) + '</td>'
        + '<td class="message">' + escapeHtml(item.message || "-") + '</td>'
        + '<td>' + escapeHtml(formatDate(item.createdAt)) + '</td>'
        + '<td><div class="row-actions">'
        + (item.hasOriginalJson ? '<button class="secondary" type="button" data-action="copy-json" data-order-id="' + escapeHtml(item.id) + '">复制JSON</button>' : '')
        + (["failed", "needs_review"].includes(item.status) ? '<button class="secondary" type="button" data-action="retry" data-order-id="' + escapeHtml(item.id) + '">重新提交</button><button type="button" data-action="mark-success" data-order-id="' + escapeHtml(item.id) + '">标记成功</button>' : '')
        + '</div></td></tr>').join("");
    }
    function applyRecordFilters() {
      const keyword = document.getElementById("recordSearch").value.trim().toLowerCase();
      const status = document.getElementById("statusFilter").value;
      const provider = document.getElementById("providerFilter").value;
      const records = allRecords.filter(item => (!keyword || [item.userEmail, item.cardMask].some(value => String(value || "").toLowerCase().includes(keyword))) && (!status || item.status === status) && (!provider || item.provider === provider));
      document.getElementById("recoveries").innerHTML = renderRows(records);
      document.getElementById("recoveryCount").textContent = records.length + " / " + allRecords.length + " 条";
    }
    function playAlert() {
      if (!audioContext) return;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.18);
    }
    function notifyNew(items) {
      const fresh = items.filter(item => !previousIds.has(item.id));
      if (!firstLoad && fresh.length) {
        playAlert();
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("GPTC 有新的待处理订单", { body: fresh.length + " 条充值订单需要跟进。" });
        }
      }
      previousIds = new Set(items.map(item => item.id));
      firstLoad = false;
    }
    async function loadRecoveries() {
      try {
        const data = await api("/api/admin/recharge-records");
        allRecords = data.records || [];
        const providerSelect = document.getElementById("providerFilter");
        const selectedProvider = providerSelect.value;
        const providers = [...new Set(allRecords.map(item => item.provider).filter(Boolean))].sort();
        providerSelect.innerHTML = '<option value="">全部通道</option>' + providers.map(value => '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + '</option>').join("");
        providerSelect.value = selectedProvider;
        applyRecordFilters();
        const pending = allRecords.filter(item => ["failed", "needs_review"].includes(item.status));
        notifyNew(pending);
        setStatus(data.pendingCount ? "共 " + allRecords.length + " 条记录，其中 " + data.pendingCount + " 条需要处理。" : "共 " + allRecords.length + " 条记录，当前没有待处理订单。");
      } catch (error) { setStatus(error.message, true); }
    }
    document.getElementById("enableAlerts").addEventListener("click", async () => {
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await audioContext.resume();
        if ("Notification" in window) await Notification.requestPermission();
        setStatus("桌面提醒已开启。页面保持打开时，会自动提示新的失败订单。", false);
        playAlert();
      } catch (error) { setStatus("提醒开启失败，请检查浏览器通知权限。", true); }
    });
    document.getElementById("refresh").addEventListener("click", loadRecoveries);
    document.getElementById("recordSearch").addEventListener("input", applyRecordFilters);
    document.getElementById("statusFilter").addEventListener("change", applyRecordFilters);
    document.getElementById("providerFilter").addEventListener("change", applyRecordFilters);
    document.getElementById("recoveries").addEventListener("click", async event => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      const orderId = button.dataset.orderId;
      if (action === "retry" && !window.confirm("确认重新提交这笔充值？请先确认上一次没有成功扣费。")) return;
      if (action === "mark-success" && !window.confirm("确认这笔订单已经人工充值成功，并同步为成功状态？")) return;
      button.disabled = true;
      try {
        if (action === "copy-json") {
          const detail = await api("/api/admin/recoveries/" + encodeURIComponent(orderId) + "?reveal=1");
          await navigator.clipboard.writeText(detail.secretJsonText || "");
          setStatus("JSON 已复制到剪贴板，请注意不要转发给无关人员。");
        } else {
          const endpoint = action === "retry" ? "retry" : "mark-success";
          const data = await api("/api/admin/recoveries/" + encodeURIComponent(orderId) + "/" + endpoint, { method: "POST", body: JSON.stringify({}) });
          setStatus(action === "retry" ? (data.message || "已重新提交，正在处理。"): "已同步为充值成功。");
          await loadRecoveries();
        }
      } catch (error) { setStatus(error.message, true); }
      finally { button.disabled = false; }
    });
    if (token) loadRecoveries();
    window.setInterval(() => { if (tokenInput.value.trim()) loadRecoveries(); }, 10000);
  </script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer"
  });
  res.end(html);
}

function serveProviderSwitchResult(res, result) {
  const success = result.ok;
  const title = success ? "源头已切换" : "切换失败";
  const locationLabel = result.data?.defaultProviderMode === "redirect" ? "站外充值" : "站内充值";
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

    if (req.method === "GET" && (url.pathname === "/admin/cards/library" || url.pathname === "/admin/cards/library/")) {
      serveHCardLibraryAdmin(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/hifupay/cards" || url.pathname === "/admin/hifupay/cards/")) {
      serveHifupayCardAdmin(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/recoveries" || url.pathname === "/admin/recoveries/")) {
      serveRecoveryAdmin(res);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/admin/cards" || url.pathname === "/admin/cards/")) {
      serveHCardAdmin(res);
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

    if (req.method === "GET" && url.pathname === "/api/admin/h-cards") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.listHCards(
        url.searchParams.get("limit") || 100,
        ["1", "true"].includes(url.searchParams.get("all")),
        ["1", "true"].includes(url.searchParams.get("reveal")),
        ["1", "true"].includes(url.searchParams.get("archived"))
      );
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/hifupay/cards") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      if (["1", "true"].includes(url.searchParams.get("refresh"))) {
        const refreshed = await rechargeService.refreshHifupayCards();
        if (!refreshed.ok) {
          sendJson(res, refreshed.status || 502, { success: false, message: refreshed.message });
          return;
        }
      }
      const result = rechargeService.listHifupayCards();
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    const hifupayCardAction = url.pathname.match(/^\/api\/admin\/hifupay\/cards\/([^/]+)\/(disable|enable|release|settings)$/);
    if (req.method === "POST" && hifupayCardAction) {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const cardId = decodeURIComponent(hifupayCardAction[1]);
      const action = hifupayCardAction[2];
      const result = action === "release"
        ? rechargeService.clearHifupayReservation(cardId, body.orderId)
        : action === "settings"
          ? (body.field === "priority"
            ? rechargeService.setHifupayCardPriority(cardId, body.value)
            : { ok: false, status: 400, message: "不支持的卡片设置。" })
        : rechargeService.setHifupayCardEnabled(cardId, action === "enable");
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/recoveries") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.listRecoverySubmissions();
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/recharge-records") {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.listRechargeSubmissions();
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    const recoveryDetail = url.pathname.match(/^\/api\/admin\/recoveries\/([^/]+)$/);
    if (req.method === "GET" && recoveryDetail) {
      const auth = assertAdmin(req, url);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.getRecoverySubmission(
        decodeURIComponent(recoveryDetail[1]),
        ["1", "true"].includes(url.searchParams.get("reveal"))
      );
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    const recoveryAction = url.pathname.match(/^\/api\/admin\/recoveries\/([^/]+)\/(retry|mark-success)$/);
    if (req.method === "POST" && recoveryAction) {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const orderId = decodeURIComponent(recoveryAction[1]);
      const action = recoveryAction[2];
      const result = action === "retry"
        ? await rechargeService.retryRecovery(orderId, "admin")
        : rechargeService.markRecoverySuccess(orderId, "admin", body.message || "人工充值成功，系统已同步完成。");
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message, data: result.data });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/h-cards") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.createHCards(body);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/admin/h-cards/bulk") {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const result = rechargeService.bulkHCardAction(body.cardIds, body.action);
      sendJson(res, result.status, { success: true, data: result.data });
      return;
    }

    const hCardAction = url.pathname.match(/^\/api\/admin\/h-cards\/([^/]+)\/(unlock|disable|enable|archive|restore|delete)$/);
    if (req.method === "POST" && hCardAction) {
      const body = await readJsonBody(req);
      const auth = assertAdmin(req, url, body);
      if (!auth.ok) {
        sendJson(res, auth.status, { success: false, message: auth.message });
        return;
      }
      const cardId = decodeURIComponent(hCardAction[1]);
      const action = hCardAction[2];
      const result = action === "unlock"
        ? rechargeService.unlockHCard(cardId)
        : action === "archive" || action === "restore"
          ? rechargeService.archiveHCard(cardId, action === "archive")
          : action === "delete"
            ? rechargeService.deleteHCard(cardId)
            : rechargeService.setHCardDisabled(cardId, action === "disable", body.reason);
      sendJson(res, result.status, result.ok ? { success: true, data: result.data } : { success: false, message: result.message });
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
