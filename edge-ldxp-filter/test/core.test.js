const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function loadApi() {
  const source = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  let exported = null;
  const context = {
    URL,
    URLSearchParams,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    location: { hostname: "www.ldxp.cn", pathname: "/merchant/my_parent/source_square", search: "", origin: "https://www.ldxp.cn" },
    __LDXP_EDGE_FILTER_TEST_EXPORTS__: (api) => {
      exported = api;
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: path.join(ROOT, "content.js") });
  return exported;
}

const api = loadApi();
const ids = (items) => items.map((item) => item.id);

test("prices round up to whole cents without float noise", () => {
  assert.equal(api.roundPrice(1.1), 1.1);
  assert.equal(api.roundPrice(1.1 * 1.1), 1.21);
  assert.equal(api.roundPrice(0.1 + 0.2), 0.3);
  assert.equal(api.roundPrice(1.001), 1.01);
  assert.equal(api.roundPrice(-3), 0);
});

test("connect price follows the chosen markup", () => {
  const item = { cost_price: 1.1 };
  assert.equal(api.calculateConnectPrice({ add_type: 3 }, item).price, 1.1);
  assert.equal(api.calculateConnectPrice({ add_type: 1, add_rate: 10 }, item).price, 1.21);
  assert.equal(api.calculateConnectPrice({ add_type: 2, add_price: 0.2 }, item).price, 1.3);
});

test("connect price is raised to the merchant minimum", () => {
  const result = api.calculateConnectPrice({ add_type: 3 }, { cost_price: 5, agent_price_limit: 6.5 });
  assert.equal(result.price, 6.5);
  assert.equal(result.raised, true);
});

test("profit and profit rate", () => {
  assert.equal(api.getProfit({ price: 13, cost_price: 10 }), 3);
  assert.equal(api.getProfitRate({ price: 13, cost_price: 10 }), 30);
  assert.equal(api.getProfit({ price: 1.3, cost_price: 1.1 }), 0.2);
  assert.equal(api.getProfit({ cost_price: 10 }), null);
  assert.equal(api.getProfitRate({ price: 5, cost_price: 0 }), null);
});

test("duplicate goods across pages are skipped", () => {
  const raw = [];
  const seen = new Set();
  assert.equal(api.mergeUniqueItems(raw, seen, [{ id: 1 }, { id: 2 }]), 0);
  assert.equal(api.mergeUniqueItems(raw, seen, [{ id: 2 }, { id: 3 }, { name: "no id" }, { name: "no id" }]), 1);
  assert.equal(raw.length, 5);
});

test("stock filter: unknown stock counts as in stock, never as sold out", () => {
  const items = [{ id: 1, stock_count: 5 }, { id: 2, stock_count: 0 }, { id: 3 }];
  assert.deepEqual(ids(api.filterItems(items, { stockMode: "in" })), [1, 3]);
  assert.deepEqual(ids(api.filterItems(items, { stockMode: "out" })), [2]);
});

test("filters combine keyword, cost range and connection state", () => {
  const items = [
    { id: 1, name: "GPT Plus", cost_price: 5, child: null },
    { id: 2, name: "gpt team", cost_price: 50, child: { link: "/shop/x" } },
    { id: 3, name: "Steam", cost_price: 8, child: null }
  ];
  assert.deepEqual(ids(api.filterItems(items, { keyword: "GPT", maxCost: 10 })), [1]);
  assert.deepEqual(ids(api.filterItems(items, { connected: "linked" })), [2]);
});

test("sorting keeps missing values last in both directions", () => {
  const items = [{ id: 1, price: 3, cost_price: 2 }, { id: 2 }, { id: 3, price: 10, cost_price: 4 }];
  assert.deepEqual(ids(api.sortItems(items, "profitDesc")), [3, 1, 2]);
  assert.deepEqual(ids(api.sortItems(items, "profitAsc")), [1, 3, 2]);
  assert.deepEqual(ids(api.sortItems(items, "default")), [1, 2, 3]);
});

