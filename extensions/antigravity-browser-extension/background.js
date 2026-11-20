/**
 * Antigravity Browser Bridge - Chrome Extension Service Worker
 * Copyright 2026 Antigravity Computer & Browser Use Contributors
 */

const NATIVE_HOST_NAME = "com.google.antigravity.browser_bridge"
const KEEPALIVE_ALARM = "antigravity-keepalive"

let port = null
let isConnected = false
let connectionAttempts = 0

// Debugger state for console / page error capture
const debuggerState = new Map()
const MAX_LOG_ENTRIES = 1000

function updateBadge(connected) {
  try {
    chrome.action.setBadgeText({ text: connected ? "ON" : "OFF" })
    chrome.action.setBadgeBackgroundColor({ color: connected ? "#10b981" : "#ef4444" })
  } catch (_) {}
}

async function connect() {
  if (isConnected && port) return

  connectionAttempts++
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  } catch (err) {
    isConnected = false
    updateBadge(false)
    return
  }

  isConnected = true
  connectionAttempts = 0
  updateBadge(true)

  port.onMessage.addListener(async (msg) => {
    if (!msg) return
    if (msg.type === "tool_request") {
      await handleToolRequest(msg)
    }
  })

  port.onDisconnect.addListener(() => {
    isConnected = false
    port = null
    updateBadge(false)
    // Reconnect after brief delay
    setTimeout(() => {
      connect().catch(() => {})
    }, 2000)
  })

  // Announce ready to native host
  sendNative({ type: "hello", role: "extension", version: "1.0.0" })
}

function sendNative(msg) {
  if (!port) return false
  try {
    port.postMessage(msg)
    return true
  } catch (_) {
    return false
  }
}

async function handleToolRequest(request) {
  const { id, tool, args = {} } = request
  try {
    const result = await executeTool(tool, args)
    sendNative({ type: "tool_response", id, result })
  } catch (error) {
    sendNative({
      type: "tool_response",
      id,
      error: { content: error?.message || String(error) }
    })
  }
}

async function executeTool(toolName, args) {
  const tools = {
    get_active_tab: toolGetActiveTab,
    get_tabs: toolGetTabs,
    open_tab: toolOpenTab,
    close_tab: toolCloseTab,
    activate_tab: toolActivateTab,
    navigate: toolNavigate,
    click: toolClick,
    type: toolType,
    select: toolSelect,
    screenshot: toolScreenshot,
    snapshot: toolSnapshot,
    query: toolQuery,
    scroll: toolScroll,
    wait: toolWait,
    press_key: toolPressKey,
    hover: toolHover,
    drag: toolDrag,
    eval_js: toolEvalJs,
    set_file_input: toolSetFileInput,
    highlight: toolHighlight,
    console: toolConsole,
    errors: toolErrors,
    cdp: toolCdp,
    reload_self: toolReloadSelf
  }

  const fn = tools[toolName]
  if (!fn) throw new Error(`Unknown tool: ${toolName}`)
  return await fn(args)
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id) return tab
  const [anyTab] = await chrome.tabs.query({ active: true })
  if (anyTab?.id) return anyTab
  const allTabs = await chrome.tabs.query({})
  if (allTabs[0]?.id) return allTabs[0]
  throw new Error("No active tab found")
}

async function getTabById(tabId) {
  return tabId ? await chrome.tabs.get(tabId) : await getActiveTab()
}

async function ensureDebuggerAttached(tabId) {
  if (debuggerState.has(tabId)) return debuggerState.get(tabId)
  const state = { attached: false, consoleMessages: [], pageErrors: [] }
  debuggerState.set(tabId, state)
  try {
    await chrome.debugger.attach({ tabId }, "1.3")
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable")
    state.attached = true
  } catch (e) {
    state.unavailableReason = e.message || String(e)
  }
  return state
}

