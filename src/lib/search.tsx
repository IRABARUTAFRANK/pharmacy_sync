import { createContext, useContext, useState, type ReactNode } from "react";

// The top bar's one global search box (App.tsx) needs to reach whichever
// page is currently on screen, and each page already owns its own local
// filter state -- this context is the shared channel between them. Modeled
// on I18nProvider (./i18n/index.tsx): a single provider high in the tree,
// a hook for consumers.

interface SearchContextValue {
  term: string;
  setTerm: (term: string) => void;
}

const SearchContext = createContext<SearchContextValue | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const [term, setTerm] = useState("");
  return <SearchContext.Provider value={{ term, setTerm }}>{children}</SearchContext.Provider>;
}

export function useGlobalSearch(): SearchContextValue {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error("useGlobalSearch() must be used inside <SearchProvider>");
  return ctx;
}
