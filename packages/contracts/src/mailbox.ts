export type AmsMailboxProvider = "gmail" | "microsoft365";
export type AmsMailboxMessageStatus =
  "review" | "filing" | "filed" | "dismissed" | "error" | "unavailable";
export type AmsMailboxError = { code: string; message: string } | null;
export interface AmsMailbox {
  id: string;
  revision: number;
  provider: AmsMailboxProvider;
  address: string;
  state: "choose_folder" | "connected" | "disconnected";
  folder: {
    id: string;
    name: string;
    since: string;
    consentBy: string;
    consentAt: string;
  } | null;
  hasMore: boolean;
  syncing: boolean;
  lastAttemptAt: string | null;
  lastSyncedAt: string | null;
  nextAttemptAt: string | null;
  error: AmsMailboxError;
}
export interface AmsIncomingMessage {
  id: string;
  revision: number;
  connectionId: string;
  queuedAt: string;
  receivedAt: string | null;
  status: AmsMailboxMessageStatus;
  subject: string;
  from: string;
  to: string;
  body: string;
  bodyTruncated: boolean;
  attachmentCount: number;
  direction: "inbound" | "outbound" | "unknown";
  originalAvailable: boolean;
  bytes: number | null;
  accountId: string | null;
  policyId: string | null;
  correspondenceId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewReason: string;
  error: AmsMailboxError;
}
export interface AmsMailboxList {
  items: AmsMailbox[];
  nextCursor: string | null;
  providers: { provider: AmsMailboxProvider; configured: boolean }[];
  syncMode: "manual";
}
export interface AmsMailboxFolderPage {
  folders: { id: string; name: string; hasChildren: boolean }[];
  next: string | null;
}
