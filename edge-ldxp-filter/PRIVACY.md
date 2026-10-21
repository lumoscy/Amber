# 隐私政策 / Privacy Policy

本扩展用于在链动小铺页面上筛选和比较货源。它不收集、不出售、也不向开发者或任何第三方传输用户数据。

## 运行范围

扩展只在 manifest 里声明的链动小铺域名上运行：

- `https://www.ldxp.cn/*`
- `https://pay.ldxp.cn/*`
- `https://wzyp.cn/*`

## 处理的数据

在用户打开面板并开始拉取后，扩展会在浏览器内处理：

- 链动小铺货源接口返回的商品和店铺信息；
- 显示筛选结果和商品详情所需的页面内容；
- 链动小铺网站自己保存在本地的登录凭证（`auth-token`）。扩展只把它作为 `Merchant-Token`，用在从用户浏览器发往链动小铺原站的请求里，让用户看到自己账号本来就能看到的数据。

店铺链接可能会从旧域名 `pay.ldxp.cn` 改写为新域名 `wzyp.cn`。

## 本地存储

扩展把面板的筛选条件（包括填写的货源对接码）、面板大小和小胶囊位置保存在 `chrome.storage.local`，方便下次恢复。这些数据只留在用户的浏览器里，不会发送到任何地方。

## 不做的事

- 不把数据发给开发者；
- 不接入第三方统计或广告服务；
- 不加载或执行远程 JavaScript 或 WebAssembly，所有代码都随扩展打包。

## 联系方式

---

## English

This extension filters and compares source goods on supported LDXP pages. It does not collect, sell, or transfer user data to the developer or any third party.

**Scope.** It runs only on the LDXP domains declared in its manifest: `https://www.ldxp.cn/*`, `https://pay.ldxp.cn/*` and `https://wzyp.cn/*`.

**Data processed.** After the user opens the panel and starts fetching, the extension processes, inside the browser: product and store information returned by LDXP source goods APIs; page content needed to show filtering and detail views; and the authentication token (`auth-token`) the LDXP website stores locally. The token is used only as `Merchant-Token` in requests from the user's browser to the original LDXP domains, so the user can see data their logged-in account can already access. Shop links may be rewritten from the legacy `pay.ldxp.cn` domain to `wzyp.cn`.

**Local storage.** Filter settings (including any source agent key entered), panel size and launcher position are saved in `chrome.storage.local` so they are restored next time. This data stays in the user's browser and is never sent anywhere.

**No remote code.** The extension does not load or execute remote JavaScript or WebAssembly. All code is packaged with the extension.

**Contact.**
