import { Worker } from "node:worker_threads";
import type { AmsData } from "@openams/contracts";
import { AmsError } from "./repository.js";
let active = 0;
export async function processCertificatePdf(
  bytes: Buffer,
  fields?: Record<string, string | boolean>,
): Promise<{
  fields: AmsData<"certificatetemplates">["fields"];
  bytes?: Uint8Array;
}> {
  if (active >= 2)
    throw new AmsError(
      503,
      "renderer_busy",
      "The PDF renderer is busy. Retry shortly.",
    );
  active++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("./certificate-pdf.js", import.meta.url),
        {
          workerData: { bytes, fields },
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        },
      );
      let settled = false;
      const finish = (
        error?: Error,
        result?: Parameters<typeof resolve>[0],
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(
        () =>
          finish(
            new AmsError(
              422,
              "invalid_template",
              "This PDF took too long to process. Use a simpler template.",
            ),
          ),
        10000,
      );
      worker.once("message", (message) =>
        finish(
          message.error
            ? new AmsError(422, "invalid_template", message.error)
            : undefined,
          message.result,
        ),
      );
      worker.once("error", () =>
        finish(
          new AmsError(
            422,
            "invalid_template",
            "This PDF could not be processed within the renderer limits.",
          ),
        ),
      );
      worker.once("exit", () => {
        if (!settled)
          finish(
            new AmsError(
              422,
              "invalid_template",
              "The PDF renderer stopped before completing.",
            ),
          );
      });
    });
  } finally {
    active--;
  }
}
