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
// Objects built inside the vm context have another Object.prototype; compare their data only.
const plain = (value) => JSON.parse(JSON.stringify(value));

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

test("new filters: sale price, sales, stock, profit rate and exclude words", () => {
  const goods = [
    { id: 1, name: "ChatGPT 月卡", price: 20, cost_price: 10, sale_num: 500, stock_count: 9 },
    { id: 2, name: "Netflix 年卡", price: 60, cost_price: 50, sale_num: 30, stock_count: 2 },
    { id: 3, name: "网盘会员", price: 12, cost_price: 10, sale_num: 800 },
    { id: 4, name: "测试勿拍", price: 15, cost_price: 5, sale_num: 900, stock_count: 99 }
  ];
  assert.deepEqual(ids(api.filterItems(goods, { minPrice: 15, maxPrice: 30 })), [1, 4]);
  assert.deepEqual(ids(api.filterItems(goods, { minSales: 500 })), [1, 3, 4]);
  // Unknown stock (usually unlimited) passes a minimum-stock filter.
  assert.deepEqual(ids(api.filterItems(goods, { minStock: 5 })), [1, 3, 4]);
  assert.deepEqual(ids(api.filterItems(goods, { minProfitRate: 50 })), [1, 4]);
  assert.deepEqual(ids(api.filterItems(goods, { excludeKeyword: "测试, netflix" })), [1, 3]);
});

test("hidden goods are filtered out unless asked for; favourites can be isolated", () => {
  const goods = [{ id: 1, name: "a" }, { id: 2, name: "b" }, { id: 3, name: "c" }];
  const context = { favorites: new Set(["2"]), hidden: new Set(["3"]) };
  assert.deepEqual(ids(api.filterItems(goods, { markMode: "all" }, context)), [1, 2]);
  assert.deepEqual(ids(api.filterItems(goods, { markMode: "favorite" }, context)), [2]);
  assert.deepEqual(ids(api.filterItems(goods, { markMode: "hidden" }, context)), [3]);
});

test("tokenizer: latin words plus Chinese pairs", () => {
  assert.deepEqual(Array.from(api.tokenize("ChatGPT Plus 会员月卡")).sort(), ["chatgpt", "plus", "会员", "员月", "月卡"].sort());
});

test("same item: same latin words and similar wording group together; cheapest is rank 1", () => {
  const goods = [
    { id: 1, name: "国外真人人头代做Claude KYC，量大价可谈", cost_price: 120 },
    { id: 2, name: "国外真人人头代做Claude KYC，量大价可谈，美区", cost_price: 165 },
    { id: 3, name: "claude 普号已过 kyc【美国】gmail 邮箱", cost_price: 165 },
    { id: 4, name: "claude普通账号 谷歌邮箱gmail 已过kyc认证", cost_price: 149 },
    { id: 5, name: "【美区IOS】CLAUDE Pro 官方充值（月卡）", cost_price: 145 },
    { id: 6, name: "Steam 充值", cost_price: 10 }
  ];
  const groups = api.groupSameItems(goods);
  assert.equal(groups.get(goods[0]).key, groups.get(goods[1]).key);
  assert.equal(groups.get(goods[0]).premium, 0);
  assert.equal(groups.get(goods[1]).premium, 45);
  assert.equal(groups.get(goods[1]).rank, 2);
  // Different latin words ("ios", "pro") or unrelated wording never join a group.
  assert.equal(groups.get(goods[4]), undefined);
  assert.equal(groups.get(goods[5]), undefined);
  assert.notEqual(groups.get(goods[0]).key, groups.get(goods[2])?.key);

  assert.deepEqual(ids(api.filterItems(goods.slice(0, 2), { sameMode: "cheapest" }, { groups })), [1]);
  assert.deepEqual(ids(api.filterItems(goods, { sameGroup: groups.get(goods[0]).key }, { groups })), [1, 2]);
  assert.deepEqual(ids(api.sortItems(goods.slice(0, 2).reverse(), "sameAsc", groups)), [1, 2]);
});

test("product links: API link first, then a pattern learned from the batch, then the shop", () => {
  const goods = [
    { id: 1, goods_key: "AbCd1234", link: "https://pay.ldxp.cn/item/AbCd1234" },
    { id: 2, goods_key: "XyZw5678", link: "" },
    { id: 3, link: "", user: { link: "https://pay.ldxp.cn/shop/SHOPKEY1" } },
    { id: 4 }
  ];
  const template = api.learnLinkTemplate(goods);
  assert.equal(template.field, "goods_key");
  assert.deepEqual(plain(api.resolveProductLink(goods[0], template)), { url: "https://pay.ldxp.cn/item/AbCd1234", kind: "item" });
  assert.deepEqual(plain(api.resolveProductLink(goods[1], template)), { url: "https://pay.ldxp.cn/item/XyZw5678", kind: "built" });
  assert.deepEqual(plain(api.resolveProductLink(goods[2], template)), { url: "https://wzyp.cn/shop/SHOPKEY1", kind: "shop" });
  assert.deepEqual(plain(api.resolveProductLink(goods[3], template)), { url: "", kind: "" });
  // Without any linked goods in the batch there is nothing to learn from.
  assert.equal(api.learnLinkTemplate([goods[1]]), null);
});