if (chrome.debugger?.onEvent) {
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const state = debuggerState.get(source.tabId)
    if (!state) return

    if (method === "Runtime.consoleAPICalled") {
      if (state.consoleMessages.length >= MAX_LOG_ENTRIES) state.consoleMessages.shift()
      state.consoleMessages.push({
        type: params.type,
        text: params.args.map((a) => a.value ?? a.description ?? "").join(" "),
        timestamp: Date.now(),
        source: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber
      })
    }

    if (method === "Runtime.exceptionThrown") {
      if (state.pageErrors.length >= MAX_LOG_ENTRIES) state.pageErrors.shift()
      state.pageErrors.push({
        message: params.exceptionDetails.text,
        source: params.exceptionDetails.url,
        line: params.exceptionDetails.lineNumber,
        column: params.exceptionDetails.columnNumber,
        stack: params.exceptionDetails.exception?.description,
        timestamp: Date.now()
      })
    }
  })
}

if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    debuggerState.delete(source.tabId)
  })
}

// In-page execution runner
async function runInPage(tabId, command, args) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: pageOps,
      args: [command, args || {}],
      world: "ISOLATED"
    })
    return result[0]?.result
  } catch (error) {
    throw error
  }
}

// In-page automation routines
async function pageOps(command, args) {
  const options = args || {}
  const rawSelectors = Array.isArray(options.selectors) ? options.selectors : [options.selector]
  const selectors = rawSelectors.filter(Boolean)
  const index = Math.max(0, options.index || 0)
  const timeoutMs = options.timeoutMs ?? 2000
  const pollMs = options.pollMs ?? 50
  const limit = options.limit ?? 200

  function safeString(v) {
    return typeof v === "string" ? v : ""
  }

  function matchesText(actual, expected) {
    if (!expected) return true
    const a = safeString(actual).trim().toLowerCase()
    const e = safeString(expected).trim().toLowerCase()
    return a.includes(e)
  }

  function stripQuotes(str) {
    const s = safeString(str).trim()
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1)
    }
    return s
  }

  function normalizeLocatorKey(key) {
    if (key === "css") return "css"
    if (key === "label" || key === "field") return "label"
    if (key === "aria" || key === "aria-label") return "aria"
    if (key === "placeholder") return "placeholder"
    if (key === "name") return "name"
    if (key === "role") return "role"
    if (key === "text") return "text"
    if (key === "id") return "id"
    return null
  }

  function parseLocator(raw) {
    const trimmed = safeString(raw).trim()
    if (!trimmed) return { kind: "css", value: "", raw: "" }
    const match = trimmed.match(/^([a-zA-Z_-]+)\s*(=|:)\s*(.+)$/)
    if (match) {
      const key = match[1].toLowerCase()
      const kind = normalizeLocatorKey(key)
      if (kind) {
        return { kind, value: stripQuotes(match[3]), raw: trimmed }
      }
    }
    return { kind: "css", value: trimmed, raw: trimmed }
  }

  function isVisible(el) {
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = window.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
    return true
  }

  function deepQuerySelectorAll(sel, rootDoc) {
    const out = []
    const seen = new Set()

    function addAll(nodeList) {
      for (const el of nodeList) {
        if (!el || seen.has(el)) continue
        seen.add(el)
        out.push(el)
      }
    }

    function walkRoot(root, depth) {
      if (!root || depth > 8) return
      try {
        addAll(root.querySelectorAll(sel))
      } catch {
        return
      }

      const tree = root.querySelectorAll ? root.querySelectorAll("*") : []
      for (const el of tree) {
        if (el.shadowRoot) {
          walkRoot(el.shadowRoot, depth + 1)
        }
      }

      const frames = root.querySelectorAll ? root.querySelectorAll("iframe") : []
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument
          if (doc) walkRoot(doc, depth + 1)
        } catch {}
      }
    }

    walkRoot(rootDoc || document, 0)
    return out
  }

  function queryLocator(locator) {
    const { kind, value } = locator
    if (!value) return []
    if (kind === "css") return deepQuerySelectorAll(value, document)
    if (kind === "id") {
      const el = document.getElementById(value)
      return el ? [el] : []
    }
    if (kind === "aria") {
      return deepQuerySelectorAll(`[aria-label*="${value}" i], [title*="${value}" i]`, document)
    }
    if (kind === "placeholder") {
      return deepQuerySelectorAll(`[placeholder*="${value}" i]`, document)
    }
    if (kind === "role") {
      return deepQuerySelectorAll(`[role="${value}" i], ${value}`, document)
    }
    if (kind === "text") {
      const all = deepQuerySelectorAll("a, button, input, textarea, select, [role], span, div, p, h1, h2, h3, h4", document)
      return all.filter((el) => matchesText(el.innerText || el.textContent || "", value))
    }
    return []
  }

  function findMatches(candidateSelectors) {
    for (const raw of candidateSelectors) {
      const locator = parseLocator(raw)
      const nodes = queryLocator(locator)
      const visible = nodes.filter(isVisible)
      if (visible.length > 0) {
        return { matches: visible, selectorUsed: raw }
      }
    }
    return { matches: [], selectorUsed: candidateSelectors[0] || "" }
  }

  async function resolveMatches(candidateSelectors, targetIndex, timeout, poll) {
    const start = Date.now()
    while (true) {
      const { matches, selectorUsed } = findMatches(candidateSelectors)
      if (matches.length > 0) {
        const chosen = matches[targetIndex] || matches[0]
        return { chosen, selectorUsed, matches }
      }
      if (Date.now() - start >= timeout) {
        return { chosen: null, selectorUsed: candidateSelectors[0] || "", matches: [] }
      }
      await new Promise((r) => setTimeout(r, poll))
    }
  }

  // Commands
  if (command === "click") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for: ${selectors.join(", ")}` }
    }
    const el = match.chosen
    el.scrollIntoView({ block: "center", inline: "center" })
    const rect = el.getBoundingClientRect()
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }
    el.dispatchEvent(new PointerEvent("pointerdown", opts))
    el.dispatchEvent(new MouseEvent("mousedown", opts))
    el.dispatchEvent(new PointerEvent("pointerup", opts))
    el.dispatchEvent(new MouseEvent("mouseup", opts))
    el.dispatchEvent(new MouseEvent("click", opts))
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "type") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for: ${selectors.join(", ")}` }
    }
    const el = match.chosen
    el.scrollIntoView({ block: "center", inline: "center" })
    el.focus()
    if (options.clear) {
      if (typeof el.value === "string") el.value = ""
      if (el.isContentEditable) el.textContent = ""
    }
    const textToType = safeString(options.text)
    if (typeof el.value === "string") {
      el.value = (el.value || "") + textToType
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
    } else if (el.isContentEditable) {
      document.execCommand("insertText", false, textToType)
    }
    return { ok: true, selectorUsed: match.selectorUsed }
  }

  if (command === "select") {
    const match = await resolveMatches(selectors, index, timeoutMs, pollMs)
    if (!match.chosen) {
      return { ok: false, error: `Element not found for: ${selectors.join(", ")}` }
    }
    const el = match.chosen
    if (el.tagName !== "SELECT") {
      return { ok: false, error: "Target is not a SELECT element" }
    }
    const optionsList = Array.from(el.options)
    let selected = null
    if (options.value !== undefined) {
      selected = optionsList.find(o => o.value === String(options.value))
    }
    if (!selected && options.label !== undefined) {
      selected = optionsList.find(o => matchesText(o.text, options.label))
    }
    if (selected) {
      el.value = selected.value
      el.dispatchEvent(new Event("change", { bubbles: true }))
      return { ok: true, selectorUsed: match.selectorUsed, value: selected.value, label: selected.text }
    }
    return { ok: false, error: "Option not found" }
  }

  if (command === "scroll") {
    const amount = Number(options.amount || 400)
    window.scrollBy({ top: amount, behavior: "smooth" })
    return { ok: true, scrolled: amount }
  }

  if (command === "query") {
    if (options.mode === "page_text") {
      const root = document.querySelector("article, main, [role='main']") || document.body
      const clone = root ? root.cloneNode(true) : null
      if (clone) {
        for (const bad of clone.querySelectorAll("script, style, noscript, svg, nav, footer, [aria-hidden='true']")) {
          bad.remove()
        }
      }
      const txt = (clone?.innerText || clone?.textContent || "").replace(/\n{3,}/g, "\n\n").trim()
      return { ok: true, value: txt.slice(0, limit) }
    }
    return { ok: false, error: "Unknown query mode" }
  }

  return { ok: false, error: `Unknown command: ${command}` }
}

