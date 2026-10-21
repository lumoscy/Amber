# 链动小铺货源增强筛选 浏览器扩展

> **来源说明**：本目录基于 [WowJokerH/edge-ldxp-filter](https://github.com/WowJokerH/edge-ldxp-filter)（提交 `73bddaf`，版本 1.0.19）修改，原作者为 WowJokerH（哇咔咔）。原项目未声明开源许可证，版权归原作者所有；这里的修改（1.1.0）计划以 PR 的形式反馈给原项目。

这是一个不依赖油猴的本地浏览器扩展，兼容 Microsoft Edge 和 Google Chrome（基于 Manifest V3）。打开链动小铺相关页面后，扩展会自动显示一个悬浮小胶囊；点击胶囊展开筛选面板后，可以通过原站接口拉取数据，并在浏览器本地做筛选、排序和分页展示。

项目地址：`https://github.com/WowJokerH/edge-ldxp-filter`

## 视频演示

【链动小铺货源筛选浏览器插件】https://www.bilibili.com/video/BV1kyLb6fEWa/?share_source=copy_web&vd_source=9da43d789b00645889be19bc71b290cc

## 安装

### Microsoft Edge

1. 打开 Edge，访问 `edge://extensions/`。
2. 打开左侧的 `开发人员模式`。
3. 点击 `加载解压缩的扩展`。
4. 选择下载并解压后的插件文件夹：`edge-ldxp-filter`。

### Google Chrome

1. 打开 Chrome，访问 `chrome://extensions/`。
2. 打开右上角的 `开发者模式`。
3. 点击左上角的 `加载已解压的扩展程序`。
4. 选择下载并解压后的插件文件夹：`edge-ldxp-filter`。

### 使用前置条件

登录链动小铺后台，打开 `https://www.ldxp.cn/`、`https://pay.ldxp.cn/` 或 `https://wzyp.cn/` 下的页面；识别到站点后会先显示右上角悬浮小胶囊，点击后展开完整面板。开放货源搜索可进入 `https://www.ldxp.cn/merchant/my_parent/source_square`；指定货源商/非公开货源可进入 `https://www.ldxp.cn/merchant/my_parent/apply`，在插件里填写货源对接码后读取。

## 使用

- `数据来源`：`开放货源搜索` 调用 `/merchantApi/MyParent/searchGoodsList`；`指定货源商` 调用 `/merchantApi/MyParent/parentGoodsList`，需要填写货源对接码 / `agent_key`。
- `请求间隔(秒)`：默认每页真实请求间隔 1 秒，最小可调到 0.2 秒；第 1 页立即请求，从第 2 页开始等待。遇到平台限流或风控提示时，建议临时调到 5-10 秒，严重时再调到 10-30 秒。
- `开始拉取`：按设置的页数调用当前数据来源对应接口；第 1 页立即请求，从第 2 页开始按请求间隔等待。
- 识别到 `pay.ldxp.cn`、`www.ldxp.cn` 或 `wzyp.cn` 后会自动显示可拖拽悬浮小胶囊，不会默认展开遮挡页面。
- 店铺域名兼容新旧地址：`https://pay.ldxp.cn/shop/ldxp` 会自动按相同店铺后缀替换为 `https://wzyp.cn/shop/ldxp`。
- `筛选当前数据`：不重新请求接口，只对已经拉取的数据重新筛选。
- 拉取时每拉完一页就刷新结果表格，状态栏显示进度；同一商品在不同页重复出现时会自动跳过，并在汇总里显示跳过条数。
- 遇到限流（HTTP 429、5xx、网络错误或“请求频繁”一类提示）会自动重试，最多 3 次，等待时间依次加倍（至少 2 秒）；重试仍失败才停止，已拉到的数据会保留。
- 表格新增 `差价`（售价 - 成本价）和 `利润率`（差价 / 成本价）两列；点击售价、成本价、差价、利润率、库存、销量的表头可以排序，依次切换降序、升序、默认。
- `导出 CSV`：把筛选后的全部结果导出为 CSV，可直接用 Excel 打开。
- 库存筛选：库存未知的商品（通常是不限库存）算作有库存，不会出现在 `仅无库存` 里。
- 筛选条件、面板大小和小胶囊位置会保存在本机浏览器里，下次打开自动恢复。数据来源仍按当前页面自动判断；网址里带的货源对接码优先于保存的值。
- 浏览器窗口变小时，面板会自动缩小并留在屏幕内。
- 点 `x` 关闭面板后，点浏览器工具栏上的扩展图标可以重新打开；在其他网站点图标会打开开放货源页面。
- `停止拉取`：拉取过程中再次点击按钮会中止请求。
- 关键词、分类关键词和商家名称筛选都不区分大小写。
- 面板标题栏可以拖动，右下角的斜纹手柄可以调整大小，右上角可以最小化成悬浮小图标或关闭；当前界面已压缩筛选区，把更多空间留给下方结果表格。
- 最小化后的悬浮小图标也可以拖拽移动，单击小图标恢复完整面板。
- 扩展图标和最小化悬浮图标使用同一套本地 `assets/icon-*.png` 图标；每页显示可选 `5/10/15/20/25/30`，默认 `10`。
- 未对接商品可以直接点表格里的 `对接` 打开对接配置弹窗；这个流程复用原站接口，确认后调用 `/merchantApi/MyParent/connectGoods`。已对接商品会显示 `查看`，跳转到原站返回的已对接商品链接。
- 作者卡网和感谢小纸条固定在面板底栏，不会被结果表格或窗口缩放挤没。
- 已按真实接口字段精简：商品名 `name/title`、分类 `category.name/category_name`、商家 `user.nickname/nickname/shop_name`、库存 `stock_count`、对接状态 `child`、上架状态 `status`、价格 `price/cost_price`。
- 当前版本会尝试从 `localStorage` 读取 `auth-token` 作为 `Merchant-Token`，所以必须先在原站登录。

## 作者小纸条

觉得好用的话，下次可以来哇咔咔这里补一单小小感谢；挑最便宜的商品也完全 OK，主要是让哇咔咔开心一下。

作者卡网：`https://wzyp.cn/shop/V2YZIFWM`

## 可调整项

如果链动小铺接口字段发生变化，优先修改 `content.js` 里的这些函数：

- `buildRequestBody`
- `normalizeList`
- `getProductTitle`
- `getMerchant`
- `getCostPrice`
- `getConnectedLabel`

## 测试

```bash
node --test test/*.test.js
```
