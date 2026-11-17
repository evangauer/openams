import assert from "node:assert/strict";
import {
  AMS_KINDS,
  AMS_FINANCIAL_KINDS,
  AMS_SUGGESTION_AREAS,
  AMS_SUGGESTION_STATUSES,
  amsCanRead,
  amsCanWrite,
  type AmsRole,
} from "@openams/contracts";
import { ROLE_GUIDE } from "../src/features/agency/roles";
import { canAssignRole } from "../src/features/agency/identity-model";
import {
  AREA_LABELS,
  OPENAMS_ISSUES_URL,
  STATUS_LABELS,
  invitationMessage,
  shareUrl,
} from "../src/features/agency/team-suggestions-model";

const roles: AmsRole[] = ["admin", "manager", "member", "accountant", "viewer"];
const nonFinancial = AMS_KINDS.filter(
  (kind) => !AMS_FINANCIAL_KINDS.includes(kind) && kind !== "workspace" && kind !== "suggestions" && kind !== "certificatetemplates",
);

// The role guide must describe what the permission rules actually allow.
for (const role of roles) assert.ok(ROLE_GUIDE[role], `${role} has a guide entry`);
const writesFinancials = (role: AmsRole) =>
  AMS_FINANCIAL_KINDS.every((kind) => amsCanWrite(role, kind));
const readsFinancials = (role: AmsRole) =>
  AMS_FINANCIAL_KINDS.every((kind) => amsCanRead(role, kind));
assert.ok(writesFinancials("admin") && writesFinancials("manager"), "admins and managers work financials");
assert.ok(amsCanWrite("admin", "workspace") && amsCanWrite("manager", "workspace"), "both change setup");
assert.ok(!amsCanWrite("member", "workspace") && !amsCanWrite("accountant", "workspace"));
assert.ok(!readsFinancials("member") && !readsFinancials("viewer"), "members and viewers do not see financials");
assert.ok(writesFinancials("accountant") && readsFinancials("accountant"));
assert.ok(
  AMS_KINDS.every((kind) => amsCanRead("accountant", kind)),
  "the guide says accountants read every record",
);
for (const kind of ["accounts", "policies", "renewals"] as const)
  assert.ok(!amsCanWrite("accountant", kind), `accountants cannot change ${kind}`);
for (const kind of ["notes", "tasks", "documents"] as const)
  assert.ok(amsCanWrite("accountant", kind), `accountants add ${kind}`);
assert.ok(nonFinancial.every((kind) => amsCanWrite("member", kind) || kind === "policychanges" || kind === "reminders" || kind === "correspondence"));
assert.ok(nonFinancial.every((kind) => !amsCanWrite("viewer", kind)), "viewers change no records");
assert.ok(roles.every((role) => amsCanWrite(role, "suggestions")), "everyone may suggest");
// Team management claims.
assert.ok(roles.every((role) => canAssignRole("admin", role)), "administrators invite anyone");
assert.ok(!canAssignRole("manager", "admin") && canAssignRole("manager", "member"));
assert.ok(!canAssignRole("member", "viewer"), "members do not manage the team");

// Inviting someone never claims OpenAMS sent an email.
const message = invitationMessage(
  { email: "casey@harbor.example.test", role: "viewer" },
  "Harbor Agency",
  "https://agency.example.test",
);
assert.match(message, /Harbor Agency/);
assert.match(message, /casey@harbor\.example\.test/);
assert.match(message, /as viewer/);
assert.doesNotMatch(message, /we (have )?(sent|emailed)/i);

// Sharing opens a reviewed, pre-filled issue on the project and nothing else.
const url = new URL(
  shareUrl({
    title: "Send renewal reminder letters in bulk & more",
    detail: "Line one\nLine two",
    area: "renewals",
  }),
);
assert.equal(`${url.origin}${url.pathname}`, OPENAMS_ISSUES_URL);
assert.equal(url.searchParams.get("template"), "workflow_request.md");
assert.equal(url.searchParams.get("title"), "Send renewal reminder letters in bulk & more");
assert.match(url.searchParams.get("body") ?? "", /Line one\nLine two/);
assert.match(url.searchParams.get("body") ?? "", /fictional examples/);
for (const area of AMS_SUGGESTION_AREAS) assert.ok(AREA_LABELS[area], `${area} has a label`);
for (const status of AMS_SUGGESTION_STATUSES) assert.ok(STATUS_LABELS[status], `${status} has a label`);

console.log(
  "PASS team and suggestions: role guide matches permissions, invitations and sharing stay honest.",
);
