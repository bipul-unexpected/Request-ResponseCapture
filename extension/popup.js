// Runtime: Extension Popup Controller (Fixed State Sync)
const CHECKBOX_IDS = [
  "enabled",
  "spoofProPlan",
  "unlimitedCreditsUI",
  "forceFreeBuildHour",
  "forceFreeFixMode",
  "stripPlanCookie",
  "blockTelemetryAndReporter"
];

function renderConfig(cfg) {
  for (const id of CHECKBOX_IDS) {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(cfg[id]);
  }
  document.getElementById("activePlan").value = cfg.activePlan || "pro";
  document.getElementById("virtualCredits").value = cfg.virtualCredits ?? 999999;

  const pool = Array.isArray(cfg.tokenPool) ? cfg.tokenPool : [];
  const activeIdx = cfg.activeTokenIndex >= 0 ? cfg.activeTokenIndex + 1 : 0;
  
  let statusEl = document.getElementById("poolStatus");
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.id = "poolStatus";
    statusEl.className = "pool-stats";
    document.querySelector(".card:last-of-type").appendChild(statusEl);
  }
  statusEl.textContent = `Pool: ${pool.length} tokens (Active: #${activeIdx}) | Switches today: ${cfg.switchCountToday || 0}`;
}

function saveChanges() {
  const payload = {};
  for (const id of CHECKBOX_IDS) {
    const el = document.getElementById(id);
    if (el) payload[id] = el.checked;
  }
  payload.activePlan = document.getElementById("activePlan").value;
  payload.virtualCredits = Number(document.getElementById("virtualCredits").value) || 999999;

  chrome.runtime.sendMessage({ type: "LZ_UPDATE_CONFIG", payload }, (res) => {
    if (res && res.ok) renderConfig(res.config);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ type: "LZ_GET_CONFIG" }, (res) => {
    if (res && res.ok) renderConfig(res.config);
  });

  for (const id of CHECKBOX_IDS) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", saveChanges);
  }
  document.getElementById("activePlan").addEventListener("change", saveChanges);
  document.getElementById("virtualCredits").addEventListener("change", saveChanges);

  document.getElementById("addTokenBtn").addEventListener("click", () => {
    const raw = document.getElementById("newTokenInput").value.trim();
    if (!raw) return;
    
    chrome.runtime.sendMessage({ type: "LZ_GET_CONFIG" }, (res) => {
      const pool = res?.config?.tokenPool || [];
      const cleanToken = raw.replace(/^Bearer\s+/i, "");
      const exists = pool.some((item) => item.bearerToken === cleanToken);
      
      if (!exists && cleanToken) {
        pool.push({
          label: `Token-${pool.length + 1}`,
          bearerToken: cleanToken,
          workspaceId: null
        });
        chrome.runtime.sendMessage(
          { type: "LZ_UPDATE_CONFIG", payload: { tokenPool: pool } },
          (upd) => {
            document.getElementById("newTokenInput").value = "";
            if (upd && upd.ok) {
              renderConfig(upd.config);
            }
          }
        );
      } else {
        document.getElementById("newTokenInput").value = "";
      }
    });
  });

  document.getElementById("rotateBtn").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "LZ_ROTATE_TOKEN" }, (res) => {
      if (res && res.ok) renderConfig(res.config);
    });
  });
});