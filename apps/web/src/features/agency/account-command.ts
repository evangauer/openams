"use client";
import { useRef, useState } from "react";
import {
  AgencyRequestError,
  command,
  type AmsCommand,
  type AmsRecord,
} from "./model";

/** Keep the entire command stable after a lost response, including its timestamp
 * and expected version. Retrying then replays the server's original result. */
export function useAccountCommand(saved: (records: AmsRecord[]) => void) {
  const pending = useRef<AmsCommand | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  async function run(make: () => AmsCommand): Promise<boolean> {
    if (inFlight.current) return false;
    pending.current ||= make();
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await command(pending.current);
      pending.current = null;
      setUncertain(false);
      saved(result.records);
      return true;
    } catch (failure) {
      const unknown =
        !(failure instanceof AgencyRequestError) ||
        failure.status >= 500 ||
        failure.status === 408;
      setUncertain(unknown);
      if (!unknown) pending.current = null;
      setError(
        failure instanceof AgencyRequestError && failure.code === "stale_record"
          ? "This record changed. Refresh agency records, review it, and try again."
          : unknown
            ? "The save could not be confirmed. Retry to check the same save safely."
            : failure instanceof Error
              ? failure.message
              : "The save failed.",
      );
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return {
    run,
    retry: () =>
      pending.current ? run(() => pending.current!) : Promise.resolve(false),
    busy,
    error,
    uncertain,
  };
}
