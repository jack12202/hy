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

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

test("Xiaoyu adapter preserves card-key case and uses the documented third-party flow", async t => {
  const cardKey = "MixedCase-card-Key_123";
  const failedCardKey = "RetryCase-card-Key_456";
  let statusCount = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/card-keys/check-usage") {
      const payload = JSON.parse(await readBody(req));
      assert.equal(payload.key, cardKey);
      sendJson(res, 200, {
        exists: true,
        status: "unused",
        is_used: false,
        type: "plus",
        plan_type: "plus"
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/third-party/orders/direct") {
      assert.equal(req.headers["x-api-key"], "xiaoyu-test-api-key");
      const payload = JSON.parse(await readBody(req));
      assert.equal(payload.orderType, "card_key");
      assert.equal(payload.cardKey, cardKey);
      assert.equal(payload.token.user.email, "test@example.com");
      assert.equal(payload.token.account.id, "account_test");
      assert.equal(payload.token.accessToken, "token_test");
      sendJson(res, 201, {
        code: 0,
        message: "success",
        data: {
          order_no: "order-test",
          card_key: cardKey,
          status: "processing",
          plan_type: "plus",
          message: "订单已进入队列"
        }
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/third-party/orders/status") {
      assert.equal(req.headers["x-api-key"], "xiaoyu-test-api-key");
      const payload = JSON.parse(await readBody(req));
      if (payload.cardKey === failedCardKey) {
        sendJson(res, 200, {
          code: 0,
          message: "success",
          data: {
            order_no: "failed-order",
            card_key: failedCardKey,
            status: "failed",
            retry_attempt: 1,
            failure_reason: "支付失败"
          }
        });
        return;
      }
      assert.equal(payload.cardKey, cardKey);
      statusCount += 1;
      const succeeded = statusCount > 1;
      sendJson(res, 200, {
        code: 0,
        message: "success",
        data: {
          order_no: "order-test",
          card_key: cardKey,
          status: succeeded ? "success" : "processing",
          retry_attempt: 1,
          plan_type: "plus",
          payment_amount: "20.00",
          payment_currency: "USD",
          bank_card_no: "4242424242424242",
          token: { accessToken: "must-not-leak" },
          payment_result: { success: succeeded, message: succeeded ? "支付成功" : "处理中" }
        }
      });
      return;
    }

    sendJson(res, 404, { code: 40403, message: "订单不存在", data: null });
  });

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const address = upstream.address();
  process.env.XIAOYU_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.XIAOYU_API_KEY = "xiaoyu-test-api-key";
  process.env.DATA_FILE = path.join(os.tmpdir(), `gptc-xiaoyu-test-${Date.now()}.json`);
  t.after(() => fs.rmSync(process.env.DATA_FILE, { force: true }));

  const { xiaoyuAdapter } = await import(`../src/providers/xiaoyu-adapter.js?test=${Date.now()}`);
  const verified = await xiaoyuAdapter.verifyCard({ cardInfo: cardKey });
  assert.equal(verified.ok, true);
  assert.equal(verified.data.cardCode, cardKey);
  assert.equal(verified.data.planType, "plus");

  const started = await xiaoyuAdapter.startRecharge({
    cardInfo: cardKey,
    fullAuthData: {
      user: { email: "test@example.com" },
      account: { id: "account_test" },
      accessToken: "token_test"
    }
  });
  assert.equal(started.ok, true);
  assert.equal(started.data.taskId, cardKey);
  assert.equal(started.data.orderNo, "order-test");

  const processing = await xiaoyuAdapter.queryTaskStatus({ taskId: cardKey });
  assert.equal(processing.data.status, "processing");

  const succeeded = await xiaoyuAdapter.queryTaskStatus({ taskId: cardKey });
  assert.equal(succeeded.data.status, "success");
  assert.equal(succeeded.data.paymentAmount, "20.00");
  assert.equal(succeeded.data.paymentCurrency, "USD");
  assert.equal("token" in succeeded.data, false);
  assert.equal("bank_card_no" in succeeded.data, false);
  assert.equal("payment_result" in succeeded.data, false);

  const first = await xiaoyuAdapter.queryTaskStatus({ taskId: failedCardKey });
  assert.equal(first.data.status, "needs_review");
  const confirmed = await xiaoyuAdapter.queryTaskStatus({ taskId: failedCardKey });
  assert.equal(confirmed.data.status, "failed");
});
