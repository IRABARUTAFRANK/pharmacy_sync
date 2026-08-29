import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode, type RefObject } from "react";

// Shared channel between the global keyboard-scanner listener (mounted once
// in App.tsx) and whichever page wants to react to a scan (SalesPage today,
// potentially others later) -- modeled directly on SearchProvider (./search.tsx):
// a single provider high in the tree, a hook for consumers, no page-specific
// logic living in here.
//
// State is deliberately just "the most recently recognized barcode" -- not a
// queue. If a second scan is recognized before the first is consumed, it
// simply overwrites the first (last-scan-wins); nothing here processes a
// backlog. That's a conscious Phase 1 decision, not an oversight.

interface ScannerContextValue {
  barcode: string | null;
  setBarcode: (code: string) => void;
  clearBarcode: () => void;
}

const ScannerContext = createContext<ScannerContextValue | null>(null);

export function ScannerProvider({ children }: { children: ReactNode }) {
  const [barcode, setBarcodeState] = useState<string | null>(null);
  const setBarcode = useCallback((code: string) => setBarcodeState(code), []);
  const clearBarcode = useCallback(() => setBarcodeState(null), []);
  return <ScannerContext.Provider value={{ barcode, setBarcode, clearBarcode }}>{children}</ScannerContext.Provider>;
}

export function useScanner(): ScannerContextValue {
  const ctx = useContext(ScannerContext);
  if (!ctx) throw new Error("useScanner() must be used inside <ScannerProvider>");
  return ctx;
}

// ── Detection ────────────────────────────────────────────────────────────
// A hand-rolled keydown parser (an earlier revision of this file) can't
// reliably reconstruct scanner input: "Barcode to PC"-style apps commonly
// type each character via Windows' Alt+Numpad Unicode method (so the
// character comes out right regardless of the receiving PC's keyboard
// layout), which arrives as `altKey: true` on every keystroke -- consistent
// with a modifier held down, not a clean character. The browser's own text
// input handling already composes that correctly, though, which is why
// scanning directly into a real, visible `<input>` always worked.
//
// So this keeps one real, invisible `<input>` focused whenever nothing else
// legitimately has focus, and reads its `.value` on Enter -- the browser's
// normal text composition does the hard part; this only decides when that
// hidden field should hold focus and what counts as "a scan" once Enter
// arrives. Confirmed working against a real device.

// Real barcodes in this system are longer than this (see
// generate_short_barcode_code() in the schema); this floor exists only to
// reject a trivially short accidental value, not to validate real codes --
// actual validity is entirely lookup_barcode()'s job, downstream of here.
const SCAN_MIN_LENGTH = 4;

// Anything that accepts typed text (or is content-editable) -- the ONLY
// kind of element the catcher must never take focus away from, because
// doing so mid-typing would actually break something. A <button> or <a>
// that merely *has* focus (every sidebar nav click leaves its button
// focused -- completely normal browser behavior, not an ongoing
// interaction) is not protected: its click already ran, so reclaiming focus
// from it afterward costs nothing and is exactly what lets scanning work
// again right after navigating anywhere via a button.
function isTextEntryFocused(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    const nonTextTypes = ["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"];
    return !nonTextTypes.includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

export interface ScannerCatcherHandle {
  inputRef: RefObject<HTMLInputElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

// `enabled` gates everything -- pass false and the catcher is never focused,
// never reclaims focus, and Enter on it (if it somehow had focus already)
// does nothing. Always call this hook unconditionally (React's rules of
// hooks); it's `enabled` that should vary -- see its call site in App.tsx
// for how that's derived from `access`/`hashRoute`. The returned `inputRef`/
// `onKeyDown` are meant to be spread onto one real, invisible `<input>`
// rendered from App.tsx (see the "scanner catcher" element there); this
// hook is the brain, that element is the body.
export function useBarcodeScannerListener(enabled: boolean): ScannerCatcherHandle {
  const { setBarcode } = useScanner();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!enabled) return;

    // Reclaims focus for the hidden catcher whenever nothing that actually
    // needs focus has it. isTextEntryFocused() is the one real boundary:
    // stand aside for a genuine input/textarea/select/contenteditable
    // (interrupting real typing is the one thing this must never do).
    // Everything else -- document.body, a just-clicked sidebar button, a
    // link, a modal's close button -- is fair game to reclaim from, since
    // none of those represent an ongoing interaction the way a focused text
    // field does.
    function claimFocusIfIdle() {
      const active = document.activeElement;
      const el = inputRef.current;
      if (!el || active === el || isTextEntryFocused(active)) return;
      el.focus({ preventScroll: true });
    }

    claimFocusIfIdle();
    document.addEventListener("focusin", claimFocusIfIdle);
    window.addEventListener("focus", claimFocusIfIdle);
    return () => {
      document.removeEventListener("focusin", claimFocusIfIdle);
      window.removeEventListener("focus", claimFocusIfIdle);
    };
  }, [enabled]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    const value = e.currentTarget.value.trim();
    e.currentTarget.value = "";
    if (value.length >= SCAN_MIN_LENGTH) {
      setBarcode(value);
    }
  }, [setBarcode]);

  return { inputRef, onKeyDown };
}
