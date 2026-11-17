# Certificates: request, prepare, review, issue, deliver and reissue

This workflow records agency work. It does not bind coverage, contact a carrier,
assert additional-insured status, or send email. An agency must have authority to
use its template and issue each certificate. No licensed forms are distributed.

## 1. Authorize an edition

Certificates → Certificate templates lets an administrator or manager upload a
**blank, authorized fillable PDF**, name the form and edition, and record its
license/authorization reference. Each upload is immutable, private to the agency,
and fingerprinted. Revoking an edition blocks future preparation and issuance of
its drafts; issued documents and their history remain available. Upload a new
edition rather than changing an existing template.

Supported forms: standard AcroForms with 1–150 text/checkbox fields, at most ten
pages and 5 MB. Encrypted PDFs, XFA, signature fields, dropdowns, rich text,
combed text and active actions/scripts are unsupported. The renderer runs in a
worker with a ten-second timeout, a 128 MB V8 heap limit and two concurrent jobs
per API process. These are resource limits, not a malware-scanning guarantee.
Every field is cleared or populated explicitly; stored templates are preserved.
Output retains canonical field values and regenerated appearances, with fields
marked read-only. Overlong or unencodable text is rejected, not silently dropped.
The output is not a digitally signed PDF.

No field mapping is guessed for arbitrary editions. The editor uses their field
names. Known legacy names and simple names (`insured`, `agency`, `holder`,
`holder_email`, `description`, `date`, `policies`) may receive draft suggestions.
Users review every field, coverage statement and signature themselves.

## 2. Request and reuse holders

Save reusable names, addresses, emails and notes under Certificate holders. Create
a certificate request, choose its account and policy terms, and select a saved
holder or enter one-off details. Link an existing certificate service request, or
use **Start certificate request** directly from that service record. The request copies holder details. Editing a
saved holder does not rewrite existing requests or issued evidence. Edit a draft
to change its recipient; changes invalidate its prepared PDF.

## 3. Prepare, review and record issuance

Open a request → Prepare certificate. Select an authorized edition, fill the
fields, and prepare a PDF. The API verifies the selected account and policy
versions before rendering and again in the preparation transaction. It saves
write-once document bytes and links their metadata to the draft.

Download and review the actual PDF, then explicitly acknowledge authority and
record issuance. The server rechecks the template's approval, source versions and
active policy terms. If anything changed, refresh and prepare again. Issuance pins
the policy snapshots. Issued certificates cannot be edited; void/reissue preserves
the originals. An externally prepared, reviewed PDF can still be uploaded to the
account and used by the existing Record issued certificate action.

A failed preparation can leave an unreferenced document or private storage object.
It never issues a certificate. Retry with the same request ID to recover a committed
operation; inspect orphan objects under the normal storage-retention procedure.

## 4. Deliver through the agency's channel

For an issued certificate with a holder email, **Download email draft with PDF**
creates an `.eml` with the exact issued attachment and `X-Unsent: 1`. Import it into
a compatible email client (client support varies), review the recipient and send
it there, or attach the downloaded PDF to a new message. OpenAMS does not send the draft; delivery stays in the agency’s email client.

Only after delivery actually occurs, use **Record external delivery** with the
recipient, channel, timestamp and supporting reference. This is a staff attestation,
not provider-verified delivery. The server records the actor, timestamp, document
ID and fingerprint. Downloading a PDF or `.eml` never records delivery. Delivery
history is append-only; voided certificates cannot get new deliveries or drafts.
For a linked open service request, explicitly choosing **Also complete** closes it
and attaches the issued PDF in the same transaction as the delivery record. A
concurrent service edit rejects the entire action until it is reviewed again.

## 5. Renewal and reissue

**Create renewal / reissue request** starts a linked request with copied holder
and requirements, and requires explicit policy selection and a reason. It does
not reuse the old PDF, preparation, signature, delivery history or issuance state.
Review the new terms, prepare again, issue and deliver again. The old certificate
remains unchanged; reissue does not automatically void it or notify its holder.
This is a staff-initiated workflow, not a bulk renewal or automatic delivery job.

## API, storage and deployment

- `POST /ams/certificate-templates`: raw PDF plus authorization metadata (manager/admin).
- `GET /ams/certificate-templates/:id/content`: original approved edition.
- `POST /ams/certificates/:id/prepare`: template, fields, request/source versions and UUID.
- `GET /ams/certificates/:id/email-draft`: attachment-bearing draft; no sending.
- Commands: `template.revoke`, `certificate.issue`, `certificate.void`,
  `certificate.deliver`, `certificate.reissue`. Public commands cannot forge
  template metadata or generated preparations.
- Record kinds: `certificatetemplates`, `certificateholders`; certificates gain
  optional holder/lineage/preparation fields and append-only delivery history.
- Template objects live under `ams-documents/{tenant}/templates/`; generated PDFs
  use the existing private document storage adapter. No new cloud service, secret,
  public storage rule, index or environment variable is required.
- Existing records use schema defaults. Back up the database and all document
  objects before upgrading. Older application versions do not understand the new
  record kinds: roll back code and a matching pre-upgrade backup together.
- Record exports include template metadata and certificate history, not PDF bytes;
  download originals and issued documents separately or use full storage backups.

## Verification

`npm test` includes a fictional two-page form and exercises canonical PDF values,
appearances, unsafe input rejection, role/tenant boundaries, idempotent retries,
holder snapshots, preparation/issuance, exact email attachments, delivery and
reissue. The same suite runs against Firestore/Cloud Storage with
`npm run test:firebase --workspace @openams/api`.

To generate the original fictional test PDFs outside Git for visual inspection:

```sh
mkdir -p /tmp/openams-certificate-evidence
OPENAMS_CERT_EVIDENCE_DIR=/tmp/openams-certificate-evidence node --test apps/api/tests/certificates.test.mjs
```

Run from the repository root after building contracts and the API. These PDFs are
labelled as test data and are not certificates of coverage. Acceptance-test each
agency's actual authorized edition before use; automated tests cannot establish
its licensing, wording, layout suitability or the issuer's authority.
