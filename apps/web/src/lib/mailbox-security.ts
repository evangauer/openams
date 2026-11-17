/** A mailbox callback must not load third-party resources while it handles a code. */
export function mailboxCallbackPolicy(nonce: string) {
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}
