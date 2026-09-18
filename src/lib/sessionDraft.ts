import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"

// Drop-in replacement for useState that survives navigating to another page
// and back. App.tsx's router renders exactly one page component at a time
// (renderPage()'s switch/case) -- leaving a page unmounts it completely, so
// any in-progress work held in plain useState (a half-filled form, a cart
// mid-sale) is gone the moment someone glances at another page and returns.
// First built for StockReceivingPage's delivery form; this is that same
// sessionStorage-backed pattern generalized so any page can adopt it per
// field with a one-line change (swap useState for useSessionDraft).
//
// sessionStorage, not localStorage, is deliberate: this is live, unsaved work
// -- it should not still be offered back days later in a fresh browser
// session, only within the same tab's session (survives navigating around
// the app, not closing the browser).
//
// Each call needs its own unique, stable `key` -- two pages (or two fields on
// the same page) must never share one, or they'll silently overwrite each
// other's drafts. Prefix with the page name, e.g. "sales_cart", "analytics_dateFrom".

function readDraft<T>(key: string, initialValue: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw !== null) return JSON.parse(raw) as T
  } catch {
    // corrupt value or storage blocked (private browsing) -- start fresh
  }
  return initialValue
}

export function useSessionDraft<T>(key: string, initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>, () => void] {
  // initialValue is only ever read once (React's own useState lazy-init
  // rule) -- a ref avoids re-running a possibly-expensive factory on every
  // render just to throw the result away after the first.
  const initialRef = useRef(initialValue)
  const [value, setValue] = useState<T>(() => {
    const fallback = initialRef.current instanceof Function ? (initialRef.current as () => T)() : initialRef.current
    return readDraft(key, fallback)
  })

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage blocked or full -- this visit still works, it just won't
      // survive navigating away and back
    }
    // key is intentionally excluded: a call site's key is expected to be a
    // stable literal for the lifetime of the component, not something that
    // changes render to render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const clear = useCallback(() => {
    try { sessionStorage.removeItem(key) } catch { /* best-effort only */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return [value, setValue, clear]
}
