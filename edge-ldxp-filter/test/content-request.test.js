const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadContentExports(pathname, search = "", hostname = "www.ldxp.cn") {
  const source = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  let exported = null;
  const context = {
    URL,
    URLSearchParams,
    document: {
      getElementById: () => null,
      querySelectorAll: () => []
    },
    location: {
      hostname,
      pathname,
      search,
      origin: `https://${hostname}`
    },
    __LDXP_EDGE_FILTER_TEST_EXPORTS__: (api) => {
      exported = api;
    }
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: path.join(ROOT, "content.js") });
  return exported;
}

test("apply and parent goods pages default to parent source mode", () => {
  assert.equal(loadContentExports("/merchant/my_parent/apply").getDefaultSourceMode(), "parent");
  assert.equal(loadContentExports("/merchant/my_parent/parent_goods", "?agent_key=abc").getDefaultSourceMode(), "parent");
  assert.equal(loadContentExports("/merchant/my_parent/source_square").getDefaultSourceMode(), "open");
});

test("open source request keeps searchGoodsList parameters", () => {
  const api = loadContentExports("/merchant/my_parent/source_square");
  const filters = { sourceMode: "open", keyword: "GPT会员", goodsType: "card" };

  assert.equal(api.getFetchApiUrl(filters), "/merchantApi/MyParent/searchGoodsList");
  assert.equal(api.getFetchPageSize(filters), 50);
  assert.deepEqual(plain(api.buildRequestBody(2, filters)), {
    current: 2,
    pageSize: 50,
    name: "",
    goods_type: "card",
    keywords: "GPT会员"
  });
});

test("parent source request uses agent_key and parentGoodsList parameters", () => {
  const api = loadContentExports("/merchant/my_parent/apply");
  const filters = { sourceMode: "parent", agentKey: "private-shop", keyword: "GPT会员", goodsType: "rights" };

  assert.equal(api.getFetchApiUrl(filters), "/merchantApi/MyParent/parentGoodsList");
  assert.equal(api.getFetchPageSize(filters), 20);
  assert.deepEqual(plain(api.buildRequestBody(3, filters)), {
    agent_key: "private-shop",
    current: 3,
    pageSize: 20,
    name: "GPT会员",
    goods_type: "rights",
    category_id: 0
  });
});

test("request interval is clamped before scanning pages", () => {
  const api = loadContentExports("/merchant/my_parent/source_square");

  assert.equal(api.DEFAULT_REQUEST_INTERVAL_SECONDS, 1);
  assert.equal(api.MIN_REQUEST_INTERVAL_SECONDS, 0.2);
  assert.equal(api.clampRequestIntervalSeconds(""), 1);
  assert.equal(api.clampRequestIntervalSeconds("0"), 0.2);
  assert.equal(api.clampRequestIntervalSeconds("300"), 120);
  assert.equal(api.getRequestDelayMs({ requestIntervalSeconds: "8" }), 8000);
});

test("shop links are normalized to current wzyp domain", () => {
  const api = loadContentExports("/merchant/my_parent/source_square");

  assert.equal(api.normalizeProductLink("https://pay.ldxp.cn/shop/ldxp"), "https://wzyp.cn/shop/ldxp");
  assert.equal(api.normalizeProductLink("/shop/ldxp"), "https://wzyp.cn/shop/ldxp");
  assert.equal(api.normalizeProductLink("https://wzyp.cn/shop/ldxp?sku=1"), "https://wzyp.cn/shop/ldxp?sku=1");
});
