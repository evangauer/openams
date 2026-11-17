import {
  amsPublicDemo,
  firebaseApiUrl,
  firebaseAuthMode,
  localAmsEnabled,
} from "@/lib/server/ams-context";
import { demoLink } from "@/lib/demo-link";
import { AgencyWorkspace } from "@/features/agency/workspace";
import { HostedAgency } from "@/features/agency/hosted-identity";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agency workspace · OpenAMS" };

export default function AgencyPage() {
  if (firebaseAuthMode())
    return firebaseApiUrl() ? (
      <HostedAgency />
    ) : (
      <main className="setup-notice">
        <h1>OpenAMS sign-in isn&apos;t configured</h1>
        <p>
          Hosted sign-in needs <code>AMS_API_URL</code> set to the loopback API
          address, for example <code>http://127.0.0.1:4510</code>.
        </p>
      </main>
    );
  if (!localAmsEnabled())
    return (
      <main className="setup-notice">
        <h1>OpenAMS isn&apos;t configured yet</h1>
        <p>
          This build runs as a local evaluation only. Start it with{" "}
          <code>npm run dev</code> from the repository root, which launches the API
          and this app together with a fictional sample agency.
        </p>
      </main>
    );
  if (amsPublicDemo()) return <AgencyWorkspace local publicDemo={{ link: demoLink() }} />;
  return <AgencyWorkspace local />;
}
