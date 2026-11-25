import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  amsCalendarDate,
  type AmsActor,
  type AmsCommand,
  type AmsMember,
  type AmsRecord,
} from "@openams/contracts";
import { AmsError, type AmsRepository } from "./repository.js";
import { AmsService } from "./service.js";
import { calendarDays } from "./task-follow-up.js";
import { fileOriginalEmail } from "./correspondence.js";
import type { AmsFiles } from "./files.js";
import {
  DEMO_BOOK,
  DEMO_CARRIERS,
  DEMO_COVERAGES,
  DEMO_WORK,
  demoPolicyNumber,
  type DemoOwner,
} from "./demo-book.js";

type DemoCreate = (
  key: string,
  kind: AmsCommand["kind"],
  data: Record<string, unknown>,
) => Promise<AmsRecord>;
type DemoRun = (
  key: string,
  kind: AmsCommand["kind"],
  action: AmsCommand["action"],
  data: Record<string, unknown>,
  record?: AmsRecord,
) => Promise<{ records: AmsRecord[] }>;

const DemoInfo = z
  .object({
    tenantId: z.string().regex(/^local_demo_[a-f0-9]{24}$/),
    startedAt: z.string().datetime(),
    accountId: z.string(),
    policyId: z.string(),
    renewalId: z.string(),
    taskId: z.string(),
    emailId: z.string(),
    serviceId: z.string(),
  })
  .strict();
export type AmsDemoInfo = z.infer<typeof DemoInfo>;
const State = z
  .object({
    commandId: z.string().uuid(),
    startedAt: z.string().datetime(),
    tenantId: z.string().regex(/^local_demo_[a-f0-9]{24}$/),
    info: DemoInfo.nullable(),
    previous: DemoInfo.optional(),
  })
  .strict();
type DemoState = z.infer<typeof State>;
export const DemoStartInput = z
  .object({
    commandId: z.string().uuid(),
    restart: z.boolean().default(false),
    expectedTenantId: z.string().nullable().default(null),
  })
  .strict();
export function localDemoToken(token: string) {
  return createHash("sha256").update(`openams-demo-v1:${token}`).digest("hex");
}

