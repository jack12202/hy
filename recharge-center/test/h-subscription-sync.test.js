import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

test("h subscription state is backfilled after payment success and alerts administrators", async t => {
  let statusPollCount = 0;
  const webhookPayloads = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/hfp/login") {
      sendJson(res, 200, { success: true, apiKey: "hifupay-session-key" });
      return;
    }
    if (req.method === "GET" && req.url === "/api/status/H-TASK-SUBSCRIPTION") {
      statusPollCount += 1;
      sendJson(res, 200, statusPollCount === 1
        ? {
            status: "running",
            paymentConfirmed: true,
            logs: ["[payment_confirm] payment succeeded"]
          }
        : {
            status: "failed",
            paymentConfirmed: false,
            logs: [
              "[payment_confirm] payment succeeded",
              "充值已成功，但关闭自动续费失败（Session 失效，请重新获取 Token）"
            ]
          });
      return;
    }
    if (req.method === "GET" && req.url === "/api/status/H-TASK-TRANSIENT") {
      sendJson(res, 503, { message: "internal token refresh failed" });
      return;
    }
    if (req.method === "POST" && req.url === "/admin-alert") {
      webhookPayloads.push(JSON.parse(await readBody(req)));
      sendJson(res, 200, { ok: true });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-h-subscription-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const address = upstream.address();
  process.env.DATA_FILE = path.join(tempDir, "orders.json");
  process.env.HIFUPAY_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.HIFUPAY_API_KEY = "hifupay-test-key";
  process.env.ADMIN_ALERT_WEBHOOK_URL = `http://127.0.0.1:${address.port}/admin-alert`;
  process.env.ADMIN_ALERT_WEBHOOK_TYPE = "generic";
  process.env.PUBLIC_BASE_URL = "https://www.gptc.cc";

  const { JsonStore } = await import(`../src/store.js?h-subscription=${Date.now()}`);
  const { rechargeService } = await import(`../src/recharge-service.js?h-subscription=${Date.now()}`);
  const store = new JsonStore(process.env.DATA_FILE);
  const order = store.createOrder({
    provider: "h",
    status: "success",
    upstreamTaskId: "H-TASK-SUBSCRIPTION",
    cardMask: "HPLU****06CA",
    message: "充值成功。"
  });
  store.createRechargeSession({ orderId: order.id, userEmail: "customer@example.com" });

  const pendingSync = await rechargeService.reconcileHSubscriptionStatuses();
  assert.equal(pendingSync.checkedCount, 1);
  assert.equal(statusPollCount, 1);
  assert.equal(store.getOrder(order.id).status, "success");
  assert.equal(store.getOrder(order.id).subscriptionCancellationStatus, "pending");
  assert.equal(store.getOrder(order.id).subscriptionActionRequired, false);
  assert.equal(webhookPayloads.length, 0);

  const failedSync = await rechargeService.reconcileHSubscriptionStatuses();
  assert.equal(failedSync.checkedCount, 1);
  assert.equal(statusPollCount, 2);
  const failedOrder = store.getOrder(order.id);
  assert.equal(failedOrder.status, "success");
  assert.equal(failedOrder.subscriptionCancellationStatus, "failed");
  assert.equal(failedOrder.subscriptionActionRequired, true);
  assert.match(failedOrder.message, /自动续费关闭失败/);
  assert.equal(webhookPayloads.length, 1);
  assert.equal(webhookPayloads[0].event, "h_subscription_cancellation_required");
  assert.equal(webhookPayloads[0].account, "customer@example.com");
  assert.equal(JSON.stringify(webhookPayloads[0]).includes(order.id), false);
  assert.equal(JSON.stringify(webhookPayloads[0]).includes("Token"), false);

  const records = rechargeService.listRechargeSubmissions();
  const record = records.data.records.find(item => item.id === order.id);
  assert.equal(records.data.pendingCount, 1);
  assert.equal(record.status, "success");
  assert.equal(record.needsAttention, true);

  const handled = rechargeService.markHSubscriptionHandled(order.id, "admin");
  assert.equal(handled.ok, true);
  assert.equal(rechargeService.listRechargeSubmissions().data.records.find(item => item.id === order.id).needsAttention, false);

  const finalSync = await rechargeService.reconcileHSubscriptionStatuses();
  assert.equal(finalSync.checkedCount, 0);
  assert.equal(webhookPayloads.length, 1);

  const transientOrder = store.createOrder({
    provider: "h",
    status: "success",
    upstreamTaskId: "H-TASK-TRANSIENT",
    subscriptionCancellationStatus: "pending",
    subscriptionFollowUpUntil: new Date(Date.now() + 60_000).toISOString(),
    message: "充值成功。"
  });
  const transient = await rechargeService.queryTaskStatus({ orderId: transientOrder.id }, { forceRefresh: true });
  assert.equal(transient.ok, false);
  assert.equal(store.getOrder(transientOrder.id).status, "success");
  assert.equal(store.getOrder(transientOrder.id).subscriptionCancellationStatus, "pending");
  assert.equal(store.getOrder(transientOrder.id).message.includes("internal token"), false);
});
