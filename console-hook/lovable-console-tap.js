// File: brave-nettap/console-hook/lovable-console-tap.js
// Paste directly into Brave DevTools Console (F12 -> Console) on lovable.dev
(() => {
  if (window.__BENCH_NET_TAP__) {
    window.__BENCH_NET_TAP__.exportJson();
    return;
  }

  const state = {
    startedAt: new Date().toISOString(),
    pageUrl: location.href,
    records: [],
    websockets: [],
    resourceTimings: []
  };

  const origFetch = window.fetch;
  const origXHROpen = XMLHttpRequest.prototype.open;
  const origXHRSend = XMLHttpRequest.prototype.send;
  const origXHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const OrigWebSocket = window.WebSocket;

  function tryParseJson(str) {
    if (typeof str !== "string") return null;
    const t = str.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try { return JSON.parse(t); } catch (_) { return null; }
    }
    return null;
  }

  function headersToObject(headersInit) {
    const out = {};
    if (!headersInit) return out;
    try { new Headers(headersInit).forEach((v, k) => { out[k] = v; }); } catch (_) {}
    return out;
  }

  window.fetch = async function (...args) {
    const [input, init] = args;
    const reqUrl = typeof input === "string" ? input : (input instanceof URL ? input.href : input?.url || String(input));
    const method = init?.method || (typeof input === "object" && input?.method) || "GET";
    const reqHeaders = headersToObject(init?.headers || (typeof input === "object" ? input?.headers : undefined));
    const reqBodyRaw = init?.body !== undefined
      ? (typeof init.body === "string" ? init.body : "[Non-String Body]")
      : null;

    const startPerf = performance.now();
    const record = {
      id: `fetch_${state.records.length + 1}_${Date.now()}`,
      api: "fetch",
      timestampIso: new Date().toISOString(),
      url: reqUrl,
      method: method.toUpperCase(),
      requestHeaders: reqHeaders,
      requestBodyRaw: reqBodyRaw,
      requestBodyJson: tryParseJson(reqBodyRaw),
      status: null,
      statusText: null,
      responseHeaders: {},
      responseType: null,
      responseBodyRaw: null,
      responseBodyJson: null,
      sseChunks: [],
      durationMs: null,
      sizeBytes: 0,
      error: null
    };
    state.records.push(record);
    updateBadge();

    try {
      const response = await origFetch.apply(this, args);
      record.status = response.status;
      record.statusText = response.statusText;
      record.responseHeaders = headersToObject(response.headers);
      const contentType = (record.responseHeaders["content-type"] || "").toLowerCase();
      record.responseType = contentType;

      const clone = response.clone();
      if (contentType.includes("text/event-stream") && clone.body) {
        (async () => {
          const reader = clone.body.getReader();
          const decoder = new TextDecoder();
          let totalText = "";
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunkText = decoder.decode(value, { stream: true });
              totalText += chunkText;
              record.sseChunks.push({
                tMs: Number((performance.now() - startPerf).toFixed(2)),
                chunk: chunkText
              });
            }
          } catch (e) {
            record.error = String(e);
          } finally {
            record.responseBodyRaw = totalText;
            record.sizeBytes = new Blob([totalText]).size;
            record.durationMs = Number((performance.now() - startPerf).toFixed(2));
            updateBadge();
          }
        })();
      } else {
        clone.text().then((txt) => {
          record.responseBodyRaw = txt;
          record.responseBodyJson = tryParseJson(txt);
          record.sizeBytes = new Blob([txt]).size;
          record.durationMs = Number((performance.now() - startPerf).toFixed(2));
          updateBadge();
        }).catch((e) => {
          record.error = String(e);
        });
      }
      return response;
    } catch (err) {
      record.durationMs = Number((performance.now() - startPerf).toFixed(2));
      record.error = String(err?.message || err);
      updateBadge();
      throw err;
    }
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__tapMeta = {
      id: `xhr_${state.records.length + 1}_${Date.now()}`,
      method: String(method || "GET").toUpperCase(),
      url: String(url),
      requestHeaders: {}
    };
    return origXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__tapMeta) this.__tapMeta.requestHeaders[k] = v;
    return origXHRSetHeader.call(this, k, v);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__tapMeta) {
      const meta = this.__tapMeta;
      const startPerf = performance.now();
      const rawBody = typeof body === "string" ? body : null;
      const record = {
        id: meta.id,
        api: "xhr",
        timestampIso: new Date().toISOString(),
        url: meta.url,
        method: meta.method,
        requestHeaders: meta.requestHeaders,
        requestBodyRaw: rawBody,
        requestBodyJson: tryParseJson(rawBody),
        status: null,
        responseHeaders: {},
        responseBodyRaw: null,
        responseBodyJson: null,
        durationMs: null,
        sizeBytes: 0
      };
      state.records.push(record);
      updateBadge();

      this.addEventListener("loadend", () => {
        record.status = this.status;
        record.durationMs = Number((performance.now() - startPerf).toFixed(2));
        try {
          record.responseBodyRaw = this.responseText;
          record.responseBodyJson = tryParseJson(this.responseText);
          record.sizeBytes = new Blob([this.responseText || ""]).size;
        } catch (_) {}
        updateBadge();
      });
    }
    return origXHRSend.call(this, body);
  };

  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
    const wsEntry = { url: String(url), createdAtIso: new Date().toISOString(), frames: [] };
    state.websockets.push(wsEntry);
    updateBadge();

    const origSend = ws.send;
    ws.send = function (data) {
      wsEntry.frames.push({ direction: "SENT", timestampIso: new Date().toISOString(), data: String(data) });
      return origSend.call(this, data);
    };
    ws.addEventListener("message", (ev) => {
      wsEntry.frames.push({ direction: "RECEIVED", timestampIso: new Date().toISOString(), data: String(ev.data) });
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        state.resourceTimings.push({
          name: e.name,
          initiatorType: e.initiatorType,
          durationMs: Number(e.duration.toFixed(2)),
          ttfbMs: Number((e.responseStart - e.requestStart).toFixed(2)),
          transferSize: e.transferSize
        });
      }
    }).observe({ type: "resource", buffered: true });
  } catch (_) {}

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lovable_console_dump_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const hud = document.createElement("div");
  hud.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#0f172a;color:#38bdf8;border:1px solid #334155;padding:10px 12px;border-radius:8px;font-family:monospace;font-size:12px;display:flex;gap:10px;align-items:center;";
  const label = document.createElement("span");
  label.textContent = "NetTap: 0 reqs | 0 WS";
  const btn = document.createElement("button");
  btn.textContent = "Export JSON";
  btn.style.cssText = "background:#10b981;color:#052e16;border:none;padding:5px 10px;border-radius:4px;font-weight:bold;cursor:pointer;font-family:monospace;";
  btn.onclick = exportJson;
  hud.appendChild(label);
  hud.appendChild(btn);
  document.body.appendChild(hud);

  function updateBadge() {
    label.textContent = `NetTap: ${state.records.length} reqs | ${state.websockets.length} WS`;
  }

  window.__BENCH_NET_TAP__ = { state, exportJson };
})();