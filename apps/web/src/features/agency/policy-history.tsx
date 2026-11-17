import type { AmsRecord } from "@openams/contracts";
import { dateLabel } from "./model";

export function PolicyHistory({ policy }: { policy: AmsRecord<"policies"> }) {
  const events = policy.data.reinstatements ?? [];
  if (!events.length) return null;
  return (
    <section
      className="agency-policy-history"
      aria-label="Cancellation and reinstatement history"
    >
      <h3>Cancellation and reinstatement history</h3>
      <p>
        Recorded carrier dates and evidence. Policy terms and carrier review
        determine coverage.
      </p>
      <ol>
        {events.map((event, index) => (
          <li key={`${event.recordedAt}-${index}`}>
            <strong>
              Cancelled {dateLabel(event.cancellationDate)} · Reinstated{" "}
              {dateLabel(event.effectiveDate)}
            </strong>
            <p>
              {event.cancellationDate === event.effectiveDate
                ? "Reinstatement recorded with no lapse."
                : "A cancellation interval remains in the recorded history."}
            </p>
            <dl>
              <dt>Cancellation evidence</dt>
              <dd>{event.cancellationReference}</dd>
              <dt>Reinstatement evidence</dt>
              <dd>{event.sourceReference}</dd>
              <dt>Review note</dt>
              <dd>{event.reason}</dd>
            </dl>
            {event.sourceDocumentId && (
              <a
                className="agency-button"
                href={`/api/agency/documents/${event.sourceDocumentId}/content`}
                target="_blank"
                rel="noreferrer"
              >
                Open reinstatement document
              </a>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
