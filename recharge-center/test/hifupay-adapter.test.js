import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import os from "node:os";
import path from "node:path";

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

test("hifupay adapter submits Plus PH tasks and normalizes polling status", async t => {
  let pollCount = 0;
  let cardsAvailable = true;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/hfp/login") {
      const body = JSON.parse(await readBody(req));
      assert.equal(body.apiKey, "hifupay-test-key");
      assert.equal(body.platform, "haifupaytop");
      sendJson(res, 200, { success: true, apiKey: "hifupay-session-key" });
      return;
    }

    if (req.method === "POST" && req.url === "/api/hfp/cards") {
      sendJson(res, 200, cardsAvailable
        ? { cards: [{ id: "7172", lastFour: "4113", status: "active", balance: 66, expiryDate: "09/28" }, { id: "7667", lastFour: "6737", status: "active", balance: 20, expiryDate: "09/28" }] }
        : { cards: [] });
      return;
    }

    if (req.method === "POST" && req.url === "/api/start") {
      assert.equal(req.headers["x-api-key"], "hifupay-session-key");
      const body = JSON.parse(await readBody(req));
      assert.equal(body.plan, "plus");
      assert.equal(body.region, "PH");
      assert.equal(body.proxyRegion, "PH3");
      assert.equal(body.engine, "oaics");
      assert.equal(body.hfpCardId, "7172");
      assert.equal(JSON.parse(body.token).accessToken, "token_test");
      sendJson(res, 200, { taskId: "H-TASK-1" });
      return;
    }

    if (req.method === "GET" && req.url === "/api/status/H-TASK-1") {
      assert.equal(req.headers["x-api-key"], "hifupay-session-key");
      pollCount += 1;
      sendJson(res, 200, pollCount === 1
        ? { status: "running", paymentConfirmed: false }
        : pollCount === 2 ? {
            status: "completed",
            paymentConfirmed: true,
            autoCancelDone: true,
            account: "test@example.com"
          } : {
            status: "failed",
            paymentConfirmed: false,
            logs: ["[payment_confirm] payment succeeded", "取消自动续费失败 HTTP 404"]
          });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const previous = {
    baseUrl: process.env.HIFUPAY_BASE_URL,
    apiKey: process.env.HIFUPAY_API_KEY,
    cardId: process.env.HIFUPAY_CARD_ID,
    dataFile: process.env.DATA_FILE
  };
  t.after(() => {
    for (const [key, value] of Object.entries({
      HIFUPAY_BASE_URL: previous.baseUrl,
      HIFUPAY_API_KEY: previous.apiKey,
      HIFUPAY_CARD_ID: previous.cardId,
      DATA_FILE: previous.dataFile
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const address = upstream.address();
  process.env.HIFUPAY_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.HIFUPAY_API_KEY = "hifupay-test-key";
  process.env.HIFUPAY_CARD_ID = "7172";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-test-"));
  const dataFile = path.join(tempDir, "orders.json");
  process.env.DATA_FILE = dataFile;
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const { hifupayAdapter } = await import(`../src/providers/hifupay-adapter.js?test=${Date.now()}`);
  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(dataFile);
  const [card] = store.createHCards({ count: 1, productId: 3 });

  const verified = await hifupayAdapter.verifyCard({ cardInfo: card.code });
  assert.equal(verified.ok, true);
  assert.equal(verified.data.provider, "h");
  assert.equal(verified.data.cardId, card.id);
  assert.equal(new JsonStore(dataFile).getHCardByCode(card.code).status, "unused");

  const started = await hifupayAdapter.startRecharge({
    cardInfo: card.code,
    orderId: "order_h_test",
    fullAuthData: {
      user: { email: "test@example.com" },
      account: { id: "account_test" },
      accessToken: "token_test"
    }
  });
  assert.equal(started.ok, true);
  assert.equal(started.data.taskId, "H-TASK-1");
  assert.equal(started.data.cardId, card.id);
  assert.equal(new JsonStore(dataFile).getHCardByCode(card.code).status, "locked");

  const processing = await hifupayAdapter.queryTaskStatus({ taskId: "H-TASK-1" });
  assert.equal(processing.data.status, "processing");
  assert.equal(processing.data.paymentConfirmed, false);

  const completed = await hifupayAdapter.queryTaskStatus({ taskId: "H-TASK-1" });
  assert.equal(completed.data.status, "success");
  assert.equal(completed.data.account, "test@example.com");
  assert.equal(completed.data.autoCancelDone, true);
  const cancellationWarning = await hifupayAdapter.queryTaskStatus({ taskId: "H-TASK-1" });
  assert.equal(cancellationWarning.data.status, "success");
  assert.equal(cancellationWarning.data.paymentConfirmed, true);
  assert.match(cancellationWarning.data.message, /自动续费关闭失败/);
  assert.equal(new JsonStore(dataFile).completeHCard(card.id, "order_h_test"), true);
  assert.equal(new JsonStore(dataFile).getHCardByCode(card.code).status, "used");

  const [failedCard] = new JsonStore(dataFile).createHCards({ count: 1, productId: 3 });
  cardsAvailable = false;
  const failedStart = await hifupayAdapter.startRecharge({
    cardInfo: failedCard.code,
    orderId: "order_h_failed",
    fullAuthData: {
      user: { email: "failed@example.com" },
      account: { id: "account_failed" },
      accessToken: "token_failed"
    }
  });
  assert.equal(failedStart.ok, false);
  assert.equal(failedStart.status, 409);
  const failedStoredCard = new JsonStore(dataFile).getHCardByCode(failedCard.code);
  assert.equal(failedStoredCard.status, "locked");
  assert.equal(failedStoredCard.boundEmail, "failed@example.com");
  assert.equal(failedStoredCard.boundAccountId, "account_failed");
});
