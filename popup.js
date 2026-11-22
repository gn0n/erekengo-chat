/* Открывает боковую панель чата. created by Yernat Bakytnur */
(() => {
  'use strict';
  const btn = document.getElementById('btn-open');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await chrome.sidePanel.open({ tabId: tab.id });
      window.close();
    } catch (e) {
      btn.textContent = 'не удалось открыть';
    }
  });
})();
