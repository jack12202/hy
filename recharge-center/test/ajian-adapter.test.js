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

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

test("ajian adapter relays card verification, token preview, confirmation and polling", async t => {
  let pollCount = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      sendHtml(res, 200, '<form method="post" action="/card/verify"><input type="hidden" name="_csrf" value="home-csrf"></form>', {
        "Set-Cookie": "gpt_public_csrf=home-cookie; Path=/"
      });
      return;
    }

    if (req.method === "POST" && req.url === "/card/verify") {
      const form = new URLSearchParams(await readBody(req));
      assert.equal(form.get("_csrf"), "home-csrf");
      assert.equal(form.get("cardKey"), "TEST-AJIAN-CARD");
      sendHtml(res, 200, '<form method="post" action="/recharge/preview"><input type="hidden" name="_csrf" value="verify-csrf"><input type="hidden" name="cardKey" value="TEST-AJIAN-CARD"><textarea name="token"></textarea></form>', {
        "Set-Cookie": "gpt_public_csrf=verified-cookie; Path=/"
      });
      return;
    }

    if (req.method === "POST" && req.url === "/recharge/preview") {
      const form = new URLSearchParams(await readBody(req));
      assert.equal(form.get("_csrf"), "verify-csrf");
      assert.equal(form.get("cardKey"), "TEST-AJIAN-CARD");
      assert.equal(JSON.parse(form.get("token")).accessToken, "token_test");
      sendHtml(res, 200, '<form method="post" action="/recharge/confirm"><input type="hidden" name="_csrf" value="preview-csrf"><input type="hidden" name="cardKey" value="TEST-AJIAN-CARD"><button type="submit">确认充值</button></form>');
      return;
    }

    if (req.method === "POST" && req.url === "/recharge/confirm") {
      const form = new URLSearchParams(await readBody(req));
      assert.equal(form.get("_csrf"), "preview-csrf");
      res.writeHead(303, { Location: "/recharge/status-page" });
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/recharge/status-page") {
      sendHtml(res, 200, '<meta name="csrf-token" content="status-csrf"><div data-status-endpoint="/recharge/status"></div>');
      return;
    }

    if (req.method === "POST" && req.url === "/recharge/status") {
      const body = JSON.parse(await readBody(req));
      assert.equal(body._csrf, "status-csrf");
      pollCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(pollCount === 1
        ? { status: "processing", message: "处理中" }
        : { status: "completed", account: "test@example.com", tier: "Plus", message: "充值成功" }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const address = upstream.address();
  process.env.AJIAN_BASE_URL = `http://127.0.0.1:${address.port}`;

  const { ajianAdapter } = await import(`../src/providers/ajian-adapter.js?test=${Date.now()}`);
  const verified = await ajianAdapter.verifyCard({ cardInfo: "TEST-AJIAN-CARD" });
  assert.equal(verified.ok, true);
  assert.ok(verified.data.providerSessionId);

  const started = await ajianAdapter.startRecharge({
    cardInfo: "TEST-AJIAN-CARD",
    providerSessionId: verified.data.providerSessionId,
    fullAuthData: {
      user: { email: "test@example.com" },
      account: { id: "account_test" },
      accessToken: "token_test"
    }
  });
  assert.equal(started.ok, true);
  assert.match(started.data.taskId, /^j_/);

  const processing = await ajianAdapter.queryTaskStatus({ taskId: started.data.taskId });
  assert.equal(processing.data.status, "processing");

  const completed = await ajianAdapter.queryTaskStatus({ taskId: started.data.taskId });
  assert.equal(completed.data.status, "success");
  assert.equal(completed.data.account, "test@example.com");
});
