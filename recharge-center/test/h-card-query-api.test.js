import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("h card query APIs are read-only, authenticated where required, and rate limited", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-h-query-"));
  const dataFile = path.join(tempDir, "orders.json");
  process.env.DATA_FILE = dataFile;
  process.env.ADMIN_TOKEN = "query-test-admin-token";
  process.env.H_CARD_QUERY_MINUTE_LIMIT = "3";
  process.env.H_CARD_QUERY_HOUR_LIMIT = "5";

  const { JsonStore } = await import(`../src/store.js?query-api=${Date.now()}`);
  const store = new JsonStore(dataFile);
  const cards = store.createHCards({ count: 6, source: "接口测试", productId: 3 });

  store.updateHCard(cards[1].id, { status: "locked" });

  const processingOrder = store.createOrder({ provider: "h", status: "processing" });
  assert.equal(store.reserveHCard(cards[2].code, processingOrder.id, { email: "processing@example.com" }).ok, true);

  const successOrder = store.createOrder({ provider: "h", status: "processing" });
  const successReservation = store.reserveHCard(cards[3].code, successOrder.id, { email: "success@example.com", accountId: "account_success" });
  assert.equal(successReservation.ok, true);
  assert.equal(store.completeHCard(successReservation.cardId, successOrder.id), true);
  store.updateOrder(successOrder.id, {
    status: "success",
    message: "充值成功，但自动续费关闭失败。",
    subscriptionCancellationStatus: "failed",
    subscriptionActionRequired: true,
    subscriptionActionMessage: "充值成功，但自动续费未关闭，请联系用户手动取消连续订阅。"
  });

  const failedOrder = store.createOrder({ provider: "h", status: "processing" });
  assert.equal(store.reserveHCard(cards[4].code, failedOrder.id, { email: "failed@example.com" }).ok, true);
  store.updateOrder(failedOrder.id, { status: "failed", message: "payment failed: upstream order 12345" });

  assert.equal(store.setHCardDisabled(cards[5].id, true, "测试禁用").ok, true);
  const dataBeforeQueries = fs.readFileSync(dataFile, "utf8");

  const { server } = await import(`../src/server.js?query-api=${Date.now()}`);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const batchPage = await fetch(`${baseUrl}/admin/cards/batch`);
  assert.equal(batchPage.status, 200);
  assert.match(await batchPage.text(), /<h1>批量查询<\/h1>/);

  async function post(urlPath, body, { ip = "127.0.0.1", token = "" } = {}) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Real-IP": ip,
        ...(token ? { "X-Admin-Token": token } : {})
      },
      body: JSON.stringify(body)
    });
    return { response, payload: await response.json() };
  }

  const cases = [
    [cards[0].code, "unused"],
    [cards[1].code, "locked"],
    [cards[2].code, "processing"],
    [cards[3].code, "success"],
    [cards[4].code, "failed"],
    [cards[5].code, "disabled"]
  ];
  for (const [index, [code, expectedStatus]] of cases.entries()) {
    const { response, payload } = await post("/api/recharge/h-card-status", { provider: "h", cardInfo: code }, { ip: `198.51.100.${index + 1}` });
    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data.status, expectedStatus);
    assert.equal(payload.data.canRecharge, expectedStatus === "unused");
    assert.deepEqual(Object.keys(payload.data).sort(), [
      "boundAccount",
      "canRecharge",
      "message",
      "status",
      "statusLabel",
      "subscriptionActionMessage",
      "subscriptionActionRequired",
      "subscriptionCancellationStatus"
    ]);
  }

  const successQuery = await post("/api/recharge/h-card-status", { provider: "h", cardInfo: cards[3].code }, { ip: "198.51.100.20" });
  assert.equal(successQuery.payload.data.boundAccount, "s***@example.com");
  assert.equal(successQuery.payload.data.status, "success");
  assert.equal(successQuery.payload.data.subscriptionCancellationStatus, "failed");
  assert.equal(successQuery.payload.data.subscriptionActionRequired, true);
  assert.match(successQuery.payload.data.message, /手动取消连续订阅/);
  assert.equal(JSON.stringify(successQuery.payload).includes("success@example.com"), false);
  assert.equal(JSON.stringify(successQuery.payload).includes(successOrder.id), false);

  const missingCode = `HPLUS${"F".repeat(32)}`;
  const missing = await post("/api/recharge/h-card-status", { provider: "h", cardInfo: missingCode }, { ip: "198.51.100.21" });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.payload.success, false);

  const nonH = await post("/api/recharge/h-card-status", { provider: "czgpt", cardInfo: cards[0].code }, { ip: "198.51.100.22" });
  assert.equal(nonH.response.status, 400);
  assert.equal(nonH.payload.success, false);

  const unauthorized = await post("/api/admin/h-cards/query", { inputs: [cards[0].code] });
  assert.equal(unauthorized.response.status, 401);
  const unauthorizedHandled = await post(`/api/admin/recoveries/${successOrder.id}/mark-subscription-handled`, {});
  assert.equal(unauthorizedHandled.response.status, 401);

  const mixed = await post("/api/admin/h-cards/query", {
    inputs: [
      cards[0].code,
      `https://www.gptc.cc/activate/?provider=h&card=${cards[4].code}`,
      missingCode,
      `https://gptc.cc/activate/?provider=czgpt&card=${cards[2].code}`
    ]
  }, { token: "query-test-admin-token" });
  assert.equal(mixed.response.status, 200);
  assert.deepEqual(mixed.payload.data.results.map(item => item.status), ["unused", "failed", "not_found", "invalid"]);
  assert.equal(mixed.payload.data.results[1].failureReason, "支付未成功");
  assert.equal(mixed.payload.data.results[1].code, cards[4].code);
  assert.equal(JSON.stringify(mixed.payload).includes(failedOrder.id), false);
  assert.equal(JSON.stringify(mixed.payload).includes("upstream order 12345"), false);

  const tooMany = await post("/api/admin/h-cards/query", { inputs: Array.from({ length: 101 }, () => cards[0].code) }, { token: "query-test-admin-token" });
  assert.equal(tooMany.response.status, 400);

  for (let index = 0; index < 3; index += 1) {
    const allowed = await post("/api/recharge/h-card-status", { provider: "h", cardInfo: cards[0].code }, { ip: "203.0.113.10" });
    assert.equal(allowed.response.status, 200);
  }
  const limited = await post("/api/recharge/h-card-status", { provider: "h", cardInfo: cards[0].code }, { ip: "203.0.113.10" });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "60");
  assert.equal(limited.payload.success, false);

  assert.equal(fs.readFileSync(dataFile, "utf8"), dataBeforeQueries);
});
