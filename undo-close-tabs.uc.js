// ==UserScript==
// @name          Undo Close Tabs (Cmd+Z)
// @description   Cmd+Z (Ctrl+Z elsewhere) restores the tab you just closed, or all tabs removed by "Clear"
// ==/UserScript==

// Standalone mod: it never edits Zen or Tidy Tabs, so updates to either can't remove it.
//
// It reuses Firefox's own session-store undo (SessionWindowUI.undoCloseTab), which:
//   - restores one tab after you close a single tab, and
//   - restores the whole batch after Zen's "Clear" button (getLastClosedTabCount),
//   - puts tabs back in the right Space / position / folder, like Cmd+Shift+T.
//
// Cmd+Z is only taken when nothing else wants it: if you're typing in a text
// field (page or browser UI) the key keeps working as normal text undo, and if
// no tab was closed recently the key does nothing.

(() => {
  if (window.__zenUndoCloseTabsInstalled) return;
  window.__zenUndoCloseTabsInstalled = true;

  const ENABLED_PREF = "zen.undo-close-tabs.enabled";
  const MINUTES_PREF = "zen.undo-close-tabs.window-minutes";
  const CLEAR_TOAST_ID = "zen-workspaces-close-all-unpinned-tabs-toast";
  const IS_MAC = Services.appinfo.OS === "Darwin";
  const SHORTCUT_LABEL = IS_MAC ? "⌘Z" : "Ctrl+Z";

  const log = (...a) => console.log("[UndoCloseTabs]", ...a);
  const warn = (...a) => console.warn("[UndoCloseTabs]", ...a);

  const isEnabled = () => {
    try {
      return Services.prefs.getBoolPref(ENABLED_PREF, true);
    } catch (_e) {
      return true;
    }
  };
  // How long after closing a tab Cmd+Z still brings it back. 0 = no limit.
  const windowMs = () => {
    try {
      const raw = Services.prefs.getStringPref(MINUTES_PREF, "15");
      const v = parseFloat(raw);
      return Number.isFinite(v) && v >= 0 ? v * 60 * 1000 : 15 * 60 * 1000;
    } catch (_e) {
      return 15 * 60 * 1000;
    }
  };

  // ---- Tiny diagnostics log (profile folder, undo-close-tabs.log) ------------
  // One line per Cmd+Z press that this mod considered. Helps explain "it didn't restore".
  let logPath = null;
  try {
    logPath = PathUtils.join(PathUtils.profileDir, "undo-close-tabs.log");
    IOUtils.stat(logPath).then(
      (st) => { if (st.size > 100000) IOUtils.remove(logPath).catch(() => {}); },
      () => {}
    );
  } catch (_e) {}
  const writeLog = (line) => {
    if (!logPath) return;
    try {
      IOUtils.writeUTF8(logPath, new Date().toISOString() + " " + line + "\n", { mode: "appendOrCreate" }).catch(() => {});
    } catch (_e) {}
  };
  const describeFocus = () => {
    const parts = [];
    let el = document.activeElement;
    while (el) {
      parts.push(el.localName + (el.id ? "#" + el.id : ""));
      el = el.shadowRoot?.activeElement || null;
    }
    return parts.join(">");
  };

  // Firefox only remembers the last 25 closed tabs by default, so clearing 40 tabs could
  // only ever bring back 25. Raise the limit (never lowers a value you set higher).
  const MIN_UNDO_DEPTH = 100;
  try {
    const depth = Services.prefs.getIntPref("browser.sessionstore.max_tabs_undo", 25);
    if (depth < MIN_UNDO_DEPTH) {
      Services.prefs.setIntPref("browser.sessionstore.max_tabs_undo", MIN_UNDO_DEPTH);
      writeLog("raised browser.sessionstore.max_tabs_undo " + depth + " -> " + MIN_UNDO_DEPTH);
    }
  } catch (e) {
    warn("could not raise undo depth", e);
  }

  // ---- Is there something recent to restore? ---------------------------------
  const lastClosedTabAge = () => {
    try {
      const count = SessionStore.getClosedTabCountForWindow(window);
      if (!count) return null;
      const data = SessionStore.getClosedTabDataForWindow(window);
      const closedAt = data?.[0]?.closedAt;
      return typeof closedAt === "number" ? Date.now() - closedAt : 0;
    } catch (e) {
      warn("could not read closed tabs", e);
      return null;
    }
  };

  const hasRecentClosedTab = () => {
    const age = lastClosedTabAge();
    if (age === null) return false;
    const limit = windowMs();
    return limit === 0 || age <= limit;
  };

  // ---- Restore ---------------------------------------------------------------
  // How many tabs were closed "together" most recently (one tab, or a whole Clear).
  // Firefox's own last-batch counter accumulates across closes, which could bring
  // back more than you cleared, so batches are worked out from the close times.
  const BATCH_GAP_MS = 700;
  const lastBatchSize = () => {
    const data = SessionStore.getClosedTabDataForWindow(window) || [];
    if (!data.length) return 0;
    let n = 1;
    while (
      n < data.length &&
      typeof data[n - 1].closedAt === "number" &&
      typeof data[n].closedAt === "number" &&
      data[n - 1].closedAt - data[n].closedAt <= BATCH_GAP_MS
    ) {
      n++;
    }
    return n;
  };

  const restoreClosedTabs = () => {
    const ui = window.SessionWindowUI;
    if (ui?.undoCloseTab) {
      // Restoring index 0 repeatedly walks back newest-first, one batch worth.
      const n = Math.max(1, lastBatchSize());
      for (let i = 0; i < n; i++) ui.undoCloseTab(window, 0);
      return n;
    }
    if (typeof window.undoCloseTab === "function") {
      window.undoCloseTab();
      return 1;
    }
    if (typeof window.goDoCommand === "function") {
      window.goDoCommand("History:UndoCloseTab");
      return 1;
    }
    return 0;
  };

  // ---- Don't steal Cmd+Z from text editing -----------------------------------
  // Browser UI (URL bar, rename box, search fields): look at the focused element.
  // Web pages: the key reaches this window before the page's text field has
  // handled it, and the window can't see inside the page. So a tiny frame script
  // runs in every tab and reports whether an editable element is focused.
  const deepActiveElement = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };
  const NON_TEXT_INPUTS = new Set([
    "button", "checkbox", "radio", "range", "color", "file",
    "image", "reset", "submit",
  ]);
  // True only if Cmd+Z would really undo text here. An empty/untouched field (e.g. the
  // URL bar Zen focuses after Clear) has nothing to undo, so the key is free for us.
  const canUndoText = (el) => {
    try {
      const editor = el.editor;
      if (editor && typeof editor.canUndo === "boolean") return editor.canUndo;
    } catch (_e) {}
    return true; // can't tell -> assume the field wants the key
  };
  const isEditableElement = (el) => {
    if (!el || el.nodeType !== 1) return false;
    // URL bar: Zen focuses it (empty) after Clear. Only yield if YOU typed in it.
    if (el.id === "urlbar-input" && typeof window.gURLBar?.valueIsTyped === "boolean") {
      return window.gURLBar.valueIsTyped;
    }
    const tag = el.localName;
    if (tag === "textarea") return canUndoText(el);
    if (tag === "input") {
      return !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase()) && canUndoText(el);
    }
    return !!el.isContentEditable;
  };

  const EDITABLE_MSG = "UndoCloseTabs:editable";
  const pageEditable = new WeakMap(); // <browser> -> boolean
  let pageGuardWorks = false;

  const FRAME_SCRIPT = `(function () {
    const NON = ${JSON.stringify([...NON_TEXT_INPUTS])};
    const deep = (doc) => {
      let el = doc && doc.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      return el;
    };
    const editable = (doc) => {
      if (doc && doc.designMode === "on") return true;
      const el = deep(doc);
      if (!el || el.nodeType !== 1) return false;
      const tag = el.localName;
      if (tag === "textarea") return true;
      if (tag === "input") return NON.indexOf((el.type || "text").toLowerCase()) === -1;
      return !!el.isContentEditable;
    };
    const report = (v) => { try { sendAsyncMessage(${JSON.stringify(EDITABLE_MSG)}, v); } catch (_e) {} };
    addEventListener("focusin", (e) => report(editable(e.target.ownerDocument || e.target)), true);
    addEventListener("focusout", (e) => { if (!e.relatedTarget) report(false); }, true);
    addEventListener("pagehide", () => report(false), true);
  })();`;

  try {
    window.messageManager.addMessageListener(EDITABLE_MSG, (msg) => {
      pageEditable.set(msg.target, !!msg.data);
    });
    window.messageManager.loadFrameScript(
      "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT),
      true
    );
    pageGuardWorks = true;
  } catch (e) {
    warn("page text-field guard unavailable; Cmd+Z will stay out of the way while a page is focused", e);
  }

  const isTextEditing = (event) => {
    const active = deepActiveElement();
    if (isEditableElement(active) || isEditableElement(event.composedTarget) || isEditableElement(event.originalTarget)) {
      return true;
    }
    // Focus is on the web page itself (the <browser> element).
    if (active?.localName === "browser") {
      return pageGuardWorks ? pageEditable.get(active) === true : true;
    }
    return false;
  };

  // ---- Key handling ----------------------------------------------------------
  const isUndoShortcut = (e) => {
    const accel = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!accel || e.shiftKey || e.altKey) return false;
    return (e.key || "").toLowerCase() === "z";
  };

  let lastHandled = 0;
  const onKey = (event) => {
    try {
      if (event.defaultPrevented || event.isComposing) return;
      if (!isUndoShortcut(event)) return;
      if (!isEnabled()) return writeLog("skip: disabled");
      // A key press produces keydown + keypress; only act once per press.
      if (event.timeStamp - lastHandled < 150) return;
      const focus = describeFocus();
      if (isTextEditing(event)) return writeLog("skip: text field has undo history; focus=" + focus);
      if (!hasRecentClosedTab()) {
        return writeLog("skip: nothing recent; closed=" + (lastClosedTabAge() === null ? "none" : Math.round(lastClosedTabAge() / 1000) + "s ago") + "; focus=" + focus);
      }
      const restored = restoreClosedTabs();
      if (restored) {
        lastHandled = event.timeStamp;
        event.preventDefault();
        event.stopPropagation();
        writeLog("restored " + restored + " tab(s); focus=" + focus);
      } else {
        writeLog("skip: no restore function found");
      }
    } catch (e) {
      warn("undo failed", e);
      writeLog("error: " + e);
    }
  };

  // mozSystemGroup = same phase XUL <key> shortcuts run in: AFTER web pages and
  // text editors have had their chance to handle (and cancel) the key.
  window.addEventListener("keypress", onKey, { mozSystemGroup: true });
  window.addEventListener("keydown", onKey, { mozSystemGroup: true });

  // ---- Make the "tabs cleared" toast tell the truth --------------------------
  // Zen's toast says "Press <shortcut> to restore". Tidy Tabs' clear patch passes the
  // shortcut in a shape the toast ignores (so it reads "Press shortcut to ..."),
  // and Zen's own uses Cmd+Shift+T. Make both say Cmd+Z.
  const patchToast = () => {
    const ui = window.gZenUIManager;
    if (!ui || typeof ui.showToast !== "function" || ui.__undoCloseToastPatched) return !!ui?.__undoCloseToastPatched;
    const original = ui.showToast;
    ui.showToast = function (id, options, ...rest) {
      if (id === CLEAR_TOAST_ID && isEnabled()) {
        options = { ...(options || {}), l10nArgs: { ...(options?.l10nArgs || {}), shortcut: SHORTCUT_LABEL } };
      }
      return original.call(this, id, options, ...rest);
    };
    ui.__undoCloseToastPatched = true;
    return true;
  };
  if (!patchToast()) {
    let tries = 0;
    const timer = setInterval(() => {
      if (patchToast() || ++tries > 40) clearInterval(timer);
    }, 500);
  }

  log("ready; press", SHORTCUT_LABEL, "to restore recently closed tabs");
})();