// Tool handlers
async function toolGetActiveTab() {
  const tab = await getActiveTab()
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, title: tab.title } }
}

async function toolGetTabs() {
  const tabs = await chrome.tabs.query({})
  const out = tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }))
  return { content: JSON.stringify(out, null, 2) }
}

async function toolOpenTab({ url, active = true }) {
  const tab = await chrome.tabs.create({ url: url || "about:blank", active })
  return { tabId: tab.id, content: { tabId: tab.id, url: tab.url, active: tab.active } }
}

async function toolCloseTab({ tabId }) {
  if (!Number.isFinite(tabId)) throw new Error("tabId is required")
  await chrome.tabs.remove(tabId)
  return { tabId, content: { tabId, closed: true } }
}

async function toolActivateTab({ tabId } = {}) {
  const tab = await getTabById(tabId)
  await chrome.tabs.update(tab.id, { active: true })
  if (tab.windowId) {
    try { await chrome.windows.update(tab.windowId, { focused: true }) } catch (_) {}
  }
  return { tabId: tab.id, content: JSON.stringify({ tabId: tab.id, active: true }) }
}

async function toolNavigate({ url, tabId }) {
  if (!url) throw new Error("URL is required")
  const tab = await getTabById(tabId)
  await chrome.tabs.update(tab.id, { url })
  await new Promise((resolve) => {
    const listener = (updatedId, info) => {
      if (updatedId === tab.id && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, 30000)
  })
  return { tabId: tab.id, content: `Navigated to ${url}` }
}

async function toolClick({ selector, tabId, index = 0, timeoutMs, pollMs }) {
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "click", { selector, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Click failed")
  return { tabId: tab.id, content: `Clicked ${result.selectorUsed || selector}` }
}

async function toolType({ selector, text, tabId, clear = false, index = 0, timeoutMs, pollMs }) {
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "type", { selector, text, clear, index, timeoutMs, pollMs })
  if (!result?.ok) throw new Error(result?.error || "Type failed")
  return { tabId: tab.id, content: `Typed "${text}" into ${result.selectorUsed || selector}` }
}

async function toolSelect({ selector, value, label, tabId, index = 0 }) {
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "select", { selector, value, label, index })
  if (!result?.ok) throw new Error(result?.error || "Select failed")
  return { tabId: tab.id, content: `Selected ${result.label || result.value} in ${result.selectorUsed || selector}` }
}

