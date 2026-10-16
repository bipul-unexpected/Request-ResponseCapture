// File: brave-nettap/extension/popup.js
const statusBox = document.getElementById("statusBox");
const errorBox = document.getElementById("errorBox");
const btnStart = document.getElementById("btnStart");
const btnExportLive = document.getElementById("btnExportLive");
const btnStopExport = document.getElementById("btnStopExport");

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshStatus() {
  const tab = await getActiveTab();
  if (!tab) return;

  chrome.runtime.sendMessage({ cmd: "GET_STATUS", tabId: tab.id }, (res) => {
    if (chrome.runtime.lastError || !res) return;
    let host = "unknown";
    try { host = new URL(tab.url || "https://blank").hostname; } catch (_) {}

    if (res.recording) {
      statusBox.innerHTML =
        `STATUS: <b style="color:#10b981">RECORDING</b><br/>` +
        `Host: ${host}<br/>` +
        `Requests: <b>${res.requestCount}</b> | WebSockets: <b>${res.wsCount}</b>`;
      btnStart.disabled = true;
      btnExportLive.disabled = false;
      btnStopExport.disabled = false;
    } else {
      statusBox.innerHTML = `STATUS: <b>IDLE</b><br/>Target: ${host}`;
      btnStart.disabled = false;
      btnExportLive.disabled = true;
      btnStopExport.disabled = true;
    }
  });
}

btnStart.addEventListener("click", async () => {
  errorBox.textContent = "";
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    errorBox.textContent = "No active tab found.";
    return;
  }
  chrome.runtime.sendMessage({ cmd: "START_CAPTURE", tabId: tab.id, tabUrl: tab.url }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      errorBox.textContent = chrome.runtime.lastError?.message || res?.error || "Failed to attach debugger.";
    } else {
      // Auto reload tab so CDP captures all initial boot requests cleanly
      chrome.tabs.reload(tab.id);
    }
    refreshStatus();
  });
});

btnExportLive.addEventListener("click", async () => {
  errorBox.textContent = "";
  const tab = await getActiveTab();
  chrome.runtime.sendMessage({ cmd: "EXPORT_LIVE", tabId: tab.id }, (res) => {
    if (!res?.ok) errorBox.textContent = res?.error || "Export failed.";
    refreshStatus();
  });
});

btnStopExport.addEventListener("click", async () => {
  errorBox.textContent = "";
  const tab = await getActiveTab();
  chrome.runtime.sendMessage({ cmd: "STOP_AND_EXPORT", tabId: tab.id }, (res) => {
    if (!res?.ok) errorBox.textContent = res?.error || "Stop & Export failed.";
    refreshStatus();
  });
});

refreshStatus();
setInterval(refreshStatus, 1000);