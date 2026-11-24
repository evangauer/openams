# Hosted forms

A hosted form is a page at a link of its own where a client answers an agency's
questions and attaches files, on any device, without signing in. What the client sends
waits in the workspace, apart from the book, until someone at the agency files it to an
account.

```
agency builds a form ──► publishes it ──► /f/<link>  (the client's page)
                                              │  answers and files
                                              ▼
                              Forms → Submissions  (+ a follow-up task)
                                              │  "File to an account"
                                              ▼
              account · contact · exposures · documents · a note with the answers
```

Nothing is sent anywhere else. A submission does not email the client, contact a carrier,
create a quote or change a policy; it becomes records only when a person files it.

## Building a form

**Tools → Forms → New form.** Administrators and managers build and publish forms; every
other role can read them.

1. **Coverage.** Choose the lines of business the form covers. Each line brings a set of
   starting questions from the catalog (`packages/contracts/src/form-catalog.ts`):
   auto, homeowners, renters, condo, landlord, umbrella, flood, and motorcycle, boat and
   RV on the personal side; general liability, business owner's policy, workers'
   compensation, commercial auto, commercial property, professional liability and cyber
   on the commercial side. With two or more lines the client chooses which they want and
   answers the shared questions once.
2. **Questions.** Reword, reorder, remove and add questions and sections. A question can
   be a short answer, paragraph, email, phone, number, dollar amount, date, one choice,
   several choices, yes or no, an address or a file upload, and can be asked only when an
   earlier question in its section has a given answer. Sections such as drivers and
   vehicles repeat: the client adds one at a time.
3. **Look.** The headline, welcome message, agency name, phone, email, color and logo the
   client sees, the thank-you message, the consent line above the Send button, and who
   gets the follow-up task.
4. **Share.** Publishing gives the form its link, a QR code and the HTML to embed it in
   the agency's website. A form can be edited while it is live, paused (its link then
   says the form is closed and shows how to reach the agency) and reopened at the same
   link.

The preview beside the builder is the client's page itself, run without saving or sending
anything. Unsaved edits are kept in the browser until they are saved or discarded.

The catalog questions are general intake questions written for OpenAMS. They are a
starting point, not carrier applications, and OpenAMS ships no ACORD forms. The questions
an agency asks, and the consent wording it shows, are the agency's to review.

## What the client does

The page shows the agency's name, color and logo. The client picks what they want a quote
for, moves through one section per step, attaches files where asked, reviews everything
and sends it. Answers are kept in that browser tab's session storage, so a refresh does
not lose them; they leave the device only when the client presses Send. Sending twice
never saves a submission twice.

Uploads: PDF, JPG, PNG, DOCX, XLSX or CSV, up to 10 MB each, five per question and ten per
submission. Each file's type is checked against its contents.

## Submissions and filing

Each submission opens a task for the form's owner (or the agency's default owner) and
appears under **Forms → Submissions** with the answers as they were asked, so it reads the
same after the form is edited. From there a person either:

- **Files it to an account**: an existing account (matches by email, phone and name are
  suggested) or a new prospect. In one change with one history entry, filing can add the
  client as a contact, add each driver, vehicle, location or payroll class as an exposure,
  turn the uploads into account documents, leave the answers as a note on the account and
  move the follow-up task onto it.
- **Dismisses it** with a reason (a duplicate, spam, not a fit). It stays under Dismissed
  and can be reopened.

Answers are a record of what the client sent: they cannot be edited, and a submission
cannot be created by hand.

| Role | Forms | Submissions |
| --- | --- | --- |
| Administrator, manager | Build, publish, pause, archive | Read, file, dismiss |
| Member | Read | Read, file, dismiss |
| Accountant, viewer | Read | Read |

## How it is built

- **Records.** `forms` and `formsubmissions` are ordinary record kinds
  (`packages/contracts/src/forms.ts`): versioned, in the change history and in the full
  export. A form's status, link and publish time change only through `form.publish` and
  `form.pause`; a submission is created only by the public endpoint and changed only by
  `formSubmission.file`, `formSubmission.dismiss` and `formSubmission.reopen`.
- **One set of rules.** The page and the server check answers with the same functions
  (`amsFormIssues`), so a client is never told an answer is fine and then refused.
- **The link index.** A link names no agency. `AmsFormLinks`
  (`apps/api/src/form-links.ts`) is the only thing that turns a link into an agency and a
  form: one SQLite table locally, one `form_links` collection in Firestore. It can be
  resolved one link at a time and cannot be listed. A link is `<form name>-<10 random
  characters>`, is assigned when a form is first published and never changes or moves.
- **Routes** (`apps/api/src/form-routes.ts`). `POST /ams/forms/:id/publish` and
  `GET /ams/form-submissions/:id/files/:file` are for the signed-in agency. The public
  routes take no session and no agency identifier:

  | Route | Purpose |
  | --- | --- |
  | `GET /public/forms/:link` | The questions and the look, or "closed" with the agency's name and contact details. Internal fields (the form's own name, owner, follow-up settings) are never included. |
  | `POST /public/forms/:link/upload-check` | Asked by the web app before it reads a file. |
  | `POST /public/forms/:link/files` | One file, stored under this submission only. |
  | `POST /public/forms/:link/submissions` | The answers. Checked against the current form, then saved with its follow-up task. |

  The web app serves the page at `/f/<link>` and forwards the client's requests from
  `/api/forms/<link>/…`. It never reads or sends a session cookie on these routes.
- **Optional.** Forms are a router dependency (`forms` in `createAmsRouter`), like team
  chat and incoming mail. Without it the workspace hides Forms and no link resolves.

## Limits and protections

| | |
| --- | --- |
| Reading a form | 300 a minute per client |
| Sending a submission | 20 a minute per client, and 40 at once then 1 every 2 minutes per form on each API process |
| Uploading a file | 40 a minute per client; per form on each API process, 60 at once then 1 a minute, and 500 MB a day |
| Size | 300 KB of answers; a submission record stays under the usual 128 KB |
| Scripts | A field people never see, and a minimum time on the page. A refused submission is told so; nothing is silently dropped. |

Per-client limits need `AMS_CLIENT_ADDRESS_DEPTH`
([Per-agency limits](limits.md#client-admission-limits)); without it every client shares
one limit per API process. Uploads count toward the agency's storage limit. A file a
client uploads and then never submits is not listed anywhere and is not removed
automatically.

Other protections:

- A hosted form page is the only page another site may show in a frame
  (`frame-ancestors *` for `/f/<link>` only; everything else keeps `frame-ancestors
  'none'` and `X-Frame-Options: DENY`). The page holds no session, so a framing site gains
  nothing a visitor to the link doesn't have.
- Form pages ask search engines not to index them.
- The form tells the client, on every step, who receives the answers and not to enter
  passwords or card numbers.
- With [external access control](external-access.md), only an active agency's forms take
  submissions; any other state shows the closed page.
- In the [public demo](public-demo.md), forms can be built and previewed but not
  published, because anyone can open a sandbox there. The sample form is paused and no
  link opens.
- Locally, the page follows the evaluation build's rule: loopback only.

Before a deployment that anyone on the internet can sign up to accepts public
submissions, put a per-client rate limit at the edge and decide whether your forms need
bot protection there; the limits above bound a flood, they do not identify a person.

## On the roadmap

Email to the agency and the client when a submission arrives, a link that asks an existing
client to update what you already hold, service forms (certificate requests, policy
changes, first notice of loss) that open the matching service record, and a client
portal built on the same pages.
