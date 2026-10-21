"use strict";

const SHOW_PANEL_MESSAGE = "ldxp-edge-filter:show";
const SOURCE_SQUARE_URL = "https://www.ldxp.cn/merchant/my_parent/source_square";

// Toolbar icon: reopen the panel on a supported page, otherwise open the source square.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: SHOW_PANEL_MESSAGE });
  } catch (_) {
    await chrome.tabs.create({ url: SOURCE_SQUARE_URL });
  }
});
