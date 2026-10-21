(() => {
  "use strict";

  const ROOT_ID = "ldxp-edge-filter-root";
  const OPEN_GOODS_API_URL = "/merchantApi/MyParent/searchGoodsList";
  const PARENT_GOODS_API_URL = "/merchantApi/MyParent/parentGoodsList";
  const MAX_FETCH_PAGES = 500;
  const DEFAULT_FETCH_SIZE = 50;
  const DEFAULT_PARENT_FETCH_SIZE = 20;
  const DEFAULT_REQUEST_INTERVAL_SECONDS = 1;
  const MIN_REQUEST_INTERVAL_SECONDS = 0.2;
  const MAX_REQUEST_INTERVAL_SECONDS = 120;
  const MAX_FETCH_RETRIES = 3;
  const MIN_RETRY_DELAY_MS = 2000;
  const MAX_RETRY_DELAY_MS = 60000;
  const SETTINGS_STORAGE_KEY = "ldxpEdgeFilterSettings";
  const SHOW_PANEL_MESSAGE = "ldxp-edge-filter:show";
  const RECOGNIZED_HOSTS = new Set(["pay.ldxp.cn", "www.ldxp.cn", "wzyp.cn"]);
  const LEGACY_SHOP_HOSTS = new Set(["pay.ldxp.cn", "www.ldxp.cn"]);
  const CURRENT_SHOP_HOST = "wzyp.cn";
  const MINI_WIDTH = 62;
  const MINI_HEIGHT = 62;
  const VIEWPORT_GAP = 8;
  const AUTO_MINI_RIGHT = 16;
  const AUTO_MINI_TOP = 96;
  const TABLE_COLUMN_COUNT = 13;

  if (document.getElementById(ROOT_ID)) {
    return;
  }

  if (!RECOGNIZED_HOSTS.has(location.hostname)) {
    return;
  }

  const state = {
    raw: [],
    seenIds: new Set(),
    duplicates: 0,
    layout: {},
    filtered: [],
    currentPage: 1,
    pageSize: 10,
    loading: false,
    abortController: null,
    lastSummary: "",
    connect: {
      visible: false,
      item: null,
      categories: [],
      loading: false,
      submitting: false,
      error: "",
      form: null
    },
    detail: {
      visible: false,
      item: null
    }
  };

  const asText = (value) => (value === undefined || value === null ? "" : String(value));

  const normalizeSearchText = (value) => asText(value).trim().toLocaleLowerCase();

  const asNumber = (value, fallback = null) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    const match = asText(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : fallback;
  };

  const money = (value) => {
    const num = asNumber(value, NaN);
    if (!Number.isFinite(num)) {
      return "-";
    }
    return num.toFixed(2).replace(/\.00$/, "");
  };

  const escapeHtml = (value) =>
    asText(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const normalizeToken = (raw) => {
    if (!raw) {
      return "";
    }
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") {
        return parsed;
      }
      return parsed.value || parsed.token || parsed.access_token || parsed.accessToken || raw;
    } catch (_) {
      return raw;
    }
  };

  const getToken = () => {
    const keys = ["auth-token", "Merchant-Token", "merchant-token", "token", "Authorization"];
    for (const key of keys) {
      const value = localStorage.getItem(key);
      if (value) {
        return normalizeToken(value);
      }
    }
    return "";
  };

  const getProductId = (item) => item.id ?? item.goods_key ?? "";
  const getProductTitle = (item) => item.name || item.title || "";
  const getMerchant = (item) => item.user?.nickname || item.nickname || item.shop_name || item.merchant_name || item.user?.name || "";
  const getCategory = (item) => item.category?.name || item.category_name || "";
  const getCategorySearchText = getCategory;
  const getMerchantSearchText = getMerchant;

  const getItemSearchText = (item) =>
    [
      getProductTitle(item),
      getMerchantSearchText(item),
      getCategorySearchText(item),
      getProductId(item)
    ].join(" ");

  const getImage = (item) =>
    item.image || item.cover || item.thumb || "";

  const getStock = (item) => asNumber(item.stock_count, null);

  const getSales = (item) =>
    asNumber(item.sale_num ?? item.sales, null);

  const getSalePrice = (item) =>
    asNumber(item.price, null);

  const getCostPrice = (item) => {
    const direct = asNumber(item.cost_price, null);
    if (direct !== null && direct >= 0) {
      return direct;
    }

    const limited = asNumber(item.agent_price_limit, null);
    if (limited !== null && limited >= 0) {
      return limited;
    }

    const levels = ["agent_price1", "agent_price2", "agent_price3"]
      .map((key) => asNumber(item[key], NaN))
      .filter((num) => Number.isFinite(num) && num >= 0);
    return levels.length ? Math.min(...levels) : null;
  };

  const getStatusLabel = (item) => {
    const numeric = asNumber(item.status, null);
    if (Number.isFinite(numeric)) {
      if (numeric === 1) {
        return "正常";
      }
      if (numeric === 0) {
        return "未上架";
      }
    }
    return "-";
  };

  const getStatusKind = (item) => {
    const numeric = asNumber(item.status, null);
    if (Number.isFinite(numeric)) {
      return numeric === 1 ? "normal" : "off";
    }
    return "unknown";
  };

  const getConnectedKind = (item) => {
    return item.child ? "linked" : "unlinked";
  };

  const getConnectedLabel = (item) => (getConnectedKind(item) === "linked" ? "已对接" : "未对接");
  const getConnectActionLabel = (item) => (getConnectedKind(item) === "linked" ? "查看" : "对接");

  const normalizeProductLink = (url) => {
    const text = asText(url).trim();
    if (!text) {
      return "";
    }
    try {
      const parsed = new URL(text, location.origin);
      if (parsed.pathname.startsWith("/shop/") && LEGACY_SHOP_HOSTS.has(parsed.hostname)) {
        parsed.protocol = "https:";
        parsed.hostname = CURRENT_SHOP_HOST;
      }
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
    } catch (_) {
      return "";
    }
  };

  const getConnectedLink = (item) => normalizeProductLink(item.child?.link);

  const getDetailLink = (item) => normalizeProductLink(item?.link);

  const includesText = (source, query) => {
    if (!query) {
      return true;
    }
    return normalizeSearchText(source).includes(normalizeSearchText(query));
  };

  const getQueryAgentKey = () => {
    try {
      const params = new URLSearchParams(location.search);
      return asText(params.get("agent_key") || params.get("agentKey")).trim();
    } catch (_) {
      return "";
    }
  };

  const readPageAgentKey = () => {
    const queryAgentKey = getQueryAgentKey();
    if (queryAgentKey) {
      return queryAgentKey;
    }

    const inputs = Array.from(document.querySelectorAll("input"));
    const matched = inputs.find((input) => {
      const placeholder = asText(input.getAttribute("placeholder"));
      return /agent[_-]?key|对接码|貨源商|货源商/i.test(placeholder) && asText(input.value).trim();
    });
    return matched ? asText(matched.value).trim() : "";
  };

  const getDefaultSourceMode = () => {
    const pathname = location.pathname.toLowerCase();
    return pathname.includes("/merchant/my_parent/apply") || pathname.includes("/merchant/my_parent/parent_goods")
      ? "parent"
      : "open";
  };

  const getFetchPageSize = (filters) =>
    filters.sourceMode === "parent" ? DEFAULT_PARENT_FETCH_SIZE : DEFAULT_FETCH_SIZE;

  const getFetchApiUrl = (filters) =>
    filters.sourceMode === "parent" ? PARENT_GOODS_API_URL : OPEN_GOODS_API_URL;

  const clampRequestIntervalSeconds = (value) =>
    Math.min(
      Math.max(asNumber(value, DEFAULT_REQUEST_INTERVAL_SECONDS), MIN_REQUEST_INTERVAL_SECONDS),
      MAX_REQUEST_INTERVAL_SECONDS
    );

  const getRequestDelayMs = (filters) =>
    Math.round(clampRequestIntervalSeconds(filters.requestIntervalSeconds) * 1000);

  const sleep = (ms, signal) => {
    if (!ms) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const error = new Error("已停止拉取");
        error.name = "AbortError";
        reject(error);
        return;
      }

      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        const error = new Error("已停止拉取");
        error.name = "AbortError";
        reject(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const buildRequestBody = (page, filters) => {
    if (filters.sourceMode === "parent") {
      return {
        agent_key: filters.agentKey,
        current: page,
        pageSize: getFetchPageSize(filters),
        name: filters.keyword || "",
        goods_type: filters.goodsType,
        category_id: 0
      };
    }

    return {
      current: page,
      pageSize: getFetchPageSize(filters),
      name: "",
      goods_type: filters.goodsType,
      keywords: filters.keyword
    };
  };

  // Prices are rounded up to whole cents. The epsilon step keeps float noise
  // (1.1 * 100 = 110.00000000000001) from being rounded up an extra cent.
  const roundPrice = (value) => {
    const cents = Number((Math.max(0, asNumber(value, 0)) * 100).toFixed(6));
    return Math.ceil(cents) / 100;
  };

  const getMinimumSalePrice = (item) => {
    const minPrice = asNumber(item.agent_price_limit, null);
    return minPrice !== null && minPrice > 0 ? minPrice : null;
  };

  const calculateConnectPrice = (form, item) => {
    const cost = getCostPrice(item) ?? 0;
    const minPrice = getMinimumSalePrice(item);
    let calculated = cost;

    if (form.add_type === 1) {
      calculated = cost * (1 + Math.max(0, asNumber(form.add_rate, 0)) / 100);
    } else if (form.add_type === 2) {
      calculated = cost + Math.max(0, asNumber(form.add_price, 0));
    }

    const rawPrice = roundPrice(calculated);
    const raised = minPrice !== null && rawPrice < minPrice;
    return {
      price: raised ? roundPrice(minPrice) : rawPrice,
      rawPrice,
      minPrice,
      raised
    };
  };

  const normalizeConnectForm = (form, item) => {
    const next = {
      ...form,
      add_type: asNumber(form.add_type, 1),
      add_rate: Math.max(0, asNumber(form.add_rate, 0)),
      add_price: Math.max(0, asNumber(form.add_price, 0))
    };
    next.price = calculateConnectPrice(next, item).price;
    return next;
  };

  // 差价 = 售价 - 成本价；利润率按成本价计算。
  const getProfit = (item) => {
    const price = getSalePrice(item);
    const cost = getCostPrice(item);
    if (price === null || cost === null) {
      return null;
    }
    return Math.round((price - cost) * 100) / 100;
  };

  const getProfitRate = (item) => {
    const profit = getProfit(item);
    const cost = getCostPrice(item);
    if (profit === null || !cost) {
      return null;
    }
    return Math.round((profit / cost) * 1000) / 10;
  };

  const percent = (value) => (value === null ? "-" : `${value.toFixed(1).replace(/\.0$/, "")}%`);

  // Appends items whose id has not been seen yet. Items without an id are always kept.
  const mergeUniqueItems = (target, seenIds, list) => {
    let duplicates = 0;
    for (const item of list) {
      const id = asText(getProductId(item));
      if (id) {
        if (seenIds.has(id)) {
          duplicates += 1;
          continue;
        }
        seenIds.add(id);
      }
      target.push(item);
    }
    return duplicates;
  };

  const SORT_FIELDS = {
    price: getSalePrice,
    cost: getCostPrice,
    profit: getProfit,
    profitRate: getProfitRate,
    stock: getStock,
    sales: getSales
  };

  const parseSort = (value) => {
    const match = /^(\w+?)(Asc|Desc)$/.exec(asText(value));
    if (!match || !SORT_FIELDS[match[1]]) {
      return null;
    }
    return { field: match[1], dir: match[2] === "Asc" ? "asc" : "desc" };
  };

  // Stable sort; items missing the sorted value always go last.
  const sortItems = (items, sortValue) => {
    const sort = parseSort(sortValue);
    if (!sort) {
      return items;
    }
    const getValue = SORT_FIELDS[sort.field];
    const sign = sort.dir === "asc" ? 1 : -1;
    return items
      .map((item) => ({ item, value: getValue(item) }))
      .sort((a, b) => {
        if (a.value === null || b.value === null) {
          return (a.value === null) - (b.value === null);
        }
        return (a.value - b.value) * sign;
      })
      .map((entry) => entry.item);
  };

  const filterItems = (items, filters) => {
    let data = items.slice();

    if (filters.keyword) {
      data = data.filter((item) => includesText(getItemSearchText(item), filters.keyword));
    }

    if (Number.isFinite(filters.minCost)) {
      data = data.filter((item) => {
        const cost = getCostPrice(item);
        return cost !== null && cost >= filters.minCost;
      });
    }

    if (Number.isFinite(filters.maxCost)) {
      data = data.filter((item) => {
        const cost = getCostPrice(item);
        return cost !== null && cost <= filters.maxCost;
      });
    }

    // Goods without a stock count (usually unlimited) count as in stock, never as sold out.
    if (filters.stockMode === "in") {
      data = data.filter((item) => {
        const stock = getStock(item);
        return stock === null || stock > 0;
      });
    } else if (filters.stockMode === "out") {
      data = data.filter((item) => {
        const stock = getStock(item);
        return stock !== null && stock <= 0;
      });
    }

    if (filters.statusMode && filters.statusMode !== "all") {
      data = data.filter((item) => {
        const kind = getStatusKind(item);
        return kind === "unknown" || kind === filters.statusMode;
      });
    }

    if (filters.connected && filters.connected !== "all") {
      data = data.filter((item) => getConnectedKind(item) === filters.connected);
    }

    if (filters.categoryKeyword) {
      data = data.filter((item) => includesText(getCategorySearchText(item), filters.categoryKeyword));
    }

    if (filters.merchantKeyword) {
      data = data.filter((item) => includesText(getMerchantSearchText(item), filters.merchantKeyword));
    }

    return sortItems(data, filters.sort);
  };

  const csvCell = (value, isText = true) => {
    let text = asText(value);
    // Keep spreadsheet apps from running cell text as a formula.
    if (isText && /^[=+\-@\t\r]/.test(text)) {
      text = `'${text}`;
    }
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const CSV_COLUMNS = [
    ["ID", (item) => getProductId(item), true],
    ["商品", (item) => getProductTitle(item), true],
    ["店铺", (item) => getMerchant(item), true],
    ["分类", (item) => getCategory(item), true],
    ["售价", (item) => getSalePrice(item) ?? "", false],
    ["成本价", (item) => getCostPrice(item) ?? "", false],
    ["差价", (item) => getProfit(item) ?? "", false],
    ["利润率%", (item) => getProfitRate(item) ?? "", false],
    ["库存", (item) => getStock(item) ?? "", false],
    ["销量", (item) => getSales(item) ?? "", false],
    ["状态", (item) => getStatusLabel(item), true],
    ["关联", (item) => getConnectedLabel(item), true],
    ["链接", (item) => getDetailLink(item), true]
  ];

  // UTF-8 BOM so Excel opens the Chinese text correctly.
  const toCsv = (items) =>
    "﻿" +
    [CSV_COLUMNS.map(([title]) => csvCell(title)).join(",")]
      .concat(items.map((item) => CSV_COLUMNS.map(([, read, isText]) => csvCell(read(item), isText)).join(",")))
      .join("\r\n");

  const RETRYABLE_MESSAGE = /频繁|稍后|限流|繁忙|超时|too many|busy|timeout/i;

  const isRetryableError = (error) => {
    if (!error || error.name === "AbortError" || error.retryable === false) {
      return false;
    }
    if (error.retryable === true || error.name === "TypeError") {
      return true;
    }
    return RETRYABLE_MESSAGE.test(asText(error.message));
  };

  const getRetryDelayMs = (attempt, requestDelayMs) =>
    Math.min(Math.max(requestDelayMs, MIN_RETRY_DELAY_MS) * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);

  if (globalThis.__LDXP_EDGE_FILTER_TEST_EXPORTS__) {
    globalThis.__LDXP_EDGE_FILTER_TEST_EXPORTS__({
      OPEN_GOODS_API_URL,
      PARENT_GOODS_API_URL,
      DEFAULT_FETCH_SIZE,
      DEFAULT_PARENT_FETCH_SIZE,
      DEFAULT_REQUEST_INTERVAL_SECONDS,
      MIN_REQUEST_INTERVAL_SECONDS,
      MAX_REQUEST_INTERVAL_SECONDS,
      MAX_FETCH_RETRIES,
      getDefaultSourceMode,
      getFetchApiUrl,
      getFetchPageSize,
      clampRequestIntervalSeconds,
      getRequestDelayMs,
      normalizeProductLink,
      buildRequestBody,
      roundPrice,
      calculateConnectPrice,
      getProfit,
      getProfitRate,
      mergeUniqueItems,
      sortItems,
      filterItems,
      toCsv,
      isRetryableError,
      getRetryDelayMs
    });
    return;
  }

  const root = document.createElement("section");
  const iconUrl = chrome.runtime.getURL("assets/icon-48.png");
  const defaultSourceMode = getDefaultSourceMode();
  const defaultAgentKey = readPageAgentKey();
  root.id = ROOT_ID;
  root.innerHTML = `
    <button class="ldxp-mini-launcher" data-action="expand" title="展开货源增强筛选">
      <img class="ldxp-mini-icon" src="${iconUrl}" alt="">
    </button>
    <div class="ldxp-panel">
      <div class="ldxp-titlebar">
        <div>
          <div class="ldxp-title">
            <span class="ldxp-title-mark">筛</span>
            <span>货源增强筛选</span>
            <span class="ldxp-title-badge">轻甜版</span>
          </div>
          <div class="ldxp-subtitle">拉取接口数据后在本页筛选，不修改原站数据</div>
        </div>
        <div class="ldxp-title-actions">
          <button class="ldxp-icon-btn" data-action="collapse" title="最小化">-</button>
          <button class="ldxp-icon-btn" data-action="close" title="关闭">x</button>
        </div>
      </div>

      <div class="ldxp-body">
        <div class="ldxp-controls">
          <label>
            <span>数据来源</span>
            <select data-field="sourceMode">
              <option value="open" ${defaultSourceMode === "open" ? "selected" : ""}>开放货源搜索</option>
              <option value="parent" ${defaultSourceMode === "parent" ? "selected" : ""}>指定货源商</option>
            </select>
          </label>
          <label>
            <span>货源对接码</span>
            <input data-field="agentKey" value="${escapeHtml(defaultAgentKey)}" placeholder="对接码 / agent_key">
          </label>
          <label>
            <span>关键词</span>
            <input data-field="keyword" type="search" placeholder="商品名 / 店铺 / 分类">
          </label>
          <label>
            <span>商品类型</span>
            <select data-field="goodsType">
              <option value="">全部</option>
              <option value="card">卡密</option>
              <option value="knowledge">知识</option>
              <option value="resource">资源</option>
              <option value="rights">权益</option>
            </select>
          </label>
          <label>
            <span>拉取页数</span>
            <input data-field="pages" type="number" min="1" max="${MAX_FETCH_PAGES}" value="5">
          </label>
          <label>
            <span>请求间隔(秒)</span>
            <input data-field="requestIntervalSeconds" type="number" min="${MIN_REQUEST_INTERVAL_SECONDS}" max="${MAX_REQUEST_INTERVAL_SECONDS}" step="0.1" value="${DEFAULT_REQUEST_INTERVAL_SECONDS}">
          </label>
          <label>
            <span>成本价最低</span>
            <input data-field="minCost" type="number" min="0" step="0.01" placeholder="不限">
          </label>
          <label>
            <span>成本价最高</span>
            <input data-field="maxCost" type="number" min="0" step="0.01" placeholder="不限">
          </label>
          <label>
            <span>库存</span>
            <select data-field="stockMode">
              <option value="all">全部</option>
              <option value="in">仅有库存</option>
              <option value="out">仅无库存</option>
            </select>
          </label>
          <label>
            <span>状态</span>
            <select data-field="statusMode">
              <option value="all">全部</option>
              <option value="normal">正常</option>
              <option value="off">未上架</option>
            </select>
          </label>
          <label>
            <span>关联状态</span>
            <select data-field="connected">
              <option value="all">全部</option>
              <option value="linked">已对接</option>
              <option value="unlinked">未对接</option>
            </select>
          </label>
          <label>
            <span>分类关键词</span>
            <input data-field="categoryKeyword" type="search" placeholder="分类包含">
          </label>
          <label>
            <span>商家名称</span>
            <input data-field="merchantKeyword" type="search" placeholder="商家包含">
          </label>
          <label>
            <span>排序</span>
            <select data-field="sort">
              <option value="default">默认</option>
              <option value="costAsc">成本价升序</option>
              <option value="costDesc">成本价降序</option>
              <option value="priceAsc">售价升序</option>
              <option value="priceDesc">售价降序</option>
              <option value="profitDesc">差价降序</option>
              <option value="profitAsc">差价升序</option>
              <option value="profitRateDesc">利润率降序</option>
              <option value="profitRateAsc">利润率升序</option>
              <option value="stockAsc">库存升序</option>
              <option value="stockDesc">库存降序</option>
              <option value="salesDesc">销量降序</option>
              <option value="salesAsc">销量升序</option>
            </select>
          </label>
          <label>
            <span>每页显示</span>
            <select data-field="pageSize">
              <option value="5">5</option>
              <option value="10" selected>10</option>
              <option value="15">15</option>
              <option value="20">20</option>
              <option value="25">25</option>
              <option value="30">30</option>
            </select>
          </label>
        </div>

        <div class="ldxp-actions">
          <button class="ldxp-primary" data-action="fetch">开始拉取</button>
          <button data-action="apply">筛选当前数据</button>
          <button data-action="reset">重置</button>
          <button data-action="export" title="把筛选后的全部结果导出为 CSV，可用 Excel 打开">导出 CSV</button>
          <span class="ldxp-status" data-role="status">等待操作</span>
        </div>

        <div class="ldxp-resultbar">
          <span data-role="summary">暂无数据</span>
          <div class="ldxp-pager">
            <button data-action="first">首页</button>
            <button data-action="prev">上一页</button>
            <input data-field="pageJump" type="number" min="1" value="1" title="页码">
            <button data-action="jump">跳转</button>
            <span data-role="pageInfo">/ 1</span>
            <button data-action="next">下一页</button>
            <button data-action="last">末页</button>
          </div>
        </div>

        <div class="ldxp-table-wrap">
          <table>
            <thead>
              <tr>
                <th class="ldxp-col-image">图片</th>
                <th class="ldxp-col-name">商品</th>
                <th class="ldxp-col-shop">店铺</th>
                <th class="ldxp-col-category">分类</th>
                <th class="ldxp-col-money ldxp-sortable" data-sort-field="price" title="点击按售价排序">售价</th>
                <th class="ldxp-col-money ldxp-sortable" data-sort-field="cost" title="点击按成本价排序">成本价</th>
                <th class="ldxp-col-money ldxp-sortable" data-sort-field="profit" title="售价 - 成本价，点击排序">差价</th>
                <th class="ldxp-col-money ldxp-sortable" data-sort-field="profitRate" title="差价 / 成本价，点击排序">利润率</th>
                <th class="ldxp-col-number ldxp-sortable" data-sort-field="stock" title="点击按库存排序">库存</th>
                <th class="ldxp-col-number ldxp-sortable" data-sort-field="sales" title="点击按销量排序">销量</th>
                <th class="ldxp-col-badge">状态</th>
                <th class="ldxp-col-badge">关联</th>
                <th class="ldxp-col-badge">详情</th>
              </tr>
            </thead>
            <tbody data-role="rows">
              <tr><td colspan="${TABLE_COLUMN_COUNT}" class="ldxp-empty">暂无结果</td></tr>
            </tbody>
          </table>
        </div>

      </div>
      <div class="ldxp-author-note">
        <span>角落小纸条：觉得好用的话，下次来哇咔咔这里补一单小小感谢；挑最便宜的也完全 OK，主要是让哇咔咔开心一下。</span>
        <a href="https://wzyp.cn/shop/V2YZIFWM" target="_blank" rel="noopener noreferrer">作者卡网</a>
      </div>
      <div class="ldxp-resize-handle" title="拖动调整面板大小"></div>
    </div>
    <div class="ldxp-connect-modal" data-role="connectModal" hidden></div>
    <div class="ldxp-detail-modal" data-role="detailModal" hidden></div>
  `;
  document.body.appendChild(root);

  const $ = (selector) => root.querySelector(selector);
  const panelEl = $(".ldxp-panel");
  const bodyEl = $(".ldxp-body");
  const titlebarEl = $(".ldxp-titlebar");
  const resizeHandleEl = $(".ldxp-resize-handle");
  const rowsEl = $('[data-role="rows"]');
  const statusEl = $('[data-role="status"]');
  const summaryEl = $('[data-role="summary"]');
  const pageInfoEl = $('[data-role="pageInfo"]');
  const fetchButton = $('[data-action="fetch"]');
  const connectModalEl = $('[data-role="connectModal"]');
  const detailModalEl = $('[data-role="detailModal"]');

  const field = (name) => $(`[data-field="${name}"]`);

  const setStatus = (text, tone = "") => {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  };

  const readFilters = () => ({
    sourceMode: field("sourceMode").value,
    agentKey: field("agentKey").value.trim() || readPageAgentKey(),
    keyword: field("keyword").value.trim(),
    goodsType: field("goodsType").value,
    pages: Math.min(Math.max(asNumber(field("pages").value, 1), 1), MAX_FETCH_PAGES),
    requestIntervalSeconds: clampRequestIntervalSeconds(field("requestIntervalSeconds").value),
    minCost: asNumber(field("minCost").value, NaN),
    maxCost: asNumber(field("maxCost").value, NaN),
    stockMode: field("stockMode").value,
    statusMode: field("statusMode").value,
    connected: field("connected").value,
    categoryKeyword: field("categoryKeyword").value.trim(),
    merchantKeyword: field("merchantKeyword").value.trim(),
    sort: field("sort").value,
    pageSize: asNumber(field("pageSize").value, 10)
  });

  const normalizeList = (payload) => Array.isArray(payload?.data?.list) ? payload.data.list : [];

  const postMerchantApi = async (url, body, signal) => {
    const token = getToken();
    if (!token) {
      const error = new Error("没有在 localStorage 中找到 auth-token，请先登录链动小铺后台。");
      error.retryable = false;
      throw error;
    }

    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
        "Merchant-Token": token
      },
      body: JSON.stringify(body),
      signal
    });

    if (!response.ok) {
      const error = new Error(`接口请求失败：HTTP ${response.status}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }

    const payload = await response.json();
    if (payload.code !== 1) {
      throw new Error(payload.msg || payload.message || `接口返回异常：${payload.code}`);
    }

    return payload;
  };

  const fetchPage = async (page, filters, signal) => {
    if (filters.sourceMode === "parent" && !filters.agentKey) {
      const error = new Error("指定货源商模式需要填写货源对接码 / agent_key。");
      error.retryable = false;
      throw error;
    }
    const payload = await postMerchantApi(getFetchApiUrl(filters), buildRequestBody(page, filters), signal);
    return normalizeList(payload);
  };

  const getSummary = () => {
    if (!state.raw.length) {
      return "暂无数据";
    }
    const skipped = state.duplicates ? `（跳过 ${state.duplicates} 条重复）` : "";
    return `已拉取 ${state.raw.length} 条${skipped}，筛选后 ${state.filtered.length} 条`;
  };

  const applyFilters = ({ keepPage = false } = {}) => {
    const filters = readFilters();
    state.pageSize = filters.pageSize;
    state.filtered = filterItems(state.raw, filters);
    state.lastSummary = getSummary();
    if (!keepPage) {
      state.currentPage = 1;
    }
    render();
  };

  const render = () => {
    const total = state.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.currentPage > totalPages) {
      state.currentPage = totalPages;
    }

    const start = (state.currentPage - 1) * state.pageSize;
    const pageItems = state.filtered.slice(start, start + state.pageSize);

    summaryEl.textContent = state.lastSummary || getSummary();
    field("pageJump").max = String(totalPages);
    field("pageJump").value = String(state.currentPage);
    pageInfoEl.textContent = `/ ${totalPages}`;
    renderSortIndicators();

    if (!pageItems.length) {
      rowsEl.innerHTML = `<tr><td colspan="${TABLE_COLUMN_COUNT}" class="ldxp-empty">${state.loading ? "正在拉取..." : "暂无结果"}</td></tr>`;
      return;
    }

    rowsEl.innerHTML = pageItems
      .map((item) => {
        const image = getImage(item);
        const title = getProductTitle(item) || "-";
        const id = getProductId(item);
        const stock = getStock(item);
        const stockText = stock === null ? "未知" : String(stock);
        const salePrice = money(getSalePrice(item));
        const costPrice = money(getCostPrice(item));
        const statusLabel = getStatusLabel(item);
        const statusKind = getStatusKind(item);
        const connectedLabel = getConnectedLabel(item);
        const connectedKind = getConnectedKind(item);
        const connectActionLabel = getConnectActionLabel(item);
        const connectedLink = getConnectedLink(item);
        const detailLink = getDetailLink(item);
        const sales = getSales(item);
        const profit = getProfit(item);
        const profitRate = getProfitRate(item);
        const profitTone = profit === null ? "is-unknown" : profit > 0 ? "is-ok" : profit < 0 ? "is-empty" : "";
        return `
          <tr>
            <td class="ldxp-col-image">
              ${
                image
                  ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async">`
                  : `<span class="ldxp-no-image">无图</span>`
              }
            </td>
            <td>
              <div class="ldxp-name" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
              <div class="ldxp-meta">${id ? `ID: ${escapeHtml(id)}` : ""}</div>
            </td>
            <td>${escapeHtml(getMerchant(item) || "-")}</td>
            <td>${escapeHtml(getCategory(item) || "-")}</td>
            <td class="ldxp-money">${salePrice === "-" ? "-" : `¥${salePrice}`}</td>
            <td class="ldxp-money ldxp-strong">${costPrice === "-" ? "-" : `¥${costPrice}`}</td>
            <td><span class="ldxp-money ldxp-number ${profitTone}">${profit === null ? "-" : `${profit < 0 ? "-" : ""}¥${money(Math.abs(profit))}`}</span></td>
            <td><span class="ldxp-number ${profitTone}">${percent(profitRate)}</span></td>
            <td><span class="ldxp-number ${stock === null ? "is-unknown" : stock > 0 ? "is-ok" : "is-empty"}">${stockText}</span></td>
            <td><span class="ldxp-number ${sales === null ? "is-unknown" : ""}">${sales === null ? "-" : sales}</span></td>
            <td><span class="ldxp-badge ldxp-status-${escapeHtml(statusKind)}">${escapeHtml(statusLabel)}</span></td>
            <td>
              ${
                connectedKind === "linked" && connectedLink
                  ? `<a class="ldxp-connect-action ldxp-connect-${escapeHtml(connectedKind)}" href="${escapeHtml(connectedLink)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(`${connectedLabel}，打开已对接商品`)}">${escapeHtml(connectActionLabel)}</a>`
                  : connectedKind === "unlinked"
                    ? `<button class="ldxp-connect-action ldxp-connect-${escapeHtml(connectedKind)}" data-action="connect" data-id="${escapeHtml(id)}" title="打开对接配置">${escapeHtml(connectActionLabel)}</button>`
                    : `<span class="ldxp-badge ldxp-connect-${escapeHtml(connectedKind)}">${escapeHtml(connectedLabel)}</span>`
              }
            </td>
            <td>
              ${
                detailLink
                  ? `<button class="ldxp-connect-action" data-action="viewDetail" data-id="${escapeHtml(id)}" title="弹窗查看商品详情">详情</button>`
                  : `<span class="ldxp-badge">-</span>`
              }
            </td>
          </tr>
        `;
      })
      .join("");
  };

  const fetchPageWithRetry = async (page, filters, signal, requestDelayMs) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchPage(page, filters, signal);
      } catch (error) {
        if (attempt >= MAX_FETCH_RETRIES || !isRetryableError(error)) {
          throw error;
        }
        const delayMs = getRetryDelayMs(attempt + 1, requestDelayMs);
        setStatus(
          `第 ${page} 页失败（${error.message || "请求异常"}），${Math.round(delayMs / 1000)} 秒后第 ${attempt + 1} / ${MAX_FETCH_RETRIES} 次重试...`,
          "warn"
        );
        await sleep(delayMs, signal);
      }
    }
  };

  const startFetch = async () => {
    if (state.loading) {
      state.abortController?.abort();
      return;
    }

    const filters = readFilters();
    if (filters.sourceMode === "parent" && field("agentKey").value.trim() !== filters.agentKey) {
      field("agentKey").value = filters.agentKey;
    }
    field("requestIntervalSeconds").value = String(filters.requestIntervalSeconds);
    const fetchPageSize = getFetchPageSize(filters);
    const requestDelayMs = getRequestDelayMs(filters);
    state.loading = true;
    state.abortController = new AbortController();
    state.raw = [];
    state.seenIds = new Set();
    state.duplicates = 0;
    state.filtered = [];
    state.currentPage = 1;
    state.lastSummary = "";
    fetchButton.textContent = "停止拉取";
    setStatus("正在请求第 1 页...", "busy");
    render();

    let completedPages = 0;
    try {
      for (let page = 1; page <= filters.pages; page += 1) {
        if (page > 1 && requestDelayMs > 0) {
          setStatus(`已完成 ${completedPages} / ${filters.pages} 页，等待 ${filters.requestIntervalSeconds} 秒后请求第 ${page} 页...`, "busy");
          await sleep(requestDelayMs, state.abortController.signal);
        }
        setStatus(`正在请求第 ${page} / ${filters.pages} 页...`, "busy");
        const list = await fetchPageWithRetry(page, filters, state.abortController.signal, requestDelayMs);
        state.duplicates += mergeUniqueItems(state.raw, state.seenIds, list);
        completedPages = page;
        // Show results as pages arrive, without moving the reader off the page they are on.
        applyFilters({ keepPage: true });

        if (list.length < fetchPageSize) {
          break;
        }
      }

      setStatus(`拉取完成，共 ${completedPages} 页`, "ok");
    } catch (error) {
      const kept = state.raw.length ? `，已保留前 ${completedPages} 页的 ${state.raw.length} 条` : "";
      if (error.name === "AbortError") {
        setStatus(`已停止拉取${kept}`, "warn");
      } else {
        setStatus(`${error.message || "拉取失败"}${kept}`, "error");
      }
    } finally {
      state.loading = false;
      state.abortController = null;
      fetchButton.textContent = "开始拉取";
      applyFilters({ keepPage: true });
    }
  };

  const exportCsv = () => {
    if (!state.filtered.length) {
      setStatus("没有可导出的结果，请先拉取数据", "warn");
      return;
    }
    const blob = new Blob([toCsv(state.filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    link.href = url;
    link.download = `ldxp-goods-${stamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`已导出 ${state.filtered.length} 条`, "ok");
  };

  const renderSortIndicators = () => {
    const sort = parseSort(field("sort").value);
    root.querySelectorAll("[data-sort-field]").forEach((th) => {
      th.dataset.sortDir = sort && sort.field === th.dataset.sortField ? sort.dir : "";
    });
  };

  // Header clicks cycle: descending -> ascending -> default order.
  const toggleHeaderSort = (sortField) => {
    const sort = parseSort(field("sort").value);
    let next = `${sortField}Desc`;
    if (sort && sort.field === sortField) {
      next = sort.dir === "desc" ? `${sortField}Asc` : "default";
    }
    field("sort").value = next;
    applyFilters();
    saveSettings();
  };

  const reset = () => {
    field("sourceMode").value = getDefaultSourceMode();
    field("agentKey").value = readPageAgentKey();
    field("keyword").value = "";
    field("goodsType").value = "";
    field("pages").value = "5";
    field("requestIntervalSeconds").value = String(DEFAULT_REQUEST_INTERVAL_SECONDS);
    field("minCost").value = "";
    field("maxCost").value = "";
    field("stockMode").value = "all";
    field("statusMode").value = "all";
    field("connected").value = "all";
    field("categoryKeyword").value = "";
    field("merchantKeyword").value = "";
    field("sort").value = "default";
    field("pageSize").value = "10";
    state.raw = [];
    state.seenIds = new Set();
    state.duplicates = 0;
    state.filtered = [];
    state.currentPage = 1;
    state.lastSummary = "暂无数据";
    setStatus("已重置");
    render();
    saveSettings();
  };

  const getDefaultConnectForm = (item) => {
    const cost = getCostPrice(item) ?? 0;
    const minPrice = getMinimumSalePrice(item);
    const addRate = minPrice !== null && cost > 0
      ? Math.max(0, ((minPrice - cost) / cost) * 100)
      : 10;

    return normalizeConnectForm({
      name: getProductTitle(item),
      name_sync: 1,
      description: item.description || "",
      description_sync: 1,
      category_id: 0,
      add_type: 1,
      add_rate: Number(addRate.toFixed(2)),
      add_price: 0,
      price: 0
    }, item);
  };

  const findItemById = (id) =>
    state.raw.find((item) => String(getProductId(item)) === String(id)) ||
    state.filtered.find((item) => String(getProductId(item)) === String(id));

  const openConnectModal = async (item) => {
    if (!item) {
      setStatus("没有找到要对接的商品", "error");
      return;
    }

    state.connect.visible = true;
    state.connect.item = item;
    state.connect.categories = [];
    state.connect.loading = true;
    state.connect.submitting = false;
    state.connect.error = "";
    state.connect.form = getDefaultConnectForm(item);
    renderConnectModal();

    try {
      const payload = await postMerchantApi("/merchantApi/MyParent/goodsCategory", {
        goods_type: item.goods_type || ""
      });
      state.connect.categories = Array.isArray(payload.data) ? payload.data : [];
      state.connect.error = "";
    } catch (error) {
      state.connect.error = error.message || "分类读取失败";
    } finally {
      state.connect.loading = false;
      renderConnectModal();
    }
  };

  const closeConnectModal = () => {
    state.connect.visible = false;
    state.connect.item = null;
    state.connect.categories = [];
    state.connect.loading = false;
    state.connect.submitting = false;
    state.connect.error = "";
    state.connect.form = null;
    renderConnectModal();
  };

  const readConnectForm = () => {
    const read = (name) => connectModalEl.querySelector(`[data-connect-field="${name}"]`);
    const current = state.connect.form || {};
    const form = {
      name: read("name")?.value.trim() || "",
      name_sync: read("name_sync")?.checked ? 1 : 0,
      description: current.description || "",
      description_sync: read("description_sync")?.checked ? 1 : 0,
      category_id: asNumber(read("category_id")?.value, current.category_id ?? 0),
      add_type: asNumber(read("add_type")?.value, current.add_type ?? 1),
      add_rate: asNumber(read("add_rate")?.value, current.add_rate ?? 0),
      add_price: asNumber(read("add_price")?.value, current.add_price ?? 0),
      price: asNumber(read("price")?.value, current.price ?? 0)
    };
    return state.connect.item ? normalizeConnectForm(form, state.connect.item) : form;
  };

  const renderMinimumPriceTip = (result) => {
    if (result.minPrice === null) {
      return "";
    }

    const text = result.raised
      ? `商家要求最低售价 ¥${money(result.minPrice)}，已自动提升到最低价。`
      : `商家要求最低售价 ¥${money(result.minPrice)}，当前销售价已满足。`;
    return `<div class="ldxp-connect-min-tip" data-role="connectMinTip" data-raised="${result.raised ? "1" : "0"}">${escapeHtml(text)}</div>`;
  };

  const refreshConnectPriceFields = () => {
    if (!state.connect.visible || !state.connect.item || !state.connect.form) {
      return;
    }

    state.connect.form = readConnectForm();
    const result = calculateConnectPrice(state.connect.form, state.connect.item);
    const priceInput = connectModalEl.querySelector('[data-connect-field="price"]');
    const minTip = connectModalEl.querySelector('[data-role="connectMinTip"]');
    if (priceInput) {
      priceInput.value = String(result.price);
    }
    if (minTip) {
      minTip.textContent = result.raised
        ? `商家要求最低售价 ¥${money(result.minPrice)}，已自动提升到最低价。`
        : `商家要求最低售价 ¥${money(result.minPrice)}，当前销售价已满足。`;
      minTip.dataset.raised = result.raised ? "1" : "0";
    }
  };

  const submitConnect = async () => {
    if (!state.connect.item || state.connect.submitting) {
      return;
    }

    state.connect.form = readConnectForm();
    state.connect.submitting = true;
    state.connect.error = "";
    renderConnectModal();

    try {
      const payload = await postMerchantApi("/merchantApi/MyParent/connectGoods", {
        ...state.connect.form,
        goods_id: getProductId(state.connect.item),
        name_sync: state.connect.form.name_sync ? 1 : 0,
        description_sync: state.connect.form.description_sync ? 1 : 0
      });

      if (payload.data && typeof payload.data === "object") {
        state.connect.item.child = payload.data;
      } else {
        state.connect.item.child = state.connect.item.child || { link: "" };
      }

      setStatus("对接成功，建议重新拉取刷新状态", "ok");
      closeConnectModal();
      render();
    } catch (error) {
      state.connect.error = error.message || "对接失败";
      state.connect.submitting = false;
      renderConnectModal();
    }
  };

  function renderConnectModal() {
    if (!state.connect.visible || !state.connect.item || !state.connect.form) {
      connectModalEl.hidden = true;
      connectModalEl.innerHTML = "";
      return;
    }

    const item = state.connect.item;
    const form = state.connect.form;
    const categories = state.connect.categories;
    const cost = getCostPrice(item);
    const title = getProductTitle(item) || "-";
    const disabled = state.connect.loading || state.connect.submitting ? "disabled" : "";
    const priceResult = calculateConnectPrice(form, item);
    const addInput = form.add_type === 1
      ? `
          <label>
            <span>加价比例 %</span>
            <input data-connect-field="add_rate" type="number" min="0" step="0.01" value="${escapeHtml(form.add_rate)}" ${disabled}>
          </label>
        `
      : form.add_type === 2
        ? `
          <label>
            <span>加价金额</span>
            <input data-connect-field="add_price" type="number" min="0" step="0.01" value="${escapeHtml(form.add_price)}" ${disabled}>
          </label>
        `
        : "";
    connectModalEl.hidden = false;
    connectModalEl.innerHTML = `
      <div class="ldxp-connect-backdrop" data-action="connectClose"></div>
      <div class="ldxp-connect-card" role="dialog" aria-modal="true" aria-label="商品对接配置">
        <div class="ldxp-connect-head">
          <div>
            <div class="ldxp-connect-title">对接商品</div>
            <div class="ldxp-connect-subtitle" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          </div>
          <button class="ldxp-icon-btn" data-action="connectClose" title="关闭">x</button>
        </div>
        <div class="ldxp-connect-body">
          <label>
            <span>商品名称</span>
            <input data-connect-field="name" value="${escapeHtml(form.name)}" ${disabled}>
          </label>
          <label>
            <span>店内分类</span>
            <select data-connect-field="category_id" ${disabled}>
              <option value="0">默认 / 稍后再选</option>
              ${categories.map((category) => `<option value="${escapeHtml(category.id)}" ${String(category.id) === String(form.category_id) ? "selected" : ""}>${escapeHtml(category.name || category.title || category.id)}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>加价方式</span>
            <select data-connect-field="add_type" ${disabled}>
              <option value="1" ${form.add_type === 1 ? "selected" : ""}>百分比加价</option>
              <option value="2" ${form.add_type === 2 ? "selected" : ""}>固定金额加价</option>
              <option value="3" ${form.add_type === 3 ? "selected" : ""}>与货源价一致</option>
            </select>
          </label>
          ${addInput}
          <label>
            <span>销售价</span>
            <input data-connect-field="price" type="number" min="0" step="0.01" value="${escapeHtml(priceResult.price)}" readonly ${disabled}>
          </label>
          <label class="ldxp-connect-check">
            <input data-connect-field="name_sync" type="checkbox" ${form.name_sync ? "checked" : ""} ${disabled}>
            <span>自动同步货源标题</span>
          </label>
          <label class="ldxp-connect-check">
            <input data-connect-field="description_sync" type="checkbox" ${form.description_sync ? "checked" : ""} ${disabled}>
            <span>自动同步货源描述</span>
          </label>
          <div class="ldxp-connect-tip">货源成本价：${cost === null ? "未知" : `¥${money(cost)}`}。点击确定会调用原站对接接口。</div>
          ${renderMinimumPriceTip(priceResult)}
          ${state.connect.error ? `<div class="ldxp-connect-error">${escapeHtml(state.connect.error)}</div>` : ""}
        </div>
        <div class="ldxp-connect-foot">
          <button data-action="connectClose" ${state.connect.submitting ? "disabled" : ""}>取消</button>
          <button class="ldxp-primary" data-action="connectSubmit" ${disabled}>${state.connect.submitting ? "正在对接..." : state.connect.loading ? "读取分类..." : "确定对接"}</button>
        </div>
      </div>
    `;
  }

  const openDetailModal = (item) => {
    if (!item) {
      setStatus("没有找到要查看的商品", "error");
      return;
    }
    const link = getDetailLink(item);
    if (!link) {
      setStatus("该商品没有可打开的详情链接", "error");
      return;
    }
    state.detail.visible = true;
    state.detail.item = item;
    renderDetailModal();
  };

  const closeDetailModal = () => {
    state.detail.visible = false;
    state.detail.item = null;
    renderDetailModal();
  };

  function renderDetailModal() {
    if (!state.detail.visible || !state.detail.item) {
      detailModalEl.hidden = true;
      detailModalEl.innerHTML = "";
      return;
    }
    const item = state.detail.item;
    const link = getDetailLink(item);
    const title = getProductTitle(item) || "-";
    detailModalEl.hidden = false;
    detailModalEl.innerHTML = `
      <div class="ldxp-detail-backdrop" data-action="detailClose"></div>
      <div class="ldxp-detail-card" role="dialog" aria-modal="true" aria-label="商品详情">
        <div class="ldxp-detail-head">
          <div>
            <div class="ldxp-detail-title">商品详情</div>
            <div class="ldxp-detail-subtitle" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          </div>
          <div class="ldxp-detail-actions">
            <a class="ldxp-detail-open" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" title="在新标签页打开">新窗口</a>
            <button class="ldxp-icon-btn" data-action="detailClose" title="关闭">x</button>
          </div>
        </div>
        <div class="ldxp-detail-hint">部分商品页不允许嵌入显示。如果下方一直空白，请点右上角「新窗口」打开。</div>
        <div class="ldxp-detail-body">
          <iframe class="ldxp-detail-iframe" src="${escapeHtml(link)}" referrerpolicy="no-referrer-when-downgrade"></iframe>
        </div>
      </div>
    `;
  }

  connectModalEl.addEventListener("input", (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("[data-connect-field]") : null;
    if (!target || !["add_rate", "add_price"].includes(target.dataset.connectField || "")) {
      return;
    }
    refreshConnectPriceFields();
  });

  connectModalEl.addEventListener("change", (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("[data-connect-field]") : null;
    if (!target) {
      return;
    }

    state.connect.form = readConnectForm();
    if (target.dataset.connectField === "add_type") {
      renderConnectModal();
      return;
    }

    if (["add_rate", "add_price"].includes(target.dataset.connectField || "")) {
      refreshConnectPriceFields();
    }
  });

  root.addEventListener("click", (event) => {
    if (root.dataset.miniDragging === "1") {
      root.dataset.miniDragging = "";
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const sortHeader = event.target instanceof HTMLElement ? event.target.closest("[data-sort-field]") : null;
    if (sortHeader instanceof HTMLElement) {
      toggleHeaderSort(sortHeader.dataset.sortField);
      return;
    }

    const actionTarget = event.target instanceof HTMLElement ? event.target.closest("[data-action]") : null;
    const action = actionTarget instanceof HTMLElement ? actionTarget.dataset.action : "";
    if (!action) {
      return;
    }

    if (action === "fetch") {
      startFetch();
    } else if (action === "apply") {
      applyFilters();
      setStatus("已筛选当前数据", "ok");
    } else if (action === "reset") {
      reset();
    } else if (action === "export") {
      exportCsv();
    } else if (action === "first") {
      state.currentPage = 1;
      render();
    } else if (action === "prev") {
      state.currentPage = Math.max(1, state.currentPage - 1);
      render();
    } else if (action === "jump") {
      const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
      state.currentPage = Math.min(Math.max(asNumber(field("pageJump").value, 1), 1), totalPages);
      render();
    } else if (action === "next") {
      const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
      state.currentPage = Math.min(totalPages, state.currentPage + 1);
      render();
    } else if (action === "last") {
      state.currentPage = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
      render();
    } else if (action === "collapse") {
      minimizePanel();
    } else if (action === "expand") {
      expandPanel();
    } else if (action === "close") {
      // Hidden rather than removed, so the toolbar icon can bring it back.
      root.style.display = "none";
      setStatus("已关闭，点击浏览器工具栏上的扩展图标可重新打开");
    } else if (action === "connect") {
      openConnectModal(findItemById(actionTarget.dataset.id));
    } else if (action === "connectClose") {
      closeConnectModal();
    } else if (action === "connectSubmit") {
      submitConnect();
    } else if (action === "viewDetail") {
      openDetailModal(findItemById(actionTarget.dataset.id));
    } else if (action === "detailClose") {
      closeDetailModal();
    }
  });

  root.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      if (event.target === field("pageJump")) {
        const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
        state.currentPage = Math.min(Math.max(asNumber(field("pageJump").value, 1), 1), totalPages);
        render();
        return;
      }
      applyFilters();
    }
  });

  root.querySelector(".ldxp-controls").addEventListener("change", () => saveSettings());
  root.querySelector(".ldxp-controls").addEventListener("input", () => saveSettings());

  field("sourceMode").addEventListener("change", () => {
    if (field("sourceMode").value === "parent" && !field("agentKey").value.trim()) {
      field("agentKey").value = readPageAgentKey();
    }
    setStatus(field("sourceMode").value === "parent"
      ? "已切换到指定货源商读取"
      : "已切换到开放货源搜索");
  });

  let dragState = null;
  titlebarEl.addEventListener("mousedown", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) {
      return;
    }
    const rect = root.getBoundingClientRect();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top
    };
    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
    event.preventDefault();
  });

  function onDragMove(event) {
    if (!dragState) {
      return;
    }
    const nextLeft = Math.max(8, Math.min(window.innerWidth - 120, dragState.left + event.clientX - dragState.startX));
    const nextTop = Math.max(8, Math.min(window.innerHeight - 60, dragState.top + event.clientY - dragState.startY));
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
    root.style.right = "auto";
  }

  function onDragEnd() {
    dragState = null;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }

  let miniDragState = null;
  const miniLauncherEl = $(".ldxp-mini-launcher");
  miniLauncherEl.addEventListener("mousedown", (event) => {
    const rect = root.getBoundingClientRect();
    miniDragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false
    };
    root.dataset.miniDragging = "";
    document.addEventListener("mousemove", onMiniDragMove);
    document.addEventListener("mouseup", onMiniDragEnd);
    event.preventDefault();
  });

  function onMiniDragMove(event) {
    if (!miniDragState) {
      return;
    }

    const dx = event.clientX - miniDragState.startX;
    const dy = event.clientY - miniDragState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      miniDragState.moved = true;
    }

    const miniWidth = MINI_WIDTH;
    const miniHeight = MINI_HEIGHT;
    const nextLeft = Math.max(VIEWPORT_GAP, Math.min(window.innerWidth - miniWidth - VIEWPORT_GAP, miniDragState.left + dx));
    const nextTop = Math.max(VIEWPORT_GAP, Math.min(window.innerHeight - miniHeight - VIEWPORT_GAP, miniDragState.top + dy));
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
    root.style.right = "auto";
  }

  function onMiniDragEnd() {
    if (miniDragState?.moved) {
      root.dataset.miniDragging = "1";
      setTimeout(() => {
        root.dataset.miniDragging = "";
      }, 0);
      const rect = root.getBoundingClientRect();
      state.layout.miniLeft = Math.round(rect.left);
      state.layout.miniTop = Math.round(rect.top);
      saveSettings();
    }
    miniDragState = null;
    document.removeEventListener("mousemove", onMiniDragMove);
    document.removeEventListener("mouseup", onMiniDragEnd);
  }

  function minimizePanel() {
    const rect = root.getBoundingClientRect();
    const nextLeft = Math.max(VIEWPORT_GAP, Math.min(window.innerWidth - MINI_WIDTH - VIEWPORT_GAP, rect.right - MINI_WIDTH));
    const nextTop = Math.max(VIEWPORT_GAP, Math.min(window.innerHeight - MINI_HEIGHT - VIEWPORT_GAP, rect.top));
    root.dataset.expandedWidth = root.style.width || "";
    root.dataset.expandedPanelHeight = panelEl.style.height || "";
    root.dataset.expandedBodyHeight = bodyEl.style.height || "";
    root.dataset.expandedBodyMaxHeight = bodyEl.style.maxHeight || "";
    root.dataset.miniDragging = "";
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
    root.style.right = "auto";
    root.style.width = `${MINI_WIDTH}px`;
    panelEl.style.height = "";
    bodyEl.style.height = "";
    bodyEl.style.maxHeight = "";
    root.classList.add("is-minimized");
  }

  function expandPanel() {
    const miniRect = root.getBoundingClientRect();
    root.classList.remove("is-minimized");
    root.style.width = root.dataset.expandedWidth || "min(1080px, calc(100vw - 24px))";
    panelEl.style.height = root.dataset.expandedPanelHeight || "";
    bodyEl.style.height = root.dataset.expandedBodyHeight || "";
    bodyEl.style.maxHeight = root.dataset.expandedBodyMaxHeight || "";
    fitToViewport();
    keepExpandedPanelInViewport(miniRect.right);
  }

  function showAutoCapsule() {
    const nextLeft = Math.max(VIEWPORT_GAP, window.innerWidth - MINI_WIDTH - AUTO_MINI_RIGHT);
    const nextTop = Math.max(VIEWPORT_GAP, Math.min(window.innerHeight - MINI_HEIGHT - VIEWPORT_GAP, AUTO_MINI_TOP));
    root.dataset.expandedWidth = "";
    root.dataset.expandedPanelHeight = "";
    root.dataset.expandedBodyHeight = "";
    root.dataset.expandedBodyMaxHeight = "";
    root.dataset.miniDragging = "";
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
    root.style.right = "auto";
    root.style.width = `${MINI_WIDTH}px`;
    panelEl.style.height = "";
    bodyEl.style.height = "";
    bodyEl.style.maxHeight = "";
    root.classList.add("is-minimized");
  }

  function keepExpandedPanelInViewport(anchorRight = null) {
    const rect = root.getBoundingClientRect();
    const desiredLeft = Number.isFinite(anchorRight) ? anchorRight - rect.width : rect.left;
    const maxLeft = Math.max(VIEWPORT_GAP, window.innerWidth - rect.width - VIEWPORT_GAP);
    const maxTop = Math.max(VIEWPORT_GAP, window.innerHeight - rect.height - VIEWPORT_GAP);
    const nextLeft = Math.max(VIEWPORT_GAP, Math.min(desiredLeft, maxLeft));
    const nextTop = Math.max(VIEWPORT_GAP, Math.min(rect.top, maxTop));
    root.style.left = `${Math.round(nextLeft)}px`;
    root.style.top = `${Math.round(nextTop)}px`;
    root.style.right = "auto";
  }

  let resizeState = null;
  resizeHandleEl.addEventListener("mousedown", (event) => {
    const rootRect = root.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    resizeState = {
      startX: event.clientX,
      startY: event.clientY,
      width: panelRect.width,
      height: panelRect.height,
      left: rootRect.left,
      top: rootRect.top
    };
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", onResizeEnd);
    event.preventDefault();
    event.stopPropagation();
  });

  function applyPanelSize(width, height, left, top) {
    root.style.width = `${Math.round(width)}px`;
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    root.style.right = "auto";
    panelEl.style.height = `${Math.round(height)}px`;
    bodyEl.style.height = "";
    bodyEl.style.maxHeight = "";
  }

  function onResizeMove(event) {
    if (!resizeState) {
      return;
    }

    const edgeGap = VIEWPORT_GAP;
    const minWidth = Math.min(680, window.innerWidth - 20);
    const minHeight = 390;
    const maxWidth = Math.max(minWidth, window.innerWidth - edgeGap * 2);
    const maxHeight = Math.max(minHeight, window.innerHeight - edgeGap * 2);
    const nextWidth = Math.max(minWidth, Math.min(maxWidth, resizeState.width + event.clientX - resizeState.startX));
    const nextHeight = Math.max(minHeight, Math.min(maxHeight, resizeState.height + event.clientY - resizeState.startY));
    const nextLeft = Math.max(edgeGap, Math.min(resizeState.left, window.innerWidth - nextWidth - edgeGap));
    const nextTop = Math.max(edgeGap, Math.min(resizeState.top, window.innerHeight - nextHeight - edgeGap));

    applyPanelSize(nextWidth, nextHeight, nextLeft, nextTop);
  }

  function onResizeEnd() {
    if (resizeState) {
      const rect = panelEl.getBoundingClientRect();
      state.layout.width = Math.round(rect.width);
      state.layout.height = Math.round(rect.height);
      saveSettings();
    }
    resizeState = null;
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeEnd);
  }

  // Shrinks the expanded panel to the window and pulls it, or the capsule, back on screen.
  function fitToViewport() {
    if (root.style.display === "none") {
      return;
    }
    if (root.classList.contains("is-minimized")) {
      const rect = root.getBoundingClientRect();
      root.style.left = `${Math.round(Math.max(VIEWPORT_GAP, Math.min(window.innerWidth - MINI_WIDTH - VIEWPORT_GAP, rect.left)))}px`;
      root.style.top = `${Math.round(Math.max(VIEWPORT_GAP, Math.min(window.innerHeight - MINI_HEIGHT - VIEWPORT_GAP, rect.top)))}px`;
      return;
    }
    const maxWidth = window.innerWidth - VIEWPORT_GAP * 2;
    const maxHeight = window.innerHeight - VIEWPORT_GAP * 2;
    if (root.getBoundingClientRect().width > maxWidth) {
      root.style.width = `${Math.round(maxWidth)}px`;
    }
    if (panelEl.getBoundingClientRect().height > maxHeight) {
      panelEl.style.height = `${Math.round(maxHeight)}px`;
    }
    keepExpandedPanelInViewport();
  }

  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(fitToViewport);
  });

  // ---------- saved settings (chrome.storage.local, stays on this device) ----------

  const SAVED_FIELDS = [
    "agentKey", "keyword", "goodsType", "pages", "requestIntervalSeconds", "minCost", "maxCost",
    "stockMode", "statusMode", "connected", "categoryKeyword", "merchantKeyword", "sort", "pageSize"
  ];
  let settingsLoaded = false;
  let saveTimer = 0;

  function saveSettings() {
    if (!settingsLoaded) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const fields = {};
      SAVED_FIELDS.forEach((name) => {
        fields[name] = field(name).value;
      });
      try {
        chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: { fields, layout: state.layout } }).catch(() => {});
      } catch (_) {
        // Storage is unavailable (extension reloaded); settings just won't persist.
      }
    }, 300);
  }

  async function loadSettings() {
    let saved = null;
    try {
      saved = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY] || null;
    } catch (_) {
      saved = null;
    }
    const pageAgentKey = readPageAgentKey();
    Object.entries(saved?.fields || {}).forEach(([name, value]) => {
      const el = SAVED_FIELDS.includes(name) ? field(name) : null;
      if (!el || (name === "agentKey" && pageAgentKey)) {
        return;
      }
      if (el instanceof HTMLSelectElement && !Array.from(el.options).some((option) => option.value === value)) {
        return;
      }
      el.value = asText(value);
    });
    state.pageSize = asNumber(field("pageSize").value, 10);

    const layout = saved?.layout || {};
    if (layout.width && layout.height) {
      state.layout.width = layout.width;
      state.layout.height = layout.height;
      root.dataset.expandedWidth = `${layout.width}px`;
      root.dataset.expandedPanelHeight = `${layout.height}px`;
    }
    if (Number.isFinite(layout.miniLeft) && Number.isFinite(layout.miniTop) && root.classList.contains("is-minimized")) {
      state.layout.miniLeft = layout.miniLeft;
      state.layout.miniTop = layout.miniTop;
      root.style.left = `${layout.miniLeft}px`;
      root.style.top = `${layout.miniTop}px`;
      fitToViewport();
    }
    settingsLoaded = true;
    render();
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== SHOW_PANEL_MESSAGE) {
        return;
      }
      root.style.display = "";
      if (root.classList.contains("is-minimized")) {
        expandPanel();
      } else {
        fitToViewport();
      }
    });
  } catch (_) {
    // Messaging is unavailable; the toolbar icon just won't reopen the panel.
  }

  render();
  showAutoCapsule();
  loadSettings();
})();
