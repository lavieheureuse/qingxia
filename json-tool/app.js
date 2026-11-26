(function () {
  "use strict";

  var THEME_STORAGE_KEY = "qingxia-json-workshop-theme";

  /* -----------------------------
     Utility Helpers
  ----------------------------- */
  function byId(id) {
    return document.getElementById(id);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(2) + " MB";
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function byteLength(str) {
    return new Blob([str]).size;
  }

  function syntaxHighlightJson(jsonStr) {
    var escaped = escapeHtml(jsonStr);
    return escaped.replace(
      /(&quot;(?:\\u[a-zA-Z0-9]{4}|\\[^u\r\n]|[^\\&\r\n]|&(?!quot;))*&quot;(?:[ \t]*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:])/g,
      function (match) {
        if (match.charAt(0) === "&") {
          if (/:$/.test(match)) {
            var colonIdx = match.lastIndexOf(":");
            return '<span class="syn-key">' + match.slice(0, colonIdx) + '</span><span class="syn-punct">:</span>';
          }
          return '<span class="syn-str">' + match + "</span>";
        }
        if (match === "true" || match === "false") {
          return '<span class="syn-bool">' + match + "</span>";
        }
        if (match === "null") {
          return '<span class="syn-null">' + match + "</span>";
        }
        if (/^[{}\[\],:]$/.test(match)) {
          return '<span class="syn-punct">' + match + "</span>";
        }
        return '<span class="syn-num">' + match + "</span>";
      }
    );
  }

  function renderCodeLines(preEl, text, highlight) {
    var codeEl = preEl.querySelector("code");
    var content = highlight ? syntaxHighlightJson(text) : escapeHtml(text);
    var lines = content.split("\n");
    var html = "";
    for (var i = 0; i < lines.length; i++) {
      html += '<div class="code-line" data-line="' + (i + 1) + '">' + (lines[i] || " ") + "</div>";
    }
    codeEl.innerHTML = html;
  }

  function computeJsonMetrics(val) {
    var nodes = 0;
    var maxDepth = 0;
    function walk(item, depth) {
      nodes++;
      if (depth > maxDepth) maxDepth = depth;
      if (Array.isArray(item)) {
        for (var i = 0; i < item.length; i++) walk(item[i], depth + 1);
      } else if (item && typeof item === "object") {
        var keys = Object.keys(item);
        for (var j = 0; j < keys.length; j++) walk(item[keys[j]], depth + 1);
      }
    }
    walk(val, 1);
    return { nodes: nodes, depth: maxDepth };
  }

  function sortKeysDeep(val) {
    if (Array.isArray(val)) {
      return val.map(sortKeysDeep);
    }
    if (val && typeof val === "object") {
      var sorted = {};
      Object.keys(val)
        .sort(function (a, b) { return a.localeCompare(b); })
        .forEach(function (k) { sorted[k] = sortKeysDeep(val[k]); });
      return sorted;
    }
    return val;
  }

  function parseJsonErrorLocation(text, err) {
    var msg = err && err.message ? err.message : "JSON 语法错误";
    var line = 1;
    var col = 1;
    var posMatch = msg.match(/position\s+(\d+)/i);
    var lcMatch = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lcMatch) {
      line = parseInt(lcMatch[1], 10);
      col = parseInt(lcMatch[2], 10);
    } else if (posMatch) {
      var pos = Math.min(parseInt(posMatch[1], 10), text.length);
      var prefix = text.slice(0, pos);
      var split = prefix.split("\n");
      line = split.length;
      col = split[split.length - 1].length + 1;
    }
    return { line: line, col: col, message: msg };
  }

  var toastTimer = null;
  function showToast(message) {
    var el = byId("toast");
    el.textContent = message;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.hidden = true;
    }, 2200);
  }

  function copyText(text, okMsg) {
    if (window.utools && typeof window.utools.copyText === "function") {
      try {
        window.utools.copyText(text);
        showToast(okMsg || "已复制到剪贴板");
        return;
      } catch (e) {
        // Fallback to navigator.clipboard below
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { showToast(okMsg || "已复制到剪贴板"); },
        function () { fallbackCopyText(text, okMsg); }
      );
    } else {
      fallbackCopyText(text, okMsg);
    }
  }

  function fallbackCopyText(text, okMsg) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.className = "offscreen-copy";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast(okMsg || "已复制到剪贴板");
    } catch (e) {
      showToast("复制受限，请手动选择复制");
    }
    document.body.removeChild(ta);
  }

  /* Pure decoder avoiding fetch() so connect-src 'none' is strictly respected */
  function dataUrlToBlob(dataUrl) {
    var commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) throw new Error("无效的 Data URL");
    var header = dataUrl.slice(0, commaIdx);
    var body = dataUrl.slice(commaIdx + 1);
    var mimeMatch = header.match(/^data:([^;]+)/i);
    var mime = mimeMatch ? mimeMatch[1].toLowerCase() : "application/octet-stream";
    if (/;base64/i.test(header)) {
      var binStr = atob(body.replace(/\s+/g, ""));
      var len = binStr.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) {
        bytes[i] = binStr.charCodeAt(i);
      }
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(body)], { type: mime });
  }

  function triggerDownloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function triggerDownloadText(text, filename) {
    var blob = new Blob([text], { type: "application/json;charset=utf-8" });
    triggerDownloadBlob(blob, filename);
    showToast("已导出 " + filename);
  }

  function triggerDownloadDataUrl(dataUrl, filename) {
    try {
      var blob = dataUrlToBlob(dataUrl);
      triggerDownloadBlob(blob, filename);
      showToast("已导出 " + filename);
    } catch (e) {
      showToast("导出失败: 图片数据异常");
    }
  }

  function convertBlobToPng(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth || 128;
        c.height = img.naturalHeight || 128;
        c.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) {
          if (b) resolve(b);
          else reject(new Error("PNG conversion failed"));
        }, "image/png");
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("Image load error"));
      };
      img.src = url;
    });
  }

  function copyImageFromDataUrl(dataUrl) {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      showToast("当前环境不支持图片剪贴板写入，请点击下载按钮");
      return;
    }
    Promise.resolve()
      .then(function () {
        var blob = dataUrlToBlob(dataUrl);
        if (blob.type === "image/png") return blob;
        return convertBlobToPng(blob);
      })
      .then(function (pngBlob) {
        return navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      })
      .then(function () {
        showToast("图片已复制到剪贴板");
      })
      .catch(function () {
        showToast("剪贴板写入图片受限，可直接点击下载保存");
      });
  }

  /* -----------------------------
     Synthesized Built-in Sample PNGs
  ----------------------------- */
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function createSampleImages() {
    var c1 = document.createElement("canvas");
    c1.width = 96;
    c1.height = 96;
    var g1 = c1.getContext("2d");
    g1.fillStyle = "#2d5a40";
    roundRectPath(g1, 4, 4, 88, 88, 20);
    g1.fill();
    g1.strokeStyle = "#79c496";
    g1.lineWidth = 4;
    roundRectPath(g1, 14, 14, 68, 68, 14);
    g1.stroke();
    g1.fillStyle = "#f4faf6";
    g1.font = "bold 36px ui-monospace, Consolas, monospace";
    g1.textAlign = "center";
    g1.textBaseline = "middle";
    g1.fillText("{ }", 48, 49);
    var badgeUrl = c1.toDataURL("image/png");

    var c2 = document.createElement("canvas");
    c2.width = 128;
    c2.height = 128;
    var g2 = c2.getContext("2d");
    var grad = g2.createLinearGradient(0, 0, 128, 128);
    grad.addColorStop(0, "#e3ece0");
    grad.addColorStop(1, "#c8dcc8");
    g2.fillStyle = grad;
    roundRectPath(g2, 0, 0, 128, 128, 28);
    g2.fill();
    g2.fillStyle = "#2d5a40";
    g2.beginPath();
    g2.arc(64, 48, 22, 0, Math.PI * 2);
    g2.fill();
    g2.beginPath();
    g2.arc(64, 114, 38, Math.PI, Math.PI * 2);
    g2.fill();
    var avatarUrl = c2.toDataURL("image/png");

    var c3 = document.createElement("canvas");
    c3.width = 12;
    c3.height = 12;
    var g3 = c3.getContext("2d");
    var grid = [
      "............",
      "......1111..",
      "....112221..",
      "...1223221..",
      "..1232221...",
      "..1223211...",
      "..122211....",
      "...1111.....",
      "..1.........",
      ".1..........",
      "............",
      "............"
    ];
    var pal = { "1": "#1f4e37", "2": "#4b8c63", "3": "#99d4ad" };
    for (var y = 0; y < 12; y++) {
      for (var x = 0; x < 12; x++) {
        var ch = grid[y].charAt(x);
        if (ch !== ".") {
          g3.fillStyle = pal[ch];
          g3.fillRect(x, y, 1, 1);
        }
      }
    }
    var leafUrl = c3.toDataURL("image/png");

    return {
      badge: { name: "qingxia-badge.png", mime: "image/png", width: 96, height: 96, dataUrl: badgeUrl },
      avatar: { name: "studio-avatar.png", mime: "image/png", width: 128, height: 128, dataUrl: avatarUrl },
      leaf: { name: "leaf-pixel-12x12.png", mime: "image/png", width: 12, height: 12, dataUrl: leafUrl }
    };
  }

  /* -----------------------------
     App State & Theme
  ----------------------------- */
  var samples = createSampleImages();
  var state = {
    activeTab: "format",
    theme: "light",
    fmt: {
      indent: "2",
      viewMode: "code",
      parsed: null,
      valid: true,
      formatted: "",
      lastErrorLine: 1
    },
    i2j: {
      images: [],
      selectedId: null,
      mode: "base64",
      gridSize: 16,
      rawJson: "",
      foldJson: ""
    },
    j2i: {
      mode: "decode",
      detected: [],
      selectedIdx: 0,
      bg: "checker",
      zoom: "fit"
    }
  };

  function updateGlobalStatus(text, tone) {
    var el = byId("global-status");
    el.textContent = text;
    el.className = "status-chip" + (tone ? " " + tone : "");
  }

  function loadInitialTheme() {
    try {
      var saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {
      // Ignore storage errors
    }
    return "light";
  }

  function setTheme(theme) {
    state.theme = theme;
    document.body.setAttribute("data-theme", theme);
    var iconUse = byId("in-plugin-theme-icon").querySelector("use");
    iconUse.setAttribute("href", theme === "light" ? "#ic-moon" : "#ic-sun");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (e) {
      // Ignore storage errors
    }
  }

  function switchTab(tabId) {
    state.activeTab = tabId;
    var tabs = ["format", "img2json", "json2img"];
    tabs.forEach(function (t) {
      var btn = byId("tab-" + t);
      var panel = byId("panel-" + t);
      var active = t === tabId;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
      panel.hidden = !active;
    });
    syncHeaderStatusForActiveTab();
  }

  function syncHeaderStatusForActiveTab() {
    if (state.activeTab === "format") {
      var raw = byId("fmt-input").value.trim();
      if (!raw) updateGlobalStatus("等待输入", "");
      else if (state.fmt.valid) updateGlobalStatus("JSON 有效", "is-ok");
      else updateGlobalStatus("语法错误", "is-err");
    } else if (state.activeTab === "img2json") {
      if (state.i2j.images.length === 0) updateGlobalStatus("就绪", "");
      else updateGlobalStatus("已编码 " + state.i2j.images.length + " 张图", "is-ok");
    } else if (state.activeTab === "json2img") {
      if (state.j2i.mode === "card") {
        updateGlobalStatus("图卡模式", "is-ok");
      } else if (state.j2i.detected.length > 0) {
        updateGlobalStatus("已提取 " + state.j2i.detected.length + " 张图", "is-ok");
      } else if (!byId("j2i-input").value.trim()) {
        updateGlobalStatus("等待输入", "");
      } else {
        updateGlobalStatus("未检出图片", "is-warn");
      }
    }
  }

  byId("in-plugin-theme-toggle").addEventListener("click", function () {
    setTheme(state.theme === "light" ? "dark" : "light");
  });

  ["format", "img2json", "json2img"].forEach(function (t) {
    byId("tab-" + t).addEventListener("click", function () { switchTab(t); });
  });

  /* -----------------------------
     TAB 1: JSON Formatter Logic
  ----------------------------- */
  var SAMPLE_FMT_JSON = {
    plugin: {
      id: "com.qingxia.json-workshop",
      name: "JSON 工坊",
      category: "开发效率",
      offlineReady: true
    },
    capabilities: [
      { code: "format", label: "格式化与树形检视", shortcuts: ["Ctrl+Enter", "Ctrl+Shift+M"] },
      { code: "img2json", label: "图片转 JSON", supportsPixelGrid: true },
      { code: "json2img", label: "JSON 转图片", maxCardScale: 3 }
    ],
    telemetry: {
      avgParseMs: 1.8,
      sampleCount: 42,
      lastCheckedAt: "2026-11-25T15:20:00Z",
      deprecatedNote: null
    }
  };

  function getIndentUnit() {
    if (state.fmt.indent === "4") return "    ";
    if (state.fmt.indent === "tab") return "\t";
    return "  ";
  }

  function runFmtUpdate(overrideOutput) {
    var inputEl = byId("fmt-input");
    var raw = inputEl.value;

    var trimmed = raw.trim();
    var errBanner = byId("fmt-error");
    var emptyEl = byId("fmt-empty");
    var codeView = byId("fmt-code-view");
    var treeView = byId("fmt-tree-view");

    if (!trimmed) {
      state.fmt.valid = true;
      state.fmt.parsed = null;
      state.fmt.formatted = "";
      errBanner.hidden = true;
      emptyEl.hidden = false;
      codeView.hidden = true;
      treeView.hidden = true;
      byId("fmt-stat-nodes").textContent = "0 节点";
      byId("fmt-stat-depth").textContent = "深度 0";
      byId("fmt-stat-size").textContent = "0 B";
      if (state.activeTab === "format") updateGlobalStatus("等待输入", "");
      return;
    }

    try {
      var parsed = JSON.parse(trimmed);
      state.fmt.valid = true;
      state.fmt.parsed = parsed;
      errBanner.hidden = true;
      emptyEl.hidden = true;

      var outputStr = typeof overrideOutput === "string"
        ? overrideOutput
        : JSON.stringify(parsed, null, getIndentUnit());
      state.fmt.formatted = outputStr;

      var metrics = computeJsonMetrics(parsed);
      byId("fmt-stat-nodes").textContent = metrics.nodes + " 节点";
      byId("fmt-stat-depth").textContent = "深度 " + metrics.depth;
      byId("fmt-stat-size").textContent = formatBytes(byteLength(outputStr));

      renderCodeLines(byId("fmt-out-code"), outputStr, true);
      renderTreeView(parsed);

      codeView.hidden = state.fmt.viewMode !== "code";
      treeView.hidden = state.fmt.viewMode !== "tree";
      if (state.activeTab === "format") updateGlobalStatus("JSON 有效", "is-ok");
    } catch (err) {
      state.fmt.valid = false;
      var loc = parseJsonErrorLocation(raw, err);
      state.fmt.lastErrorLine = loc.line;
      byId("fmt-error-text").textContent = "第 " + loc.line + " 行, 第 " + loc.col + " 列: " + loc.message;
      errBanner.hidden = false;

      if (typeof overrideOutput === "string") {
        emptyEl.hidden = true;
        state.fmt.formatted = overrideOutput;
        renderCodeLines(byId("fmt-out-code"), overrideOutput, false);
        codeView.hidden = false;
        treeView.hidden = true;
      }
      if (state.activeTab === "format") updateGlobalStatus("语法错误", "is-err");
    }
  }

  function renderTreeView(data) {
    var container = byId("fmt-tree-container");
    container.innerHTML = "";
    container.appendChild(createTreeNode("$", data, "$", true));
  }

  function createTreeNode(keyLabel, value, jsonPath, isRoot) {
    var isArr = Array.isArray(value);
    var isObj = value !== null && typeof value === "object";
    var node = document.createElement("div");
    node.className = "tree-node" + (isRoot ? " is-root" : "");

    var row = document.createElement("div");
    row.className = "tree-row";
    row.title = "点击复制路径: " + jsonPath;

    if (isObj) {
      var keys = Object.keys(value);
      var toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "tree-toggle";
      toggle.setAttribute("aria-label", "展开或折叠节点");
      toggle.innerHTML = '<svg class="icon"><use href="#ic-chevron-down" /></svg>';
      toggle.addEventListener("click", function (ev) {
        ev.stopPropagation();
        node.classList.toggle("is-collapsed");
      });
      row.appendChild(toggle);

      var kSpan = document.createElement("span");
      kSpan.className = "syn-key";
      kSpan.textContent = isRoot ? "root" : '"' + keyLabel + '"';
      row.appendChild(kSpan);

      var tag = document.createElement("span");
      tag.className = "tree-tag";
      tag.textContent = isArr ? "Array[" + keys.length + "]" : "Object{" + keys.length + "}";
      row.appendChild(tag);

      row.addEventListener("click", function () {
        copyText(jsonPath, "已复制路径: " + jsonPath);
      });
      node.appendChild(row);

      var childrenWrap = document.createElement("div");
      childrenWrap.className = "tree-children";
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var childPath = isArr ? jsonPath + "[" + k + "]" : jsonPath + "." + k;
        childrenWrap.appendChild(createTreeNode(k, value[k], childPath, false));
      }
      node.appendChild(childrenWrap);
    } else {
      var spacer = document.createElement("span");
      spacer.className = "tree-spacer";
      row.appendChild(spacer);

      var keyEl = document.createElement("span");
      keyEl.className = "syn-key";
      keyEl.textContent = '"' + keyLabel + '"';
      row.appendChild(keyEl);

      var colon = document.createElement("span");
      colon.className = "syn-punct";
      colon.textContent = ":";
      row.appendChild(colon);

      var valEl = document.createElement("span");
      valEl.className = "tree-val ";
      if (value === null) {
        valEl.className += "syn-null";
        valEl.textContent = "null";
      } else if (typeof value === "boolean") {
        valEl.className += "syn-bool";
        valEl.textContent = String(value);
      } else if (typeof value === "number") {
        valEl.className += "syn-num";
        valEl.textContent = String(value);
      } else {
        valEl.className += "syn-str";
        var strDisplay = JSON.stringify(value);
        valEl.textContent = strDisplay.length > 84 ? strDisplay.slice(0, 81) + '..."' : strDisplay;
      }
      row.appendChild(valEl);

      row.addEventListener("click", function () {
        copyText(jsonPath, "已复制路径: " + jsonPath);
      });
      node.appendChild(row);
    }
    return node;
  }

  function attachJsonFileDrop(textarea, onLoaded) {
    textarea.addEventListener("dragover", function (ev) {
      ev.preventDefault();
      textarea.classList.add("is-dragover");
    });
    textarea.addEventListener("dragleave", function () {
      textarea.classList.remove("is-dragover");
    });
    textarea.addEventListener("drop", function (ev) {
      var files = ev.dataTransfer && ev.dataTransfer.files;
      if (!files || !files.length) return;
      ev.preventDefault();
      textarea.classList.remove("is-dragover");
      var file = files[0];
      var reader = new FileReader();
      reader.onload = function () {
        textarea.value = String(reader.result || "");
        onLoaded();
        showToast("已载入 " + file.name);
      };
      reader.readAsText(file);
    });
  }

  function triggerFormatAction() {
    runFmtUpdate();
    if (state.fmt.valid && state.fmt.formatted) {
      byId("fmt-input").value = state.fmt.formatted;
      runFmtUpdate();
      showToast("已完成格式化");
    }
  }

  function triggerMinifyAction() {
    if (!state.fmt.valid || state.fmt.parsed === null) return;
    var min = JSON.stringify(state.fmt.parsed);
    byId("fmt-input").value = min;
    runFmtUpdate(min);
    showToast("已压缩为单行 JSON");
  }

  byId("fmt-input").addEventListener("input", function () { runFmtUpdate(); });
  byId("fmt-input").addEventListener("keydown", function (ev) {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
      ev.preventDefault();
      triggerFormatAction();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === "m") {
      ev.preventDefault();
      triggerMinifyAction();
    }
  });
  attachJsonFileDrop(byId("fmt-input"), function () { runFmtUpdate(); });

  byId("fmt-btn-format").addEventListener("click", triggerFormatAction);
  byId("fmt-btn-minify").addEventListener("click", triggerMinifyAction);

  byId("fmt-btn-sort").addEventListener("click", function () {
    if (!state.fmt.valid || state.fmt.parsed === null) return;
    var sorted = JSON.stringify(sortKeysDeep(state.fmt.parsed), null, getIndentUnit());
    byId("fmt-input").value = sorted;
    runFmtUpdate(sorted);
    showToast("已按键名字母序重排");
  });

  byId("fmt-btn-escape").addEventListener("click", function () {
    var raw = byId("fmt-input").value;
    if (!raw.trim()) return;
    var escapedStr = JSON.stringify(raw);
    runFmtUpdate(escapedStr);
    showToast("已生成转义字符串");
  });

  byId("fmt-btn-unescape").addEventListener("click", function () {
    var raw = byId("fmt-input").value.trim();
    if (!raw) return;
    try {
      var first = JSON.parse(raw);
      if (typeof first === "string") {
        byId("fmt-input").value = first;
        runFmtUpdate();
        showToast("已去除外层转义");
      } else {
        showToast("当前内容不是转义 JSON 字符串");
      }
    } catch (e) {
      showToast("无法去转义: 请先检查引号与转义符");
    }
  });

  ["fmt-indent-2", "fmt-indent-4", "fmt-indent-tab"].forEach(function (id) {
    byId(id).addEventListener("click", function () {
      state.fmt.indent = this.getAttribute("data-indent");
      ["fmt-indent-2", "fmt-indent-4", "fmt-indent-tab"].forEach(function (other) {
        byId(other).setAttribute("aria-pressed", String(other === id));
      });
      runFmtUpdate();
    });
  });

  byId("fmt-view-code").addEventListener("click", function () {
    state.fmt.viewMode = "code";
    byId("fmt-view-code").setAttribute("aria-pressed", "true");
    byId("fmt-view-tree").setAttribute("aria-pressed", "false");
    runFmtUpdate();
  });

  byId("fmt-view-tree").addEventListener("click", function () {
    state.fmt.viewMode = "tree";
    byId("fmt-view-code").setAttribute("aria-pressed", "false");
    byId("fmt-view-tree").setAttribute("aria-pressed", "true");
    runFmtUpdate();
  });

  byId("fmt-tree-expand").addEventListener("click", function () {
    var nodes = byId("fmt-tree-container").querySelectorAll(".tree-node.is-collapsed");
    nodes.forEach(function (n) { n.classList.remove("is-collapsed"); });
  });

  byId("fmt-tree-collapse").addEventListener("click", function () {
    var nodes = byId("fmt-tree-container").querySelectorAll(".tree-node:not(.is-root)");
    nodes.forEach(function (n) {
      if (n.querySelector(".tree-children")) n.classList.add("is-collapsed");
    });
  });

  byId("fmt-btn-locate").addEventListener("click", function () {
    var ta = byId("fmt-input");
    var lines = ta.value.split("\n");
    var targetLine = Math.max(1, Math.min(state.fmt.lastErrorLine, lines.length));
    var start = 0;
    for (var i = 0; i < targetLine - 1; i++) {
      start += lines[i].length + 1;
    }
    var end = start + lines[targetLine - 1].length;
    ta.focus();
    ta.setSelectionRange(start, end);
  });

  byId("fmt-btn-sample").addEventListener("click", function () {
    byId("fmt-input").value = JSON.stringify(SAMPLE_FMT_JSON, null, getIndentUnit());
    runFmtUpdate();
    showToast("已载入示例 JSON");
  });

  byId("fmt-btn-clear").addEventListener("click", function () {
    byId("fmt-input").value = "";
    runFmtUpdate();
  });

  byId("fmt-btn-paste").addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (txt) {
        if (txt) {
          byId("fmt-input").value = txt;
          runFmtUpdate();
        }
      }).catch(function () {
        showToast("请直接在左侧编辑框按 Ctrl+V 粘贴");
        byId("fmt-input").focus();
      });
    } else {
      byId("fmt-input").focus();
      showToast("请直接在左侧编辑框按 Ctrl+V 粘贴");
    }
  });

  byId("fmt-btn-open").addEventListener("click", function () {
    byId("fmt-file").click();
  });

  byId("fmt-file").addEventListener("change", function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      byId("fmt-input").value = String(reader.result || "");
      runFmtUpdate();
      showToast("已载入 " + file.name);
    };
    reader.readAsText(file);
    this.value = "";
  });

  byId("fmt-btn-copy").addEventListener("click", function () {
    if (!state.fmt.formatted) return;
    copyText(state.fmt.formatted, "已复制结果 JSON");
  });

  byId("fmt-btn-download").addEventListener("click", function () {
    if (!state.fmt.formatted) return;
    triggerDownloadText(state.fmt.formatted, "formatted.json");
  });

  /* -----------------------------
     TAB 2: Image to JSON Logic
  ----------------------------- */
  function loadImageEntry(name, mime, origBytes, dataUrl) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        resolve({
          id: "img_" + Math.random().toString(36).slice(2, 9),
          name: name,
          mime: mime,
          origBytes: origBytes,
          width: img.naturalWidth || 64,
          height: img.naturalHeight || 64,
          dataUrl: dataUrl,
          imgEl: img
        });
      };
      img.src = dataUrl;
    });
  }

  function addImagesFromFiles(fileList) {
    var tasks = [];
    for (var i = 0; i < fileList.length; i++) {
      (function (file) {
        if (!file.type || file.type.indexOf("image/") !== 0) return;
        tasks.push(
          new Promise(function (resolve) {
            var reader = new FileReader();
            reader.onload = function () {
              var fname = file.name || ("pasted-" + Date.now() + "." + (file.type.split("/")[1] || "png"));
              loadImageEntry(fname, file.type || "image/png", file.size, String(reader.result)).then(resolve);
            };
            reader.readAsDataURL(file);
          })
        );
      })(fileList[i]);
    }
    if (!tasks.length) return;
    Promise.all(tasks).then(function (entries) {
      state.i2j.images = state.i2j.images.concat(entries);
      state.i2j.selectedId = entries[entries.length - 1].id;
      renderI2JImageList();
      generateI2JJson();
    });
  }

  function addBuiltInSample(sampleObj) {
    var rawBytes = Math.round((sampleObj.dataUrl.split(",")[1] || "").length * 0.75);
    loadImageEntry(sampleObj.name, sampleObj.mime, rawBytes, sampleObj.dataUrl).then(function (entry) {
      var existing = state.i2j.images.find(function (it) { return it.name === entry.name; });
      if (existing) {
        state.i2j.selectedId = existing.id;
      } else {
        state.i2j.images.push(entry);
        state.i2j.selectedId = entry.id;
      }
      renderI2JImageList();
      generateI2JJson();
    });
  }

  function renderI2JImageList() {
    var listEl = byId("img-list");
    listEl.innerHTML = "";
    state.i2j.images.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "img-item" + (item.id === state.i2j.selectedId ? " is-selected" : "");
      row.addEventListener("click", function () {
        state.i2j.selectedId = item.id;
        renderI2JImageList();
        if (state.i2j.mode === "pixel") generateI2JJson();
      });

      var img = document.createElement("img");
      img.className = "img-thumb thumb-checker";
      img.src = item.dataUrl;
      img.alt = item.name;
      row.appendChild(img);

      var meta = document.createElement("div");
      meta.className = "img-item-meta";
      var title = document.createElement("div");
      title.className = "img-item-name";
      title.textContent = item.name;
      var sub = document.createElement("div");
      sub.className = "img-item-sub";
      sub.textContent = item.width + "x" + item.height + " | " + item.mime.replace("image/", "").toUpperCase() + " | " + formatBytes(item.origBytes);
      meta.appendChild(title);
      meta.appendChild(sub);
      row.appendChild(meta);

      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "icon-btn icon-btn-sm";
      delBtn.setAttribute("aria-label", "移除图片 " + item.name);
      delBtn.innerHTML = '<svg class="icon icon-xs"><use href="#ic-trash" /></svg>';
      delBtn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        state.i2j.images = state.i2j.images.filter(function (x) { return x.id !== item.id; });
        if (state.i2j.selectedId === item.id) {
          state.i2j.selectedId = state.i2j.images.length ? state.i2j.images[0].id : null;
        }
        renderI2JImageList();
        generateI2JJson();
      });
      row.appendChild(delBtn);

      listEl.appendChild(row);
    });
    if (state.activeTab === "img2json") syncHeaderStatusForActiveTab();
  }

  function reencodeImage(item, targetMime, maxDim, quality) {
    var needResize = maxDim > 0 && (item.width > maxDim || item.height > maxDim);
    var needReencode = targetMime !== "original" && targetMime !== item.mime;
    if (!needResize && !needReencode) {
      return {
        mime: item.mime,
        width: item.width,
        height: item.height,
        dataUrl: item.dataUrl
      };
    }
    var outMime = targetMime === "original" ? (item.mime === "image/svg+xml" ? "image/png" : item.mime) : targetMime;
    var w = item.width;
    var h = item.height;
    if (needResize) {
      var scale = maxDim / Math.max(w, h);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }
    var c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    var ctx = c.getContext("2d");
    if (outMime === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(item.imgEl, 0, 0, w, h);
    return {
      mime: outMime,
      width: w,
      height: h,
      dataUrl: c.toDataURL(outMime, quality)
    };
  }

  function findNearestPaletteIdx(palette, r, g, b) {
    var best = 0;
    var bestDist = Infinity;
    for (var i = 0; i < palette.length; i++) {
      var p = palette[i];
      if (p === "transparent") continue;
      var pr = parseInt(p.slice(1, 3), 16);
      var pg = parseInt(p.slice(3, 5), 16);
      var pb = parseInt(p.slice(5, 7), 16);
      var d = (pr - r) * (pr - r) + (pg - g) * (pg - g) + (pb - b) * (pb - b);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  function encodePixelGrid(item, size) {
    var c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    var ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = size >= 16;
    ctx.drawImage(item.imgEl, 0, 0, size, size);
    var imgData = ctx.getImageData(0, 0, size, size).data;

    var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    var colorMap = Object.create(null);
    var palette = [];
    var rows = [];

    function quantizeChannel(v) {
      return Math.min(255, Math.round(v / 17) * 17);
    }

    function toHex(r, g, b, a) {
      if (a < 40) return "transparent";
      function h2(n) { return n.toString(16).padStart(2, "0"); }
      return "#" + h2(quantizeChannel(r)) + h2(quantizeChannel(g)) + h2(quantizeChannel(b));
    }

    for (var y = 0; y < size; y++) {
      var rowStr = "";
      for (var x = 0; x < size; x++) {
        var idx = (y * size + x) * 4;
        var hex = toHex(imgData[idx], imgData[idx + 1], imgData[idx + 2], imgData[idx + 3]);
        var palIdx = colorMap[hex];
        if (palIdx === undefined) {
          if (palette.length >= chars.length) {
            palIdx = findNearestPaletteIdx(palette, imgData[idx], imgData[idx + 1], imgData[idx + 2]);
          } else {
            palIdx = palette.length;
            palette.push(hex);
            colorMap[hex] = palIdx;
          }
        }
        rowStr += chars.charAt(palIdx);
      }
      rows.push(rowStr);
    }

    return {
      type: "pixel-grid",
      name: item.name,
      width: size,
      height: size,
      palette: palette,
      rows: rows
    };
  }

  function foldLongBase64(obj) {
    if (typeof obj === "string") {
      if (obj.length > 110 && (/^data:image\//.test(obj) || /^[A-Za-z0-9+/=]{96,}$/.test(obj))) {
        return obj.slice(0, 64) + "...[" + (obj.length - 64) + " chars omitted in preview]";
      }
      return obj;
    }
    if (Array.isArray(obj)) return obj.map(foldLongBase64);
    if (obj && typeof obj === "object") {
      var copy = {};
      Object.keys(obj).forEach(function (k) { copy[k] = foldLongBase64(obj[k]); });
      return copy;
    }
    return obj;
  }

  function generateI2JJson() {
    var emptyEl = byId("i2j-empty");
    var skelEl = byId("i2j-skeleton");
    var wrapEl = byId("i2j-output-wrap");

    if (state.i2j.images.length === 0) {
      state.i2j.rawJson = "";
      state.i2j.foldJson = "";
      emptyEl.hidden = false;
      skelEl.hidden = true;
      wrapEl.hidden = true;
      byId("i2j-stat-size").textContent = "0 B";
      byId("i2j-stat-extra").textContent = "等待载入";
      if (state.activeTab === "img2json") updateGlobalStatus("就绪", "");
      return;
    }

    emptyEl.hidden = true;
    skelEl.hidden = false;
    wrapEl.hidden = true;

    setTimeout(function () {
      var payload;
      var extraStat = "";

      if (state.i2j.mode === "base64") {
        var structure = byId("i2j-structure").value;
        var targetMime = byId("i2j-mime").value;
        var maxDim = parseInt(byId("i2j-resize").value, 10);
        var quality = parseFloat(byId("i2j-quality").value);
        var keepPrefix = byId("i2j-keep-prefix").checked;

        var totalOrig = 0;
        var encodedList = state.i2j.images.map(function (it) {
          totalOrig += it.origBytes;
          var res = reencodeImage(it, targetMime, maxDim, quality);
          var b64Only = res.dataUrl.split(",")[1] || "";
          var finalData = keepPrefix ? res.dataUrl : b64Only;
          return {
            name: it.name,
            mime: res.mime,
            width: res.width,
            height: res.height,
            bytes: Math.round(b64Only.length * 0.75),
            dataUrl: finalData,
            base64: b64Only
          };
        });

        if (structure === "dict") {
          payload = {};
          encodedList.forEach(function (e) {
            payload[e.name] = e.dataUrl;
          });
        } else if (structure === "raw") {
          var rawItems = encodedList.map(function (e) {
            return { name: e.name, mime: e.mime, base64: e.base64 };
          });
          payload = rawItems.length === 1 ? rawItems[0] : rawItems;
        } else {
          var objItems = encodedList.map(function (e) {
            return {
              name: e.name,
              mime: e.mime,
              width: e.width,
              height: e.height,
              bytes: e.bytes,
              dataUrl: e.dataUrl
            };
          });
          payload = objItems.length === 1 ? objItems[0] : objItems;
        }

        var jsonBytes = byteLength(JSON.stringify(payload, null, 2));
        var ratio = totalOrig > 0 ? Math.round((jsonBytes / totalOrig) * 100) : 100;
        extraStat = "体积比 " + ratio + "%";
      } else {
        var activeImg = state.i2j.images.find(function (it) { return it.id === state.i2j.selectedId; }) || state.i2j.images[0];
        payload = encodePixelGrid(activeImg, state.i2j.gridSize);
        extraStat = payload.palette.length + " 色调色板";
      }

      state.i2j.rawJson = JSON.stringify(payload, null, 2);
      state.i2j.foldJson = JSON.stringify(foldLongBase64(payload), null, 2);

      byId("i2j-stat-size").textContent = formatBytes(byteLength(state.i2j.rawJson));
      byId("i2j-stat-extra").textContent = extraStat;
      renderI2JPreviewText();

      skelEl.hidden = true;
      wrapEl.hidden = false;
      if (state.activeTab === "img2json") syncHeaderStatusForActiveTab();
    }, 60);
  }

  function renderI2JPreviewText() {
    var folded = byId("i2j-fold-b64").checked;
    var text = folded ? state.i2j.foldJson : state.i2j.rawJson;
    renderCodeLines(byId("i2j-out-code"), text, true);
  }

  var dropzone = byId("img-dropzone");
  dropzone.addEventListener("click", function () { byId("img-file-input").click(); });
  dropzone.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      byId("img-file-input").click();
    }
  });
  dropzone.addEventListener("dragover", function (ev) {
    ev.preventDefault();
    dropzone.classList.add("is-dragover");
  });
  dropzone.addEventListener("dragleave", function () {
    dropzone.classList.remove("is-dragover");
  });
  dropzone.addEventListener("drop", function (ev) {
    ev.preventDefault();
    dropzone.classList.remove("is-dragover");
    if (ev.dataTransfer && ev.dataTransfer.files) {
      addImagesFromFiles(ev.dataTransfer.files);
    }
  });
  byId("img-file-input").addEventListener("change", function () {
    if (this.files && this.files.length) addImagesFromFiles(this.files);
    this.value = "";
  });

  document.addEventListener("paste", function (ev) {
    if (state.activeTab !== "img2json") return;
    var dt = ev.clipboardData;
    if (!dt || !dt.items) return;
    var imageFiles = [];
    for (var i = 0; i < dt.items.length; i++) {
      var item = dt.items[i];
      if (item.kind === "file" && item.type && item.type.indexOf("image/") === 0) {
        var f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length > 0) {
      ev.preventDefault();
      addImagesFromFiles(imageFiles);
      showToast("已从剪贴板载入 " + imageFiles.length + " 张图片");
    }
  });

  byId("img-sample-badge").addEventListener("click", function () { addBuiltInSample(samples.badge); });
  byId("img-sample-avatar").addEventListener("click", function () { addBuiltInSample(samples.avatar); });
  byId("img-sample-pixel").addEventListener("click", function () { addBuiltInSample(samples.leaf); });

  byId("i2j-btn-clear").addEventListener("click", function () {
    state.i2j.images = [];
    state.i2j.selectedId = null;
    renderI2JImageList();
    generateI2JJson();
  });

  byId("i2j-mode-base64").addEventListener("click", function () {
    state.i2j.mode = "base64";
    byId("i2j-mode-base64").setAttribute("aria-pressed", "true");
    byId("i2j-mode-pixel").setAttribute("aria-pressed", "false");
    byId("i2j-base64-opts").hidden = false;
    byId("i2j-pixel-opts").hidden = true;
    generateI2JJson();
  });

  byId("i2j-mode-pixel").addEventListener("click", function () {
    state.i2j.mode = "pixel";
    byId("i2j-mode-base64").setAttribute("aria-pressed", "false");
    byId("i2j-mode-pixel").setAttribute("aria-pressed", "true");
    byId("i2j-base64-opts").hidden = true;
    byId("i2j-pixel-opts").hidden = false;
    generateI2JJson();
  });

  ["i2j-structure", "i2j-mime", "i2j-resize", "i2j-keep-prefix"].forEach(function (id) {
    byId(id).addEventListener("change", function () {
      var mimeVal = byId("i2j-mime").value;
      byId("i2j-quality").disabled = (mimeVal === "image/png" || mimeVal === "original");
      generateI2JJson();
    });
  });

  byId("i2j-quality").addEventListener("input", function () {
    byId("i2j-quality-val").textContent = Math.round(parseFloat(this.value) * 100) + "%";
  });
  byId("i2j-quality").addEventListener("change", generateI2JJson);

  document.querySelectorAll(".i2j-grid-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.i2j.gridSize = parseInt(this.getAttribute("data-grid"), 10);
      document.querySelectorAll(".i2j-grid-btn").forEach(function (other) {
        other.setAttribute("aria-pressed", String(other === btn));
      });
      generateI2JJson();
    });
  });

  byId("i2j-fold-b64").addEventListener("change", renderI2JPreviewText);

  byId("i2j-btn-copy").addEventListener("click", function () {
    if (!state.i2j.rawJson) return;
    copyText(state.i2j.rawJson, "已复制完整 JSON 数据");
  });

  byId("i2j-btn-download").addEventListener("click", function () {
    if (!state.i2j.rawJson) return;
    triggerDownloadText(state.i2j.rawJson, "image-data.json");
  });

  byId("i2j-btn-to-fmt").addEventListener("click", function () {
    if (!state.i2j.rawJson) return;
    byId("fmt-input").value = state.i2j.rawJson;
    switchTab("format");
    runFmtUpdate();
    showToast("已发送至 JSON 格式化");
  });

  byId("i2j-btn-to-j2i").addEventListener("click", function () {
    if (!state.i2j.rawJson) return;
    byId("j2i-input").value = state.i2j.rawJson;
    switchTab("json2img");
    setJ2IMode("decode");
    runJ2IParse();
    showToast("已发送至 JSON 转图片并自动还原");
  });

  /* -----------------------------
     TAB 3: JSON to Image Logic
  ----------------------------- */
  function guessMimeFromRawBase64(b64) {
    if (b64.indexOf("iVBORw0") === 0) return "image/png";
    if (b64.indexOf("/9j/") === 0) return "image/jpeg";
    if (b64.indexOf("R0lGOD") === 0) return "image/gif";
    if (b64.indexOf("UklGR") === 0) return "image/webp";
    if (b64.indexOf("PHN2Zy") === 0) return "image/svg+xml";
    return null;
  }

  function renderPixelGridToDataUrl(obj) {
    var w = Number(obj.width);
    var h = Number(obj.height);
    var palette = obj.palette;
    var rows = obj.rows;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w > 128 || h > 128) return null;
    if (!Array.isArray(palette) || !Array.isArray(rows) || rows.length < h) return null;

    var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    var scale = Math.max(8, Math.floor(192 / Math.max(w, h)));
    var c = document.createElement("canvas");
    c.width = w * scale;
    c.height = h * scale;
    var ctx = c.getContext("2d");

    for (var y = 0; y < h; y++) {
      var row = String(rows[y] || "");
      for (var x = 0; x < w; x++) {
        var ch = row.charAt(x);
        var idx = chars.indexOf(ch);
        if (idx >= 0 && idx < palette.length) {
          var color = palette[idx];
          if (color && color !== "transparent") {
            ctx.fillStyle = color;
            ctx.fillRect(x * scale, y * scale, scale, scale);
          }
        }
      }
    }
    return {
      dataUrl: c.toDataURL("image/png"),
      width: c.width,
      height: c.height,
      gridW: w,
      gridH: h
    };
  }

  function extractImagesFromJson(root) {
    var found = [];
    function walk(val, path) {
      if (typeof val === "string") {
        var trimmed = val.trim();
        var dataMatch = trimmed.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml|bmp|x-icon|avif));base64,([A-Za-z0-9+/=\s]+)$/i);
        if (dataMatch) {
          var normMime = dataMatch[1].toLowerCase() === "image/jpg" ? "image/jpeg" : dataMatch[1].toLowerCase();
          var cleanB64 = dataMatch[2].replace(/\s+/g, "");
          found.push({
            kind: "dataUrl",
            path: path,
            mime: normMime,
            dataUrl: "data:" + normMime + ";base64," + cleanB64,
            bytes: Math.round(cleanB64.length * 0.75)
          });
          return;
        }
        var compact = trimmed.replace(/\s+/g, "");
        if (compact.length >= 24 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
          var guessed = guessMimeFromRawBase64(compact);
          if (guessed) {
            found.push({
              kind: "base64",
              path: path,
              mime: guessed,
              dataUrl: "data:" + guessed + ";base64," + compact,
              bytes: Math.round(compact.length * 0.75)
            });
          }
        }
      } else if (Array.isArray(val)) {
        for (var i = 0; i < val.length; i++) walk(val[i], path + "[" + i + "]");
      } else if (val && typeof val === "object") {
        if (val.type === "pixel-grid" && Array.isArray(val.palette) && Array.isArray(val.rows)) {
          var px = renderPixelGridToDataUrl(val);
          if (px) {
            found.push({
              kind: "pixel",
              path: path,
              mime: "image/png",
              dataUrl: px.dataUrl,
              gridInfo: px.gridW + "x" + px.gridH + " 网格",
              bytes: Math.round((px.dataUrl.split(",")[1] || "").length * 0.75)
            });
            return;
          }
        }
        Object.keys(val).forEach(function (k) {
          walk(val[k], path + "." + k);
        });
      }
    }
    walk(root, "$");
    return found;
  }

  function setJ2IMode(mode) {
    state.j2i.mode = mode;
    byId("j2i-mode-decode").setAttribute("aria-pressed", String(mode === "decode"));
    byId("j2i-mode-card").setAttribute("aria-pressed", String(mode === "card"));
    byId("j2i-decode-pane").hidden = mode !== "decode";
    byId("j2i-card-pane").hidden = mode !== "card";
    byId("j2i-mode-tag").textContent = mode === "decode" ? "还原模式" : "图卡模式";
    if (mode === "card") renderJ2ICodeCard();
    if (state.activeTab === "json2img") syncHeaderStatusForActiveTab();
  }

  function setJ2IStatus(toneClass, iconHref, text) {
    byId("j2i-status-banner").className = toneClass;
    byId("j2i-status-icon").querySelector("use").setAttribute("href", iconHref);
    byId("j2i-status-text").textContent = text;
  }

  function runJ2IParse() {
    var raw = byId("j2i-input").value;

    if (!raw.trim()) {
      state.j2i.detected = [];
      setJ2IStatus("diag-banner is-warn", "#ic-alert", "等待输入 JSON 内容");
      renderJ2IDecodePane();
      if (state.j2i.mode === "card") renderJ2ICodeCard();
      if (state.activeTab === "json2img") syncHeaderStatusForActiveTab();
      return;
    }

    try {
      var parsed = JSON.parse(raw);
      var list = extractImagesFromJson(parsed);
      state.j2i.detected = list;
      state.j2i.selectedIdx = 0;

      if (list.length > 0) {
        setJ2IStatus("diag-banner is-ok", "#ic-check", "已识别 " + list.length + " 个可还原图片源");
      } else {
        setJ2IStatus("diag-banner is-warn", "#ic-alert", "JSON 合法，未包含 Base64 图片或 pixel-grid 字段 (可切换图卡模式)");
      }
      renderJ2IDecodePane();
      if (state.j2i.mode === "card") renderJ2ICodeCard();
    } catch (err) {
      var fallbackList = extractImagesFromRawText(raw);
      if (fallbackList.length > 0) {
        state.j2i.detected = fallbackList;
        state.j2i.selectedIdx = 0;
        setJ2IStatus("diag-banner is-ok", "#ic-check", "已识别 " + fallbackList.length + " 个图片数据");
        renderJ2IDecodePane();
        if (state.j2i.mode === "card") renderJ2ICodeCard();
      } else {
        state.j2i.detected = [];
        var loc = parseJsonErrorLocation(raw, err);
        setJ2IStatus("diag-banner", "#ic-alert", "第 " + loc.line + " 行语法错误: " + loc.message);
        renderJ2IDecodePane();
        if (state.j2i.mode === "card") renderJ2ICodeCard();
      }
    }
    if (state.activeTab === "json2img") syncHeaderStatusForActiveTab();
  }

  function extractImagesFromRawText(raw) {
    var trimmed = raw.trim().replace(/,$/, "").trim();
    if (!trimmed) return [];

    // 1. Single key-value pair snippet, e.g. "dataUrl": "data:image/png;base64,..."
    try {
      var wrapped = JSON.parse("{" + trimmed + "}");
      var propList = extractImagesFromJson(wrapped);
      if (propList.length > 0) return propList;
    } catch (e) {
      // Fall through to direct string detection
    }

    // 2. Quoted or unquoted direct DataURL / raw Base64 string
    var candidate = trimmed;
    if (
      (candidate.charAt(0) === '"' && candidate.charAt(candidate.length - 1) === '"') ||
      (candidate.charAt(0) === "'" && candidate.charAt(candidate.length - 1) === "'")
    ) {
      candidate = candidate.slice(1, -1).trim();
    }
    var directList = extractImagesFromJson(candidate);
    if (directList.length > 0) {
      directList[0].path = "$ (直接图片数据)";
      return directList;
    }

    // 3. Embedded data:image/...;base64,... inside partial text
    var found = [];
    var re = /data:(image\/(?:png|jpeg|jpg|webp|gif|svg\+xml|bmp|x-icon|avif));base64,([A-Za-z0-9+/=]+)/gi;
    var m;
    while ((m = re.exec(raw)) !== null) {
      var normMime = m[1].toLowerCase() === "image/jpg" ? "image/jpeg" : m[1].toLowerCase();
      found.push({
        kind: "dataUrl",
        path: "$ (文本提取 #" + (found.length + 1) + ")",
        mime: normMime,
        dataUrl: "data:" + normMime + ";base64," + m[2],
        bytes: Math.round(m[2].length * 0.75)
      });
    }
    return found;
  }

  function renderJ2IDecodePane() {
    var list = state.j2i.detected;
    var strip = byId("j2i-thumb-strip");
    var previewImg = byId("j2i-preview-img");
    var emptyEl = byId("j2i-decode-empty");
    var dlAllBtn = byId("j2i-btn-dl-all");
    var copyBtn = byId("j2i-btn-copy-img");
    var dlBtn = byId("j2i-btn-dl-img");

    if (!list.length) {
      strip.hidden = true;
      previewImg.hidden = true;
      emptyEl.hidden = false;
      dlAllBtn.hidden = true;
      copyBtn.disabled = true;
      dlBtn.disabled = true;
      byId("j2i-meta").textContent = "未检出图片数据";
      return;
    }

    emptyEl.hidden = true;
    previewImg.hidden = false;
    copyBtn.disabled = false;
    dlBtn.disabled = false;
    dlAllBtn.hidden = list.length <= 1;

    strip.hidden = list.length <= 1;
    strip.innerHTML = "";
    if (list.length > 1) {
      list.forEach(function (item, idx) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "detected-card" + (idx === state.j2i.selectedIdx ? " is-active" : "");
        btn.addEventListener("click", function () {
          state.j2i.selectedIdx = idx;
          renderJ2IDecodePane();
        });
        var im = document.createElement("img");
        im.src = item.dataUrl;
        im.alt = item.path;
        im.className = "thumb-checker";
        btn.appendChild(im);

        var info = document.createElement("div");
        info.className = "detected-info";
        var p = document.createElement("div");
        p.className = "detected-path";
        p.textContent = item.path;
        var d = document.createElement("div");
        d.className = "detected-dim";
        d.textContent = item.mime.replace("image/", "").toUpperCase() + " | " + formatBytes(item.bytes);
        info.appendChild(p);
        info.appendChild(d);
        btn.appendChild(info);

        strip.appendChild(btn);
      });
    }

    var current = list[state.j2i.selectedIdx] || list[0];
    previewImg.classList.toggle("is-pixel", current.kind === "pixel");
    previewImg.onload = function () {
      var dim = (previewImg.naturalWidth || 0) + " x " + (previewImg.naturalHeight || 0) + " px";
      var extra = current.gridInfo ? " | " + current.gridInfo : "";
      byId("j2i-meta").textContent = dim + " | " + current.mime + " | " + formatBytes(current.bytes) + extra + " | " + current.path;
    };
    previewImg.onerror = function () {
      byId("j2i-meta").textContent = "图片解码失败";
      setJ2IStatus("diag-banner", "#ic-alert", "图片解码失败: Base64 数据不完整或格式损坏");
    };
    previewImg.src = current.dataUrl;
  }

  function drawTokenizedLine(ctx, line, startX, y, p) {
    var regex = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:])/g;
    var lastIdx = 0;
    var x = startX;
    var m;
    while ((m = regex.exec(line)) !== null) {
      if (m.index > lastIdx) {
        var plain = line.slice(lastIdx, m.index);
        ctx.fillStyle = p.punct;
        ctx.fillText(plain, x, y);
        x += ctx.measureText(plain).width;
      }
      var tok = m[0];
      if (tok.charAt(0) === '"') {
        if (/:$/.test(tok)) {
          var kPart = tok.slice(0, -1);
          ctx.fillStyle = p.key;
          ctx.fillText(kPart, x, y);
          x += ctx.measureText(kPart).width;
          ctx.fillStyle = p.punct;
          ctx.fillText(":", x, y);
          x += ctx.measureText(":").width;
        } else {
          ctx.fillStyle = p.str;
          ctx.fillText(tok, x, y);
          x += ctx.measureText(tok).width;
        }
      } else if (tok === "true" || tok === "false") {
        ctx.fillStyle = p.bool;
        ctx.fillText(tok, x, y);
        x += ctx.measureText(tok).width;
      } else if (tok === "null") {
        ctx.fillStyle = p.nullC;
        ctx.fillText(tok, x, y);
        x += ctx.measureText(tok).width;
      } else if (/^[{}\[\],:]$/.test(tok)) {
        ctx.fillStyle = p.punct;
        ctx.fillText(tok, x, y);
        x += ctx.measureText(tok).width;
      } else {
        ctx.fillStyle = p.num;
        ctx.fillText(tok, x, y);
        x += ctx.measureText(tok).width;
      }
      lastIdx = regex.lastIndex;
    }
    if (lastIdx < line.length) {
      ctx.fillStyle = p.punct;
      ctx.fillText(line.slice(lastIdx), x, y);
    }
  }

  function renderJ2ICodeCard() {
    var canvas = byId("j2i-card-canvas");
    var ctx = canvas.getContext("2d");
    var raw = byId("j2i-input").value.trim();
    var themeKey = byId("j2i-card-theme").value;
    var cardTitle = byId("j2i-card-title").value.trim() || "data.json";
    var scale = parseInt(byId("j2i-card-scale").value, 10) || 2;
    var showLineNos = byId("j2i-card-linenos").checked;

    var formatted = "";
    if (!raw) {
      formatted = "{\n  \"message\": \"请输入 JSON 内容以生成图卡\"\n}";
    } else {
      try {
        formatted = JSON.stringify(JSON.parse(raw), null, 2);
      } catch (e) {
        formatted = raw;
      }
    }

    var allLines = formatted.split("\n");
    var truncated = allLines.length > 80;
    byId("j2i-card-truncate-note").hidden = !truncated;
    var lines = truncated ? allLines.slice(0, 80) : allLines;

    var palettes = {
      sage: {
        bgA: "#dde6db",
        bgB: "#eef2ea",
        card: "#fafbf8",
        cardBorder: "rgba(30,52,38,0.14)",
        head: "#f2f5ef",
        title: "#1c3226",
        badgeBg: "#e0ece0",
        badgeText: "#224d35",
        lineno: "#86978c",
        key: "#1f4e37",
        str: "#245b66",
        num: "#8c5219",
        bool: "#694172",
        nullC: "#68776d",
        punct: "#5a6b60"
      },
      pine: {
        bgA: "#16241c",
        bgB: "#0f1713",
        card: "#18231d",
        cardBorder: "rgba(214,234,220,0.16)",
        head: "#131c17",
        title: "#e6eee8",
        badgeBg: "rgba(121,196,150,0.16)",
        badgeText: "#79c496",
        lineno: "#65796c",
        key: "#7cc99b",
        str: "#78bfc8",
        num: "#e0a96b",
        bool: "#c89fd1",
        nullC: "#899a8f",
        punct: "#8aa092"
      },
      slate: {
        bgA: "#dce2ea",
        bgB: "#edf1f6",
        card: "#ffffff",
        cardBorder: "rgba(24,38,58,0.12)",
        head: "#f4f6fa",
        title: "#1a2538",
        badgeBg: "#e5ecf6",
        badgeText: "#2c4c7e",
        lineno: "#95a2b5",
        key: "#294b7d",
        str: "#266858",
        num: "#9c561a",
        bool: "#7a3b7d",
        nullC: "#6f7d90",
        punct: "#5b6a7e"
      }
    };
    var p = palettes[themeKey] || palettes.sage;

    var font = "13px ui-monospace, 'Cascadia Mono', Consolas, monospace";
    ctx.font = font;

    var maxLinePx = 360;
    var clippedLines = lines.map(function (ln) {
      return ln.length > 86 ? ln.slice(0, 83) + "..." : ln;
    });
    clippedLines.forEach(function (ln) {
      var w = ctx.measureText(ln).width;
      if (w > maxLinePx) maxLinePx = w;
    });

    var padOuter = 26;
    var cardPadX = 18;
    var gutterW = showLineNos ? 34 : 0;
    var cardW = Math.min(760, Math.max(460, Math.ceil(maxLinePx + gutterW + cardPadX * 2)));
    var headerH = 40;
    var lineH = 21;
    var codePadY = 14;
    var cardH = headerH + codePadY * 2 + clippedLines.length * lineH;
    var totalW = cardW + padOuter * 2;
    var totalH = cardH + padOuter * 2;

    canvas.width = totalW * scale;
    canvas.height = totalH * scale;
    ctx.save();
    ctx.scale(scale, scale);

    var bgGrad = ctx.createLinearGradient(0, 0, totalW, totalH);
    bgGrad.addColorStop(0, p.bgA);
    bgGrad.addColorStop(1, p.bgB);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, totalW, totalH);

    ctx.shadowColor = "rgba(15, 28, 20, 0.22)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = p.card;
    roundRectPath(ctx, padOuter, padOuter, cardW, cardH, 12);
    ctx.fill();
    ctx.shadowColor = "transparent";

    ctx.strokeStyle = p.cardBorder;
    ctx.lineWidth = 1;
    roundRectPath(ctx, padOuter, padOuter, cardW, cardH, 12);
    ctx.stroke();

    ctx.save();
    roundRectPath(ctx, padOuter, padOuter, cardW, cardH, 12);
    ctx.clip();
    ctx.fillStyle = p.head;
    ctx.fillRect(padOuter, padOuter, cardW, headerH);
    ctx.fillStyle = p.cardBorder;
    ctx.fillRect(padOuter, padOuter + headerH, cardW, 1);

    ctx.fillStyle = p.title;
    ctx.font = "600 13px -apple-system, 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(cardTitle, padOuter + 16, padOuter + headerH / 2);

    var badgeText = clippedLines.length + " 行";
    ctx.font = "600 11px ui-monospace, Consolas, monospace";
    var bw = ctx.measureText(badgeText).width + 16;
    ctx.fillStyle = p.badgeBg;
    roundRectPath(ctx, padOuter + cardW - bw - 14, padOuter + 10, bw, 20, 5);
    ctx.fill();
    ctx.fillStyle = p.badgeText;
    ctx.fillText(badgeText, padOuter + cardW - bw - 6, padOuter + headerH / 2);

    ctx.font = font;
    ctx.textBaseline = "top";
    var startY = padOuter + headerH + codePadY;
    var codeX = padOuter + cardPadX + gutterW;

    clippedLines.forEach(function (line, i) {
      var y = startY + i * lineH;
      if (showLineNos) {
        ctx.fillStyle = p.lineno;
        ctx.textAlign = "right";
        ctx.fillText(String(i + 1), padOuter + cardPadX + gutterW - 12, y);
        ctx.textAlign = "left";
      }
      drawTokenizedLine(ctx, line, codeX, y, p);
    });

    ctx.restore();
    ctx.restore();

    byId("j2i-card-meta").textContent = canvas.width + " x " + canvas.height + " px (PNG " + scale + "x)";
  }

  byId("j2i-mode-decode").addEventListener("click", function () { setJ2IMode("decode"); });
  byId("j2i-mode-card").addEventListener("click", function () { setJ2IMode("card"); });
  byId("j2i-switch-to-card").addEventListener("click", function () { setJ2IMode("card"); });

  byId("j2i-input").addEventListener("input", runJ2IParse);
  attachJsonFileDrop(byId("j2i-input"), runJ2IParse);
  byId("j2i-thumb-strip").addEventListener("wheel", function (ev) {
    if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX) && this.scrollWidth > this.clientWidth) {
      ev.preventDefault();
      this.scrollLeft += ev.deltaY;
    }
  }, { passive: false });

  byId("j2i-btn-paste").addEventListener("click", function () {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function (txt) {
        if (txt) {
          byId("j2i-input").value = txt;
          runJ2IParse();
        }
      }).catch(function () {
        byId("j2i-input").focus();
        showToast("请直接在左侧编辑框按 Ctrl+V 粘贴");
      });
    } else {
      byId("j2i-input").focus();
      showToast("请直接在左侧编辑框按 Ctrl+V 粘贴");
    }
  });

  function loadJ2ISampleImageJson() {
    var obj = {
      theme: "sage-forest",
      assets: [
        {
          role: "plugin-badge",
          mime: "image/png",
          dataUrl: samples.badge.dataUrl
        },
        {
          role: "user-avatar",
          mime: "image/png",
          dataUrl: samples.avatar.dataUrl
        }
      ]
    };
    byId("j2i-input").value = JSON.stringify(obj, null, 2);
    setJ2IMode("decode");
    runJ2IParse();
  }

  function loadJ2ISamplePixelJson() {
    var obj = {
      type: "pixel-grid",
      name: "leaf-icon",
      width: 12,
      height: 12,
      palette: ["transparent", "#1f4e37", "#4b8c63", "#99d4ad"],
      rows: [
        "000000000000",
        "000000111100",
        "000011222100",
        "000122322100",
        "001232221000",
        "001223211000",
        "001222110000",
        "000111100000",
        "001000000000",
        "010000000000",
        "000000000000",
        "000000000000"
      ]
    };
    byId("j2i-input").value = JSON.stringify(obj, null, 2);
    setJ2IMode("decode");
    runJ2IParse();
  }

  byId("j2i-btn-sample-img").addEventListener("click", loadJ2ISampleImageJson);
  byId("j2i-btn-sample-px").addEventListener("click", loadJ2ISamplePixelJson);
  byId("j2i-btn-clear").addEventListener("click", function () {
    byId("j2i-input").value = "";
    runJ2IParse();
  });

  ["j2i-bg-checker", "j2i-bg-light", "j2i-bg-dark"].forEach(function (id) {
    byId(id).addEventListener("click", function () {
      var bg = id.replace("j2i-bg-", "");
      state.j2i.bg = bg;
      ["j2i-bg-checker", "j2i-bg-light", "j2i-bg-dark"].forEach(function (other) {
        byId(other).setAttribute("aria-pressed", String(other === id));
      });
      var stage = byId("j2i-stage");
      stage.classList.remove("thumb-checker", "bg-light", "bg-dark");
      stage.classList.add(bg === "checker" ? "thumb-checker" : "bg-" + bg);
    });
  });

  ["j2i-zoom-fit", "j2i-zoom-100", "j2i-zoom-200"].forEach(function (id) {
    byId(id).addEventListener("click", function () {
      var zoom = id.replace("j2i-zoom-", "");
      state.j2i.zoom = zoom;
      ["j2i-zoom-fit", "j2i-zoom-100", "j2i-zoom-200"].forEach(function (other) {
        byId(other).setAttribute("aria-pressed", String(other === id));
      });
      var stage = byId("j2i-stage");
      stage.classList.remove("zoom-100", "zoom-200");
      if (zoom === "100") stage.classList.add("zoom-100");
      if (zoom === "200") stage.classList.add("zoom-200");
    });
  });

  byId("j2i-btn-dl-img").addEventListener("click", function () {
    var current = state.j2i.detected[state.j2i.selectedIdx];
    if (!current) return;
    var ext = current.mime.split("/")[1].replace("+xml", "") || "png";
    triggerDownloadDataUrl(current.dataUrl, "restored-" + (state.j2i.selectedIdx + 1) + "." + ext);
  });

  byId("j2i-btn-dl-all").addEventListener("click", function () {
    state.j2i.detected.forEach(function (item, i) {
      var ext = item.mime.split("/")[1].replace("+xml", "") || "png";
      triggerDownloadDataUrl(item.dataUrl, "restored-" + (i + 1) + "." + ext);
    });
  });

  byId("j2i-btn-copy-img").addEventListener("click", function () {
    var current = state.j2i.detected[state.j2i.selectedIdx];
    if (!current) return;
    copyImageFromDataUrl(current.dataUrl);
  });

  ["j2i-card-theme", "j2i-card-scale", "j2i-card-linenos"].forEach(function (id) {
    byId(id).addEventListener("change", renderJ2ICodeCard);
  });
  byId("j2i-card-title").addEventListener("input", renderJ2ICodeCard);

  byId("j2i-btn-dl-card").addEventListener("click", function () {
    var dataUrl = byId("j2i-card-canvas").toDataURL("image/png");
    var base = (byId("j2i-card-title").value.trim() || "json-card").replace(/\.json$/i, "");
    triggerDownloadDataUrl(dataUrl, base + ".png");
  });

  byId("j2i-btn-copy-card").addEventListener("click", function () {
    var dataUrl = byId("j2i-card-canvas").toDataURL("image/png");
    copyImageFromDataUrl(dataUrl);
  });

  /* -----------------------------
     Host Lifecycle & Initial State
  ----------------------------- */
  if (window.utools && typeof window.utools.onPluginEnter === "function") {
    window.utools.onPluginEnter(function () {
      syncHeaderStatusForActiveTab();
    });
  }

  setTheme(loadInitialTheme());
  byId("fmt-input").value = "";
  runFmtUpdate();
  renderI2JImageList();
  generateI2JJson();
  byId("j2i-input").value = "";
  runJ2IParse();
  byId("i2j-quality").disabled = true;
})();
