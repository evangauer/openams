"use client";
import { useState } from "react";
import { ListChecks, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAccountCommand } from "./account-command";
import { today, type AgencySession, type AmsRecord } from "./model";

type Step = {
  title: string;
  description: string;
  ownerId: string | null;
  dueDate: string;
  priority: "normal" | "high";
};
export const workflowTemplates = {
  renewal: {
    title: "Renewal review",
    steps: [
      "Review expiring coverage and open service items",
      "Request updated exposures and loss information",
      "Review received documents and prepare marketing",
      "Compare carrier terms and prepare client proposal",
      "Follow up on client decision and confirm issued terms",
    ],
  },
  onboarding: {
    title: "New account onboarding",
    steps: [
      "Confirm legal entities, contacts, and account team",
      "Collect current policy documents and exposure schedules",
      "Review coverage needs and open questions",
      "Confirm next actions with the client",
    ],
  },
  certificate: {
    title: "Certificate request",
    steps: [
      "Confirm holder, contract requirements, and requested evidence",
      "Review applicable policies and endorsements",
      "Prepare and review certificate evidence",
      "Record delivery and retain the issued document",
    ],
  },
  claim: {
    title: "Claim follow-up",
    steps: [
      "Record reported loss and applicable policy term",
      "Confirm carrier reporting and claim reference",
      "Record adjuster contact and client follow-up",
    ],
  },
} as const;
type Template = keyof typeof workflowTemplates;
export function AccountWorkflowLauncher({
  account,
  session,
  saved,
}: {
  account: AmsRecord<"accounts">;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="account-text-button" onClick={() => setOpen(true)}>
        <ListChecks size={14} />
        Start workflow
      </button>
      {open && (
        <WorkflowDialog
          account={account}
          session={session}
          saved={saved}
          close={() => setOpen(false)}
        />
      )}
    </>
  );
}
function WorkflowDialog({
  account,
  session,
  saved,
  close,
}: {
  account: AmsRecord<"accounts">;
  session: AgencySession;
  saved: (records: AmsRecord[]) => void;
  close: () => void;
}) {
  const owner =
    account.data.serviceOwnerId ||
    (session.members.some(
      (m) => m.id === session.defaultOwnerId && m.active && m.role !== "viewer",
    )
      ? session.defaultOwnerId
      : null) ||
    session.actor.userId;
  const makeSteps = (template: Template): Step[] =>
    workflowTemplates[template].steps.map((title) => ({
      title,
      description: "",
      ownerId: owner,
      dueDate: today(session.timeZone),
      priority: "normal",
    }));
  const [template, setTemplate] = useState<Template>("renewal");
  const [title, setTitle] = useState<string>(workflowTemplates.renewal.title);
  const [steps, setSteps] = useState<Step[]>(() => makeSteps("renewal"));
  const mutation = useAccountCommand(saved);
  const setStep = (index: number, patch: Partial<Step>) =>
    setSteps((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.busy && !mutation.uncertain) close();
      }}
    >
      <DialogContent
        data-brand="relay"
        className="agency-dialog account-profile-dialog"
      >
        <DialogHeader>
          <DialogTitle>Start an account workflow</DialogTitle>
          <DialogDescription>
            Review the steps, owners, and dates for {account.data.name}. Each
            step becomes an assigned task in Next up.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await mutation.run(() => ({
                id: crypto.randomUUID(),
                action: "account.startWorkflow",
                kind: "accounts",
                recordId: account.id,
                expectedVersion: account.version,
                reason: "",
                data: { title, steps },
              }))
            )
              close();
          }}
        >
          <fieldset
            className="account-profile-form"
            disabled={mutation.busy || mutation.uncertain}
          >
            <label>
              Starting template
              <select
                aria-label="Starting template"
                value={template}
                onChange={(e) => {
                  const next = e.target.value as Template;
                  setTemplate(next);
                  setTitle(workflowTemplates[next].title);
                  setSteps(makeSteps(next));
                }}
              >
                {Object.entries(workflowTemplates).map(([id, item]) => (
                  <option key={id} value={id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Workflow title
              <input
                required
                value={title}
                maxLength={500}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <p className="account-profile-help">
              Set dates for your agency’s process. Completing these tasks
              records work; it does not send messages, issue documents, or bind
              coverage.
            </p>
            <ol className="account-workflow-steps">
              {steps.map((step, index) => (
                <li key={index}>
                  <div className="account-workflow-step-heading">
                    <span>Step {index + 1}</span>
                    <button
                      className="agency-icon-button"
                      type="button"
                      aria-label={`Remove step ${index + 1}`}
                      disabled={steps.length === 1}
                      onClick={() =>
                        setSteps((rows) => rows.filter((_, i) => i !== index))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <label>
                    Task title
                    <input
                      required
                      maxLength={500}
                      value={step.title}
                      onChange={(e) =>
                        setStep(index, { title: e.target.value })
                      }
                    />
                  </label>
                  <div className="account-workflow-step-fields">
                    <label>
                      Assigned to
                      <select
                        aria-label="Assigned to"
                        value={step.ownerId || ""}
                        onChange={(e) =>
                          setStep(index, { ownerId: e.target.value || null })
                        }
                      >
                        <option value="">Unassigned</option>
                        {session.members
                          .filter((member) => member.active)
                          .map((member) => (
                            <option key={member.id} value={member.id}>
                              {member.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Due date
                      <input
                        required
                        type="date"
                        value={step.dueDate}
                        onChange={(e) =>
                          setStep(index, { dueDate: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Priority
                      <select
                        aria-label="Priority"
                        value={step.priority}
                        onChange={(e) =>
                          setStep(index, {
                            priority: e.target.value as Step["priority"],
                          })
                        }
                      >
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    Instructions
                    <textarea
                      rows={2}
                      maxLength={10000}
                      value={step.description}
                      onChange={(e) =>
                        setStep(index, { description: e.target.value })
                      }
                    />
                  </label>
                </li>
              ))}
            </ol>
            <button
              className="account-text-button"
              type="button"
              disabled={steps.length >= 30}
              onClick={() =>
                setSteps((rows) => [
                  ...rows,
                  {
                    title: "",
                    description: "",
                    dueDate: today(session.timeZone),
                    ownerId: owner,
                    priority: "normal",
                  },
                ])
              }
            >
              <Plus size={14} />
              Add step
            </button>
          </fieldset>
          {mutation.error && (
            <p className="agency-error" role="alert">
              {mutation.error}
            </p>
          )}
          <div className="account-profile-footer">
            <button
              type="button"
              className="agency-button"
              disabled={mutation.busy || mutation.uncertain}
              onClick={close}
            >
              Cancel
            </button>
            <button className="agency-button primary" disabled={mutation.busy}>
              {mutation.busy
                ? "Starting…"
                : mutation.uncertain
                  ? "Retry same workflow"
                  : `Create ${steps.length} tasks`}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