/** Only the explicit loopback entrypoint constructs this controller. No cloud/provider access. */
export class LocalAmsDemo {
  private state: DemoState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private repository: AmsRepository,
    private files: AmsFiles,
    private members: AmsMember[],
  ) {}
  async load() {
    try {
      this.state = State.parse(
        JSON.parse(
          await readFile(join(this.directory, "demo-state.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  info() {
    return this.state?.info ?? this.state?.previous ?? null;
  }
  private async persist(state: DemoState) {
    const file = join(this.directory, "demo-state.json");
    await writeFile(`${file}.pending`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${file}.pending`, file);
    this.state = state;
  }
  /**
   * Fills a tenant with the fictional agency without touching the single local demo
   * above. The public demo uses it to give each visitor their own copy.
   */
  seed(input: { tenantId: string; commandId: string; startedAt: string }) {
    return this.populate({ ...input, info: null });
  }
  start(input: z.infer<typeof DemoStartInput>): Promise<AmsDemoInfo> {
    const run = this.queue.then(() => this.prepare(input));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async prepare(input: z.infer<typeof DemoStartInput>) {
    const current = this.state;
    if (current?.commandId === input.commandId && current.info)
      return current.info;
    if (!input.restart && current?.info) return current.info;
    if (
      current?.commandId !== input.commandId &&
      !(current && !current.info && !input.restart)
    ) {
      if (current && !current.info)
        throw new AmsError(
          409,
          "demo_preparing",
          "A demo is being prepared. Retry its original start request.",
        );
      if (input.restart && input.expectedTenantId !== current?.tenantId)
        throw new AmsError(
          409,
          "demo_changed",
          "The demo changed. Refresh before starting a fresh copy.",
        );
      const tenantId = `local_demo_${createHash("sha256").update(input.commandId).digest("hex").slice(0, 24)}`;
      await this.persist({
        commandId: input.commandId,
        tenantId,
        startedAt: new Date().toISOString(),
        info: null,
        ...(current?.info ? { previous: current.info } : {}),
      });
    }
    const state = this.state!;
    const info = await this.populate(state);
    await this.persist({ ...state, info, previous: undefined });
    return info;
  }
  /**
   * The rest of the fictional book around the walkthrough account: households and
   * small businesses, their policies (some with a prior term) and a renewal for every
   * relationship expiring in the next four months.
   */
  private async seedBook(input: {
    date: string;
    startedAt: string;
    create: DemoCreate;
    run: DemoRun;
    memberId: (role: DemoOwner) => string;
  }) {
    const { date, create, run, memberId } = input;
    const digits = (key: string) =>
      BigInt(`0x${createHash("sha256").update(key).digest("hex").slice(0, 15)}`)
        .toString()
        .padStart(10, "0");
    const slug = (name: string) =>
      name
        .toLowerCase()
        .replace(/[^a-z]+/g, ".")
        .replace(/^\.|\.$/g, "");
    const issue = async (key: string, data: Record<string, unknown>) => {
      const draft = await create(key, "policies", data);
      await run(
        `${key}:issue`,
        "policies",
        "policy.issue",
        {
          sourceReference: "Fictional declarations page",
        },
        draft,
      );
      return draft;
    };
    const accounts = new Map<string, string>();
    const policies = new Map<string, string>();
    for (const entry of DEMO_BOOK) {
      const domain = entry.email.split("@")[1];
      const account = await create(`book:${entry.key}`, "accounts", {
        name: entry.name,
        ...(entry.legalName ? { legalName: entry.legalName } : {}),
        type: entry.type,
        status: entry.status ?? "active",
        ...(entry.industry ? { industry: entry.industry } : {}),
        email: entry.email,
        phone: entry.phone,
        ...(entry.website ? { website: entry.website } : {}),
        producerId: memberId(entry.producer),
        serviceOwnerId: memberId(entry.service),
        ...(entry.source ? { source: entry.source } : {}),
        tags: entry.tags ?? [],
        ...(entry.notes ? { notes: entry.notes } : {}),
        address: {
          line1: entry.street,
          city: entry.city,
          state: "WI",
          postalCode: entry.postalCode,
        },
      });
      for (const [index, contact] of entry.contacts.entries())
        await create(`book:${entry.key}:contact:${index}`, "contacts", {
          accountId: account.id,
          name: contact.name,
          ...(contact.title ? { title: contact.title } : {}),
          email:
            index === 0 || entry.type === "business"
              ? index === 0
                ? entry.email
                : `${slug(contact.name.replace(/^Dr\. /, "").split(" ")[0])}@${domain}`
              : "",
          phone: index === 0 ? entry.phone : "",
          primary: index === 0,
        });
      for (const [index, exposure] of (entry.exposures ?? []).entries())
        await create(`book:${entry.key}:exposure:${index}`, "exposures", {
          accountId: account.id,
          kind: exposure.kind,
          name: exposure.name,
          values: exposure.values,
        });
      accounts.set(entry.key, account.id);
      const renewals = new Map<number, string[]>();
      for (const [index, policy] of entry.policies.entries()) {
        const key = `book:${entry.key}:policy:${index}`;
        const expirationDate = calendarDays(date, policy.expires);
        const effectiveDate = calendarDays(expirationDate, -365);
        const common = {
          accountId: account.id,
          line: policy.line,
          billing: policy.billing ?? "direct",
          commissionBps: Math.round(policy.commission * 100),
          producerId: memberId(entry.producer),
          sourceReference: "Fictional declarations page",
          coverages: DEMO_COVERAGES[policy.line] ?? [],
        };
        let previousPolicyId: string | null = null;
        if (policy.priorPremium) {
          const carrier = policy.priorCarrier ?? policy.carrier;
          const prior = await issue(`${key}:prior`, {
            ...common,
            number: demoPolicyNumber(
              carrier,
              policy.line,
              digits(`${key}:prior`),
            ),
            carrier: DEMO_CARRIERS[carrier],
            effectiveDate: calendarDays(effectiveDate, -365),
            expirationDate: effectiveDate,
            premiumCents: policy.priorPremium * 100,
          });
          previousPolicyId = prior.id;
        }
        const current = await issue(key, {
          ...common,
          number: demoPolicyNumber(
            policy.carrier,
            policy.line,
            digits(
              previousPolicyId && !policy.priorCarrier ? `${key}:prior` : key,
            ),
          ),
          carrier: DEMO_CARRIERS[policy.carrier],
          effectiveDate,
          expirationDate,
          premiumCents: policy.premium * 100,
          ...(previousPolicyId ? { previousPolicyId } : {}),
        });
        policies.set(`${entry.key}:${policy.line}`, current.id);
        if (policy.expires <= 120)
          renewals.set(policy.expires, [
            ...(renewals.get(policy.expires) ?? []),
            current.id,
          ]);
      }
      for (const [expires, policyIds] of renewals) {
        const plan = entry.renewal;
        const stage =
          plan?.stage ??
          (expires <= 30 ? "proposal" : expires <= 60 ? "marketing" : "review");
        const key = `book:${entry.key}:renewal:${expires}`;
        const renewal = await create(key, "renewals", {
          accountId: account.id,
          title: `${entry.name} · ${calendarDays(date, expires).slice(0, 4)} renewal`,
          policyIds,
          expirationDate: calendarDays(date, expires),
          ownerId: memberId(entry.service),
          nextAction:
            plan?.nextAction ?? "Review renewal terms with the client",
          ...(plan?.waitingOn ? { waitingOn: plan.waitingOn } : {}),
          followUpDate: calendarDays(
            date,
            plan?.followUp ?? Math.min(expires - 7, 14),
          ),
          ...(plan?.notes ? { notes: plan.notes } : {}),
        });
        // New renewals start in review; later stages are a change, as in the app.
        if (stage !== "review")
          await run(`${key}:stage`, "renewals", "update", { stage }, renewal);
      }
    }
    const on = (account: string, line?: string) => ({
      accountId: accounts.get(account)!,
      ...(line ? { policyId: policies.get(`${account}:${line}`)! } : {}),
    });
    for (const [index, task] of DEMO_WORK.tasks.entries()) {
      const created = await create(`work:task:${index}`, "tasks", {
        ...on(task.account, task.line),
        title: task.title,
        description: task.description,
        ownerId: memberId(task.owner),
        dueDate: calendarDays(date, task.due),
        priority: task.priority ?? "normal",
      });
      if (task.status && task.status !== "open")
        await run(
          `work:task:${index}:status`,
          "tasks",
          "update",
          { status: task.status },
          created,
        );
    }
    for (const [index, item] of DEMO_WORK.services.entries()) {
      const created = await create(`work:service:${index}`, "services", {
        ...on(item.account, item.line),
        type: item.type,
        title: item.title,
        description: item.description,
        ownerId: memberId(item.owner),
        dueDate: calendarDays(date, item.due),
      });
      if (item.status && item.status !== "open")
        await run(
          `work:service:${index}:status`,
          "services",
          "update",
          { status: item.status },
          created,
        );
    }
    for (const [index, claim] of DEMO_WORK.claims.entries())
      await create(`work:claim:${index}`, "claims", {
        ...on(claim.account, claim.line),
        dateOfLoss: calendarDays(date, -claim.lossDaysAgo),
        reportedDate: calendarDays(date, -claim.reportedDaysAgo),
        description: claim.description,
        ...(claim.claimNumber ? { claimNumber: claim.claimNumber } : {}),
        status: claim.status,
        ...(claim.adjuster ? { adjuster: claim.adjuster } : {}),
        ownerId: memberId(claim.owner),
        followUpDate: calendarDays(date, claim.followUp),
        reserveCents: (claim.reserve ?? 0) * 100,
        paidCents: (claim.paid ?? 0) * 100,
      });
    for (const [index, note] of DEMO_WORK.notes.entries())
      await create(`work:note:${index}`, "notes", {
        ...on(note.account),
        category: note.category,
        occurredAt: new Date(
          new Date(input.startedAt).getTime() - note.daysAgo * 86_400_000,
        ).toISOString(),
        body: note.body,
      });
  }
  private async populate(state: DemoState): Promise<AmsDemoInfo> {
    const { tenantId, startedAt } = state;
    const actor: AmsActor = {
      tenantId,
      userId: "local_admin",
      name: "Alex Morgan",
      role: "admin",
    };
    const service = new AmsService({
      repository: this.repository,
      members: async () => this.members,
      now: () => new Date(startedAt),
      timeZone: async () => "America/Chicago",
    });
    const date = amsCalendarDate(new Date(startedAt), "America/Chicago");
    const id = (key: string) => {
      const hash = createHash("sha256")
        .update(`${state.commandId}:${key}`)
        .digest("hex");
      return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    };
    const memberId = (role: DemoOwner) =>
      this.members.find((member) => member.role === role)?.id ?? actor.userId;
    const receipt = (key: string) =>
      this.repository.transact(tenantId, (tx) => tx.receipt(id(key)));
    const run = async (
      key: string,
      kind: AmsCommand["kind"],
      action: AmsCommand["action"],
      data: Record<string, unknown>,
      record?: AmsRecord,
    ) => {
      const prior = await receipt(key);
      if (prior) return prior.result;
      return service.execute(actor, {
        id: id(key),
        kind,
        action,
        data,
        reason: "Fictional walkthrough example; no external action.",
        ...(record
          ? { recordId: record.id, expectedVersion: record.version }
          : {}),
      });
    };
    const create = async (
      key: string,
      kind: AmsCommand["kind"],
      data: Record<string, unknown>,
    ) =>
      (await run(key, kind, "create", data)).records.find(
        (r) => r.kind === kind,
      )!;
    await run("workspace", "workspace", "workspace.configure", {
      name: "Harbor Agency · Demo",
      timeZone: "America/Chicago",
      email: "hello@harbor.example.test",
      phone: "555-0100",
      billingMode: "direct",
      adoptionMode: "alongside",
      sourceSystem: "Fictional demo",
      emailPlan: "manual",
      accountingPlan: "external",
      defaultOwnerId: actor.userId,
      calendarAcknowledged: true,
    });
    const account = await create("account", "accounts", {
      name: "Harbor & Pine Construction",
      legalName: "Harbor & Pine Construction LLC",
      status: "active",
      email: "morgan@harborpine.example.test",
      phone: "555-0142",
      producerId: actor.userId,
      serviceOwnerId: "local_member",
      address: {
        line1: "125 Example Lane",
        city: "Madison",
        state: "WI",
        postalCode: "53703",
      },
      notes:
        "Fictional commercial contractor. Review the client's updated payroll before the upcoming renewal.",
    });
    await create("contact", "contacts", {
      accountId: account.id,
      name: "Morgan Chen",
      email: "morgan@harborpine.example.test",
      phone: "555-0142",
      title: "Owner",
      primary: true,
    });
    await create("contact-office", "contacts", {
      accountId: account.id,
      name: "Riley Brooks",
      email: "riley@harborpine.example.test",
      phone: "555-0143",
      title: "Office manager",
    });
    await create("location", "exposures", {
      accountId: account.id,
      kind: "location",
      name: "Main office and workshop",
      values: {
        address: "125 Example Lane, Madison, WI",
        squareFeet: 4200,
        construction: "Masonry",
      },
    });
    const draft = await create("policy", "policies", {
      accountId: account.id,
      number: "DEMO-GL-1042",
      line: "General liability",
      carrier: "Example Mutual (fictional)",
      effectiveDate: calendarDays(date, -320),
      expirationDate: calendarDays(date, 45),
      premiumCents: 840000,
      commissionBps: 1200,
      billing: "direct",
      producerId: actor.userId,
      sourceReference: "Fictional declaration for walkthrough only",
      coverages: [
        { name: "Each occurrence", limit: "$1,000,000", deductible: "$1,000" },
        { name: "General aggregate", limit: "$2,000,000" },
      ],
    });
    await run(
      "issue",
      "policies",
      "policy.issue",
      { sourceReference: "Fictional declaration for walkthrough only" },
      draft,
    );
    const policy = (await this.repository.get(tenantId, "policies", draft.id))!;
    const renewal = await create("renewal", "renewals", {
      accountId: account.id,
      title: "Harbor & Pine · annual renewal",
      policyIds: [policy.id],
      expirationDate: policy.data.expirationDate,
      ownerId: actor.userId,
      nextAction: "Review updated payroll and confirm changes with Morgan",
      followUpDate: date,
    });
    const task = await create("task", "tasks", {
      accountId: account.id,
      policyId: policy.id,
      title: "Review Harbor & Pine's updated payroll",
      description:
        "Open the filed email, check the payroll attachment, and complete this follow-up. Log a call or note with the next step.",
      ownerId: actor.userId,
      dueDate: date,
      priority: "high",
    });
    await run(
      "followup",
      "tasks",
      "task.followUp",
      {
        reminderDaysBefore: 0,
        escalationAfterDays: 2,
        escalationOwnerId: "local_manager",
      },
      task,
    );
    const serviceRequest = await create("service", "services", {
      accountId: account.id,
      policyId: policy.id,
      type: "certificate",
      title: "Certificate requested for a new project",
      description:
        "Fictional request. Confirm holder details and contract requirements before preparing evidence.",
      ownerId: "local_member",
      dueDate: calendarDays(date, 2),
    });
    await create("note", "notes", {
      accountId: account.id,
      category: "note",
      occurredAt: startedAt,
      body: "Morgan has shared updated payroll for the renewal. Open Correspondence to review the original email and attachment.",
    });
    await this.seedBook({ date, startedAt, create, run, memberId });
    let filed = (await receipt("email"))?.result;
    if (!filed) {
      const bytes = Buffer.from(
        [
          "From: Morgan Chen <morgan@harborpine.example.test>",
          "To: Alex Morgan <alex@harbor.example.test>",
          "Subject: Updated payroll for our renewal",
          `Date: ${new Date(startedAt).toUTCString()}`,
          `Message-ID: <${state.commandId}@demo.example.test>`,
          "MIME-Version: 1.0",
          'Content-Type: multipart/mixed; boundary="harbor-demo"',
          "",
          "--harbor-demo",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Hi Alex,\r\n\r\nOur updated annual payroll is $620,000, with eight employees. The worksheet is attached. We have not added any locations. Could you give me a call about the renewal this week?\r\n\r\nThanks,\r\nMorgan\r\n\r\nFictional demo message.",
          "--harbor-demo",
          "Content-Type: text/csv",
          'Content-Disposition: attachment; filename="renewal-payroll.csv"',
          "",
          "Class,Employees,Annual payroll\r\nCarpentry,6,480000\r\nOffice,2,140000",
          "--harbor-demo--",
          "",
        ].join("\r\n"),
      );
      const currentAccount = (await this.repository.get(
        tenantId,
        "accounts",
        account.id,
      ))!;
      filed = await fileOriginalEmail({
        actor,
        accountId: account.id,
        filing: {
          commandId: id("email"),
          expectedVersion: currentAccount.version,
          policyId: policy.id,
          direction: "inbound",
          shareWithAgency: true,
        },
        bytes,
        filename: "morgan-renewal.eml",
        repository: this.repository,
        files: this.files,
        service,
      });
    }
    await service.processDueReminders(tenantId);
    return {
      tenantId,
      startedAt,
      accountId: account.id,
      policyId: policy.id,
      renewalId: renewal.id,
      taskId: task.id,
      emailId: filed.records.find((r) => r.kind === "correspondence")!.id,
      serviceId: serviceRequest.id,
    };
  }
}

/**
 * The demo agency's team chat: a short, fictional morning of messages, timed back
 * from `now`. `read` marks what the administrator (the demo's default person) has
 * already seen, so the demo opens with a couple of unread messages.
 */
export function demoChat(members: AmsMember[], now: Date) {
  const id = (role: AmsMember["role"]) =>
    members.find((member) => member.role === role)!.id;
  const first = (role: AmsMember["role"]) =>
    members.find((member) => member.role === role)!.name.split(" ")[0];
  const at = (minutesAgo: number) =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const admin = id("admin");
  const manager = id("manager");
  const member = id("member");
  const accountant = id("accountant");
  const direct = (other: string) => ({ with: [admin, other] as const });
  return [
    {
      team: true,
      authorId: manager,
      minutes: 185,
      read: true,
      body: "Morning, team. Midwest Freight and Lakeview Dental renewals are the priority this week. Both are inside 40 days.",
    },
    {
      team: true,
      authorId: accountant,
      minutes: 130,
      read: true,
      body: "Lakeshore and Northwoods commission statements came in. I'll reconcile them after lunch.",
    },
    {
      ...direct(member),
      authorId: admin,
      minutes: 95,
      read: true,
      body: "Can you take the Fox River lender certificates and Harbor & Pine's new project certificate?",
    },
    {
      ...direct(member),
      authorId: member,
      minutes: 90,
      read: true,
      body: "Yes. Also heads up: Jessica Miller got a non-pay cancellation notice. Calling her this morning.",
    },
    {
      team: true,
      authorId: member,
      minutes: 50,
      read: false,
      body: "The certificate for Harbor & Pine's new project is drafted.",
    },
    {
      team: true,
      authorId: manager,
      minutes: 46,
      read: false,
      body: `Thanks, ${first("member")}. Send it to me before it goes out.`,
    },
    {
      ...direct(manager),
      authorId: manager,
      minutes: 12,
      read: false,
      body: `Can you look over the updated payroll before you call Morgan?`,
    },
  ].map(({ minutes, ...message }) => ({ ...message, createdAt: at(minutes) }));
}
/** Fictional teammates' presence, measured from now: one online, others earlier. */
export function demoSeen(members: AmsMember[], now: Date) {
  const id = (role: AmsMember["role"]) =>
    members.find((member) => member.role === role)?.id;
  const at = (minutesAgo: number) =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  return Object.fromEntries(
    [
      [id("manager"), at(0)],
      [id("member"), at(22)],
      [id("accountant"), at(190)],
    ].filter(([member]) => member),
  ) as Record<string, string>;
}