async function toolScreenshot({ tabId }) {
  const tab = await getTabById(tabId)
  const png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  return { tabId: tab.id, content: png }
}

async function toolSnapshot({ tabId }) {
  const tab = await getTabById(tabId)
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: () => {
      function safeText(s) {
        return typeof s === "string" ? s : ""
      }
      function isVisible(el) {
        if (!el) return false
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return false
        const style = window.getComputedStyle(el)
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false
        return true
      }
      function pseudoText(el) {
        try {
          const before = window.getComputedStyle(el, "::before").content
          const after = window.getComputedStyle(el, "::after").content
          const norm = (v) => {
            const s = safeText(v)
            if (!s || s === "none") return ""
            return s.replace(/^"|"$/g, "")
          }
          return { before: norm(before), after: norm(after) }
        } catch {
          return { before: "", after: "" }
        }
      }
      function getName(el) {
        const aria = el.getAttribute("aria-label")
        if (aria) return aria
        const alt = el.getAttribute("alt")
        if (alt) return alt
        const title = el.getAttribute("title")
        if (title) return title
        const placeholder = el.getAttribute("placeholder")
        if (placeholder) return placeholder
        const txt = safeText(el.innerText)
        if (txt.trim()) return txt.slice(0, 200)
        const pt = pseudoText(el)
        const combo = `${pt.before} ${pt.after}`.trim()
        if (combo) return combo.slice(0, 200)
        return ""
      }

      function build(el, depth = 0, uid = 0) {
        if (!el || depth > 12) return { nodes: [], nextUid: uid }
        const nodes = []
        if (!isVisible(el)) return { nodes: [], nextUid: uid }

        const isInteractive =
          ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
          el.getAttribute("onclick") ||
          el.getAttribute("role") === "button" ||
          el.isContentEditable

        const name = getName(el)
        const pt = pseudoText(el)
        const shouldInclude = isInteractive || name.trim() || pt.before || pt.after

        if (shouldInclude) {
          const uidStr = `e${uid}`
          try {
            el.setAttribute("data-agy-uid", uidStr)
          } catch (_) {}
          const rect = el.getBoundingClientRect()
          const node = {
            uid: uidStr,
            role: el.getAttribute("role") || el.tagName.toLowerCase(),
            name: name,
            tag: el.tagName.toLowerCase(),
            rect: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              w: Math.round(rect.width),
              h: Math.round(rect.height)
            }
          }
          if (pt.before) node.before = pt.before
          if (pt.after) node.after = pt.after
          if (el.href) node.href = el.href
          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            node.type = el.type
            node.value = el.value
            if (el.readOnly) node.readOnly = true
            if (el.disabled) node.disabled = true
          }
          node.selector = `[data-agy-uid="${uidStr}"]`
          nodes.push(node)
          uid++
        }

        if (el.shadowRoot) {
          for (const child of el.shadowRoot.children) {
            const r = build(child, depth + 1, uid)
            nodes.push(...r.nodes)
            uid = r.nextUid
          }
        }

        for (const child of el.children) {
          const r = build(child, depth + 1, uid)
          nodes.push(...r.nodes)
          uid = r.nextUid
        }

        return { nodes, nextUid: uid }
      }

      function getAllLinks() {
        const links = []
        const seen = new Set()
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href
          if (href && !seen.has(href) && !href.startsWith("javascript:")) {
            seen.add(href)
            const text = a.innerText?.trim().slice(0, 100) || a.getAttribute("aria-label") || ""
            links.push({ href, text })
          }
        })
        return links.slice(0, 200)
      }

      let pageText = ""
      try {
        pageText = safeText(document.body?.innerText || "").slice(0, 20000)
      } catch (_) {}

      const built = build(document.body).nodes.slice(0, 800)
      return {
        url: location.href,
        title: document.title,
        text: pageText,
        nodes: built,
        links: getAllLinks()
      }
    }
  })
  return { tabId: tab.id, content: JSON.stringify(result[0]?.result, null, 2) }
}

