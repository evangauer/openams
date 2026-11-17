"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Draft = { body: string; category: string };
const empty: Draft = { body: "", category: "note" };
const Drafts = createContext<{
  drafts: Record<string, Draft>;
  update: (accountId: string, change: Partial<Draft>) => void;
} | null>(null);

/** Unsaved working text survives in-app navigation only. It is never written to
 * browser storage or treated as an operational record. The provider is keyed to
 * the authenticated tenant/actor/role so switching identity clears the drafts. */
export function AccountDraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const dirty = Object.values(drafts).some((draft) => draft.body.trim());
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const value = useMemo(
    () => ({
      drafts,
      update: (accountId: string, change: Partial<Draft>) =>
        setDrafts((previous) => ({
          ...previous,
          [accountId]: { ...(previous[accountId] || empty), ...change },
        })),
    }),
    [drafts],
  );
  return <Drafts.Provider value={value}>{children}</Drafts.Provider>;
}

export function useAccountDraft(accountId: string) {
  const context = useContext(Drafts);
  if (!context)
    throw new Error("Account drafts require the agency session provider.");
  const draft = context.drafts[accountId] || empty;
  return {
    ...draft,
    setBody: (body: string) => context.update(accountId, { body }),
    setCategory: (category: string) => context.update(accountId, { category }),
  };
}
