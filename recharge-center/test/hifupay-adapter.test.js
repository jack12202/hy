import assert from "node:assert/strict";
import http from "node:http";
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

test("hifupay adapter submits Plus PH tasks and normalizes polling status", async t => {
  let pollCount = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/api/hfp/login") {
      const body = JSON.parse(await readBody(req));
      assert.equal(body.apiKey, "hifupay-test-key");
      assert.equal(body.platform, "haifupaytop");
      sendJson(res, 200, { success: true, apiKey: "hifupay-session-key" });
      return;
    }

    if (req.method === "POST" && req.url === "/verify") {
      const body = JSON.parse(await readBody(req));
      assert.deepEqual(body, { cardInfo: "H-TEST-CARD", provider: "h" });
      sendJson(res, 200, { success: true, valid: true, used: false });
      return;
    }

    if (req.method === "POST" && req.url === "/api/start") {
      assert.equal(req.headers["x-api-key"], "hifupay-session-key");
      const body = JSON.parse(await readBody(req));
      assert.equal(body.plan, "plus");
      assert.equal(body.region, "PH");
      assert.equal(body.proxyRegion, "PH3");
      assert.equal(body.engine, "oaics");
      assert.equal(body.hfpCardId, "card_test");
      assert.equal(JSON.parse(body.token).accessToken, "token_test");
      sendJson(res, 200, { taskId: "H-TASK-1" });
      return;
    }

    if (req.method === "GET" && req.url === "/api/status/H-TASK-1") {
      assert.equal(req.headers["x-api-key"], "hifupay-session-key");
      pollCount += 1;
      sendJson(res, 200, pollCount === 1
        ? { status: "running", paymentConfirmed: false }
        : {
            status: "completed",
            paymentConfirmed: true,
            autoCancelDone: true,
            account: "test@example.com"
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
    verifyUrl: process.env.HIFUPAY_CARD_VERIFY_URL
  };
  t.after(() => {
    for (const [key, value] of Object.entries({
      HIFUPAY_BASE_URL: previous.baseUrl,
      HIFUPAY_API_KEY: previous.apiKey,
      HIFUPAY_CARD_ID: previous.cardId,
      HIFUPAY_CARD_VERIFY_URL: previous.verifyUrl
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const address = upstream.address();
  process.env.HIFUPAY_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.HIFUPAY_API_KEY = "hifupay-test-key";
  process.env.HIFUPAY_CARD_ID = "card_test";
  process.env.HIFUPAY_CARD_VERIFY_URL = `http://127.0.0.1:${address.port}/verify`;

  const { hifupayAdapter } = await import(`../src/providers/hifupay-adapter.js?test=${Date.now()}`);
  const verified = await hifupayAdapter.verifyCard({ cardInfo: "H-TEST-CARD" });
  assert.equal(verified.ok, true);
  assert.equal(verified.data.provider, "h");

  const started = await hifupayAdapter.startRecharge({
    fullAuthData: {
      user: { email: "test@example.com" },
      account: { id: "account_test" },
      accessToken: "token_test"
    }
  });
  assert.equal(started.ok, true);
  assert.equal(started.data.taskId, "H-TASK-1");

  const processing = await hifupayAdapter.queryTaskStatus({ taskId: "H-TASK-1" });
  assert.equal(processing.data.status, "processing");
  assert.equal(processing.data.paymentConfirmed, false);

  const completed = await hifupayAdapter.queryTaskStatus({ taskId: "H-TASK-1" });
  assert.equal(completed.data.status, "success");
  assert.equal(completed.data.account, "test@example.com");
  assert.equal(completed.data.autoCancelDone, true);
});