async function toolQuery({ tabId, mode = "page_text", limit = 40000 }) {
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "query", { mode, limit })
  return { tabId: tab.id, content: JSON.stringify(result) }
}

async function toolScroll({ tabId, amount = 400 }) {
  const tab = await getTabById(tabId)
  const result = await runInPage(tab.id, "scroll", { amount })
  return { tabId: tab.id, content: JSON.stringify(result) }
}

async function toolWait({ tabId, text, timeoutMs = 10000 }) {
  const tab = await getTabById(tabId)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const snap = await toolSnapshot({ tabId: tab.id })
    const data = JSON.parse(snap.content)
    if (data.text.includes(text) || data.nodes.some(n => n.name.includes(text))) {
      return { tabId: tab.id, content: `Found "${text}"` }
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`Timeout waiting for "${text}"`)
}

async function toolEvalJs({ tabId, code, args = [] }) {
  const tab = await getTabById(tabId)
  const res = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (jsCode, jsArgs) => {
      try {
        const trimmed = String(jsCode || "").trim()
        let out
        if (trimmed.startsWith("(") || trimmed.startsWith("function") || trimmed.startsWith("async")) {
          const fn = (0, eval)(`(${trimmed})`)
          out = typeof fn === "function" ? await fn(...(jsArgs || [])) : fn
        } else {
          out = await (0, eval)(trimmed)
        }
        return { ok: true, value: out }
      } catch (err) {
        return { ok: false, error: err?.message || String(err) }
      }
    },
    args: [code, args]
  })
  const payload = res?.[0]?.result
  if (!payload?.ok) throw new Error(payload?.error || "eval_js failed")
  return { tabId: tab.id, content: typeof payload.value === "string" ? payload.value : JSON.stringify(payload.value ?? null) }
}

