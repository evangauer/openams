import type { AmsRole } from "@openams/contracts";

/**
 * Plain-language role guide. Each line mirrors amsCanRead/amsCanWrite in
 * packages/contracts and the team rules in identity-model.ts; change them together.
 */
export const ROLE_GUIDE: Record<
  AmsRole,
  { label: string; summary: string; can: string[]; cannot: string[]; example: string }
> = {
  admin: {
    label: "Administrator",
    summary: "Runs the workspace: agency setup, the whole team and every record.",
    can: ["Change agency setup", "Invite and manage anyone", "Work every record, financials included"],
    cannot: [],
    example: "The agency principal or office manager who owns the system.",
  },
  manager: {
    label: "Manager",
    summary: "Keeps the book and the team running, except administrators.",
    can: ["Change agency setup", "Invite and manage everyone but administrators", "Work every record, financials included"],
    cannot: ["Change or remove an administrator"],
    example: "A service manager who assigns renewals and checks the team’s work.",
  },
  member: {
    label: "Member",
    summary: "Handles day-to-day service work on accounts.",
    can: ["Work accounts, policies, renewals, tasks and documents", "Read the agency’s non-financial records"],
    cannot: ["See or change financial records", "Change agency setup, approve form templates or manage the team"],
    example: "An account manager or CSR working renewals and service requests.",
  },
  accountant: {
    label: "Accountant",
    summary: "Works the money: commissions, statements, invoices and payments.",
    can: ["Work financial records", "Add notes, tasks and documents", "Read every record"],
    cannot: ["Change accounts, policies or renewals", "Change agency setup, approve form templates or manage the team"],
    example: "The bookkeeper who reconciles carrier statements each month.",
  },
  viewer: {
    label: "Viewer",
    summary: "Reads the book without changing it.",
    can: ["Read non-financial records", "Suggest and support features"],
    cannot: ["Change records", "See financial records"],
    example: "A producer who checks coverage but works in another system.",
  },
};
