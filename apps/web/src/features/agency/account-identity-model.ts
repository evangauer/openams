import { findAccount, type AmsRecord, type Book } from "./model";

export function canonicalAccountId(
  book: Book,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  const account = findAccount(book, id);
  return account?.data.consolidation?.targetId || id;
}
export function accountIdentities(
  book: Book,
  id: string,
): AmsRecord<"accounts">[] {
  const root = canonicalAccountId(book, id);
  return [...(book.accounts || []), ...(book.archivedAccounts || [])].filter(
    (row) => canonicalAccountId(book, row.id) === root,
  ) as AmsRecord<"accounts">[];
}
export function sameAccount(
  book: Book,
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return Boolean(
    left &&
      right &&
      canonicalAccountId(book, left) === canonicalAccountId(book, right),
  );
}
const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");
const phone = (value: string) =>
  value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
/** Review hints only: shared phones/addresses do not prove a duplicate. */
export function accountDuplicateCandidates(
  account: AmsRecord<"accounts">,
  book: Book,
) {
  const d = account.data;
  return ((book.accounts || []) as AmsRecord<"accounts">[])
    .filter(
      (other) =>
        !other.archivedAt &&
        !other.data.consolidation &&
        !sameAccount(book, account.id, other.id),
    )
    .map((other) => {
      const o = other.data;
      const reasons: string[] = [];
      const names = [d.name, d.legalName, d.dba].filter(Boolean).map(normalize);
      if (
        [o.name, o.legalName, o.dba].some(
          (name) =>
            normalize(name).length >= 3 && names.includes(normalize(name)),
        )
      )
        reasons.push("Matching name");
      if (
        d.email.trim() &&
        d.email.trim().toLowerCase() === o.email.trim().toLowerCase()
      )
        reasons.push("Same email");
      if (phone(d.phone).length >= 7 && phone(d.phone) === phone(o.phone))
        reasons.push("Same phone");
      if (
        d.address.line1 &&
        d.address.postalCode &&
        normalize(d.address.line1) === normalize(o.address.line1) &&
        normalize(d.address.postalCode) === normalize(o.address.postalCode)
      )
        reasons.push("Same street and ZIP");
      return { account: other, reasons };
    })
    .filter((item) => item.reasons.length)
    .sort(
      (a, b) =>
        b.reasons.length - a.reasons.length ||
        a.account.data.name.localeCompare(b.account.data.name),
    );
}