async function toolPressKey({ tabId, key }) {
  const tab = await getTabById(tabId)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: (k) => {
      const target = document.activeElement || document.body
      const opts = { key: k, code: k, bubbles: true, cancelable: true }
      target.dispatchEvent(new KeyboardEvent("keydown", opts))
      target.dispatchEvent(new KeyboardEvent("keypress", opts))
      if (k === "Enter" && target.form && typeof target.form.requestSubmit === "function") {
        try { target.form.requestSubmit() } catch (_) {}
      }
      target.dispatchEvent(new KeyboardEvent("keyup", opts))
    },
    args: [key || "Enter"]
  })
  return { tabId: tab.id, content: `Pressed key ${key}` }
}

async function toolHover({ tabId, selector }) {
  const tab = await getTabById(tabId)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: (sel) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error(`Element not found: ${sel}`)
      el.scrollIntoView({ block: "center", inline: "center" })
      const rect = el.getBoundingClientRect()
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
      el.dispatchEvent(new PointerEvent("pointerover", opts))
      el.dispatchEvent(new MouseEvent("mouseover", opts))
      el.dispatchEvent(new PointerEvent("pointerenter", opts))
      el.dispatchEvent(new MouseEvent("mouseenter", opts))
      el.dispatchEvent(new MouseEvent("mousemove", opts))
    },
    args: [selector]
  })
  return { tabId: tab.id, content: `Hovered ${selector}` }
}

async function toolDrag({ tabId, fromSelector, toSelector }) {
  const tab = await getTabById(tabId)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: (fromSel, toSel) => {
      const fromEl = document.querySelector(fromSel)
      const toEl = document.querySelector(toSel)
      if (!fromEl || !toEl) throw new Error("Source or target element not found for drag")
      const dt = new DataTransfer()
      fromEl.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }))
      toEl.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: dt }))
      toEl.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }))
      toEl.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }))
      fromEl.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }))
    },
    args: [fromSelector, toSelector]
  })
  return { tabId: tab.id, content: `Dragged ${fromSelector} to ${toSelector}` }
}

async function toolSetFileInput({ tabId, selector, filePath }) {
  const tab = await getTabById(tabId)
  return { tabId: tab.id, content: `Set file input for ${selector} to ${filePath}` }
}

async function toolHighlight({ tabId, selector, color = "#a855f7", duration = 800 }) {
  const tab = await getTabById(tabId)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED",
    func: (sel, col, dur) => {
      const el = document.querySelector(sel)
      if (!el) return
      const rect = el.getBoundingClientRect()
      const box = document.createElement("div")
      box.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;border:3px solid ${col};box-shadow:0 0 12px ${col};pointer-events:none;z-index:2147483647;transition:opacity 0.3s;`
      document.body.appendChild(box)
      setTimeout(() => {
        box.style.opacity = "0"
        setTimeout(() => box.remove(), 300)
      }, dur)
    },
    args: [selector, color, duration]
  })
  return { tabId: tab.id, content: `Highlighted ${selector}` }
}

async function toolConsole({ tabId, clear = false }) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  const msgs = [...state.consoleMessages]
  if (clear) state.consoleMessages = []
  return { tabId: tab.id, content: JSON.stringify(msgs, null, 2) }
}

async function toolErrors({ tabId, clear = false }) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  const errs = [...state.pageErrors]
  if (clear) state.pageErrors = []
  return { tabId: tab.id, content: JSON.stringify(errs, null, 2) }
}

async function toolCdp({ tabId, method, params = {} }) {
  const tab = await getTabById(tabId)
  const state = await ensureDebuggerAttached(tab.id)
  if (!state.attached) throw new Error(state.unavailableReason || "Debugger not attached")
  const res = await chrome.debugger.sendCommand({ tabId: tab.id }, method, params)
  return { tabId: tab.id, content: JSON.stringify(res ?? {}) }
}

async function toolReloadSelf() {
  setTimeout(() => chrome.runtime.reload(), 50)
  return { content: JSON.stringify({ reloaded: true }) }
}

// Alarms & Keepalive
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.25 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!isConnected) {
      connect().catch(() => {})
    }
  }
})

chrome.runtime.onInstalled.addListener(() => connect().catch(() => {}))
chrome.runtime.onStartup.addListener(() => connect().catch(() => {}))
chrome.action.onClicked.addListener(() => connect().catch(() => {}))

connect().catch(() => {})
