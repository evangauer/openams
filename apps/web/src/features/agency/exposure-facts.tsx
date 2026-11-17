"use client";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Choice } from "./picker";
type Fact = string | number | boolean;
type Spec = {
  key: string;
  label: string;
  type?: "number" | "date" | "boolean";
};
export const exposureFields: Record<string, Spec[]> = {
  location: [
    { key: "occupancy", label: "Occupancy / operations" },
    { key: "squareFeet", label: "Occupied square feet", type: "number" },
    { key: "employees", label: "Employees at location", type: "number" },
    { key: "annualRevenue", label: "Annual revenue ($)", type: "number" },
  ],
  building: [
    { key: "construction", label: "Construction" },
    { key: "yearBuilt", label: "Year built", type: "number" },
    { key: "squareFeet", label: "Building square feet", type: "number" },
    { key: "buildingValue", label: "Building value ($)", type: "number" },
    { key: "roofYear", label: "Roof update year", type: "number" },
    { key: "sprinklered", label: "Sprinklered", type: "boolean" },
  ],
  vehicle: [
    { key: "vin", label: "VIN" },
    { key: "year", label: "Model year", type: "number" },
    { key: "make", label: "Make" },
    { key: "model", label: "Model" },
    { key: "use", label: "Vehicle use" },
    { key: "radiusMiles", label: "Operating radius (miles)", type: "number" },
    { key: "vehicleValue", label: "Vehicle value ($)", type: "number" },
  ],
  driver: [
    { key: "dateOfBirth", label: "Date of birth", type: "date" },
    { key: "licenseState", label: "License state" },
    { key: "licenseNumber", label: "License number" },
    { key: "hireDate", label: "Hire date", type: "date" },
    { key: "yearsExperience", label: "Years of experience", type: "number" },
  ],
  payroll: [
    { key: "state", label: "State" },
    { key: "classCode", label: "Class code" },
    { key: "classification", label: "Classification description" },
    { key: "annualPayroll", label: "Annual payroll ($)", type: "number" },
    { key: "employees", label: "Employees", type: "number" },
  ],
  equipment: [
    { key: "serialNumber", label: "Serial number" },
    { key: "year", label: "Year", type: "number" },
    { key: "make", label: "Make" },
    { key: "model", label: "Model" },
    { key: "equipmentValue", label: "Equipment value ($)", type: "number" },
  ],
  operations: [
    { key: "operations", label: "Business operations" },
    { key: "annualRevenue", label: "Annual revenue ($)", type: "number" },
    { key: "employees", label: "Employees", type: "number" },
    {
      key: "subcontractorCost",
      label: "Annual subcontractor cost ($)",
      type: "number",
    },
  ],
};
export function ExposureFacts({
  kind,
  value,
  set,
}: {
  kind: string;
  value: unknown;
  set: (value: Record<string, Fact>) => void;
}) {
  const facts = (value || {}) as Record<string, Fact>;
  const specs = exposureFields[kind] || [];
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const write = (key: string, item?: Fact) => {
    const next = { ...facts };
    if (item === undefined || item === "") delete next[key];
    else next[key] = item;
    set(next);
  };
  const custom = Object.keys(facts).filter(
    (key) => !specs.some((spec) => spec.key === key),
  );
  return (
    <div className="agency-field agency-span">
      <span>Exposure schedule</span>
      <div className="account-exposure-fields">
        {specs.map((spec) =>
          spec.type === "boolean" ? (
            <div className="account-exposure-choice" key={spec.key}>
              <span id={`exposure-fact-${spec.key}`}>{spec.label}</span>
              <Choice
                labelledBy={`exposure-fact-${spec.key}`}
                value={
                  facts[spec.key] === undefined ? "" : String(facts[spec.key])
                }
                options={[
                  { id: "", label: "Not recorded" },
                  { id: "true", label: "Yes" },
                  { id: "false", label: "No" },
                ]}
                onChange={(next) =>
                  write(spec.key, next === "" ? undefined : next === "true")
                }
              />
            </div>
          ) : (
            <label key={spec.key}>
              {spec.label}
              {
                <input
                  type={spec.type || "text"}
                  step={spec.type === "number" ? "any" : undefined}
                  min={spec.type === "number" ? 0 : undefined}
                  value={String(facts[spec.key] ?? "")}
                  maxLength={1000}
                  onChange={(e) =>
                    write(
                      spec.key,
                      e.target.value === ""
                        ? undefined
                        : spec.type === "number"
                          ? Number(e.target.value)
                          : e.target.value,
                    )
                  }
                />
              }
            </label>
          ),
        )}
      </div>
      {custom.map((key) => (
        <div className="account-exposure-custom" key={key}>
          <label>
            {key}
            <input
              value={String(facts[key] ?? "")}
              maxLength={1000}
              onChange={(e) => set({ ...facts, [key]: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="agency-icon-button"
            aria-label={`Remove fact ${key}`}
            onClick={() => write(key, undefined)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="account-exposure-custom">
        <label>
          Additional fact name
          <input
            value={label}
            maxLength={100}
            onChange={(e) => {
              setLabel(e.target.value);
              setError("");
            }}
          />
        </label>
        <button
          type="button"
          className="agency-button"
          disabled={!label.trim() || Object.keys(facts).length >= 50}
          onClick={() => {
            const key = label.trim();
            if (
              Object.hasOwn(facts, key) ||
              specs.some((spec) => spec.key === key) ||
              ["__proto__", "constructor", "prototype"].includes(key)
            ) {
              setError("Use a distinct field name.");
              return;
            }
            set({ ...facts, [key]: "" });
            setLabel("");
          }}
        >
          <Plus size={14} />
          Add fact
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
