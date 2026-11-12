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
  const restoreClosedTabs = () => {
    // Preferred: Firefox's own batch-aware undo.
    if (window.SessionWindowUI?.undoCloseTab) {
      window.SessionWindowUI.undoCloseTab(window);
      return true;
    }
    if (typeof window.undoCloseTab === "function") {
      window.undoCloseTab();
      return true;
    }
    if (typeof window.goDoCommand === "function") {
      window.goDoCommand("History:UndoCloseTab");
      return true;
    }
    return false;
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
  const isEditableElement = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.localName;
    if (tag === "textarea") return true;
    if (tag === "input") return !NON_TEXT_INPUTS.has((el.type || "text").toLowerCase());
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
      if (!isEnabled()) return;
      // A key press produces keydown + keypress; only act once per press.
      if (event.timeStamp - lastHandled < 150) return;
      if (isTextEditing(event)) return;
      if (!hasRecentClosedTab()) return;
      if (restoreClosedTabs()) {
        lastHandled = event.timeStamp;
        event.preventDefault();
        event.stopPropagation();
      }
    } catch (e) {
      warn("undo failed", e);
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
