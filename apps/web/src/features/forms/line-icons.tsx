// One picture per line of business, shared by the client's page and the builder so a
// line looks the same where the agency picks it and where the client does.
import {
  BriefcaseBusiness,
  Building2,
  Car,
  DoorOpen,
  HardHat,
  House,
  KeyRound,
  LockKeyhole,
  Sailboat,
  Shield,
  ShieldCheck,
  Store,
  Truck,
  Umbrella,
  Warehouse,
  Waves,
  type LucideIcon,
} from "lucide-react";

// Keyed by the catalog's line ids (packages/contracts/src/form-catalog.ts).
const ICONS: Record<string, LucideIcon> = {
  auto: Car,
  home: House,
  renters: KeyRound,
  condo: Building2,
  landlord: DoorOpen,
  umbrella: Umbrella,
  flood: Waves,
  toys: Sailboat,
  general_liability: ShieldCheck,
  bop: Store,
  workers_comp: HardHat,
  commercial_auto: Truck,
  commercial_property: Warehouse,
  professional_liability: BriefcaseBusiness,
  cyber: LockKeyhole,
};

/** Decorative: the line's label is always beside it. A line with no picture gets a shield. */
export function LineIcon({ line, size = 20 }: { line: string; size?: number }) {
  const Icon = ICONS[line] ?? Shield;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" />;
}