test("CSV export escapes text and guards against formulas", () => {
  const csv = api.toCsv([{ id: 7, name: '=HYPERLINK("x")', price: 2, cost_price: 1.5, user: { nickname: "店, 铺" } }]);
  assert.ok(csv.startsWith("﻿ID,商品,店铺"));
  const row = csv.split("\r\n")[1];
  assert.ok(row.startsWith(`7,"'=HYPERLINK(""x"")","店, 铺"`));
  assert.ok(row.includes(",2,1.5,0.5,33.3,"));
});

test("retry rules", () => {
  const limited = new Error("请求过于频繁，请稍后再试");
  const loggedOut = Object.assign(new Error("no token"), { retryable: false });
  const aborted = Object.assign(new Error("stop"), { name: "AbortError" });
  assert.equal(api.isRetryableError(limited), true);
  assert.equal(api.isRetryableError(new TypeError("Failed to fetch")), true);
  assert.equal(api.isRetryableError(Object.assign(new Error("HTTP 503"), { retryable: true })), true);
  assert.equal(api.isRetryableError(loggedOut), false);
  assert.equal(api.isRetryableError(aborted), false);
  assert.equal(api.isRetryableError(new Error("商品不存在")), false);
  assert.equal(api.getRetryDelayMs(1, 1000), 2000);
  assert.equal(api.getRetryDelayMs(3, 1000), 8000);
  assert.equal(api.getRetryDelayMs(3, 20000), 60000);
});

test("CDN rate limit (HTTP 403 + X-Tengine-Error) is retried with a long wait", () => {
  const limited = api.describeHttpError(403, "denied by http_ratelimit");
  assert.equal(limited.rateLimited, true);
  assert.equal(limited.retryable, true);
  assert.equal(api.describeHttpError(429).rateLimited, true);

  const forbidden = api.describeHttpError(403, null);
  assert.equal(forbidden.retryable, false);
  assert.match(forbidden.message, /登录/);
  assert.equal(api.describeHttpError(502).retryable, true);

  assert.equal(api.getRetryDelayMs(1, 1000, true), 15000);
  assert.equal(api.getRetryDelayMs(2, 1000, true), 30000);
  assert.equal(api.getRetryDelayMs(3, 1000, true), 60000);
});

test("interval slows down after a rate limit, capped at 10 seconds", () => {
  assert.equal(api.getSlowerIntervalMs(1000), 2000);
  assert.equal(api.getSlowerIntervalMs(4000), 8000);
  assert.equal(api.getSlowerIntervalMs(8000), 10000);
});

test("goods image comes from the first <img> in the description", () => {
  const item = {
    description: '<p>说明</p><p><img src="https://qn.ldxp.cn/f9/a.png" alt="image.png"/></p><img src="https://qn.ldxp.cn/b.png">',
    user: { avatar: "https://qn.ldxp.cn/94/avatar.png" }
  };
  assert.equal(api.getImage(item), "https://qn.ldxp.cn/f9/a.png");
  assert.equal(api.getImage({ description: "<img alt='x' src='//qn.ldxp.cn/c.png?a=1&amp;b=2'>" }), "https://qn.ldxp.cn/c.png?a=1&b=2");
  assert.equal(api.getImage({ description: '<img src="/uploads/d.webp">' }), "https://www.ldxp.cn/uploads/d.webp");
});

test("goods image falls back to a direct field, then the merchant avatar", () => {
  assert.equal(api.getImage({ image: "https://a.cn/1.png", description: '<img src="https://a.cn/2.png">' }), "https://a.cn/1.png");
  assert.equal(api.getImage({ description: "<p>无图</p>", user: { avatar: "https://qn.ldxp.cn/94/avatar.png" } }), "https://qn.ldxp.cn/94/avatar.png");
});

test("goods without a usable image stay empty", () => {
  assert.equal(api.getImage({ name: "abc", description: "<p>纯文字</p>", user: { avatar: "" } }), "");
  assert.equal(api.getImage({ description: '<img src="javascript:alert(1)">' }), "");
  assert.equal(api.getImage(null), "");
});
