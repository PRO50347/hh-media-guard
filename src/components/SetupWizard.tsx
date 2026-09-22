"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings } from "@/lib/types";
import { IntegrationSettings } from "./IntegrationSettings";
import { MappingSettings } from "./MappingSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { PolicySettings } from "./PolicySettings";
import { api, json } from "./api";
const steps = [
  "Welcome",
  "Branding",
  "Sonarr",
  "Radarr",
  "Path mappings",
  "Language and safety",
  "Connection tests",
  "Summary",
];
export function SetupWizard({
  settings,
  destructiveEnabled,
}: {
  settings: Settings;
  destructiveEnabled: boolean;
}) {
  const [step, setStep] = useState(0);
  const [message, setMessage] = useState("");
  const router = useRouter();
  return (
    <main>
      <h1>Set up {settings.shortName}</h1>
      <div className="steps" aria-label="Setup progress">
        {steps.map((title, index) => (
          <span
            key={title}
            className={step === index ? "current" : ""}
            aria-current={step === index ? "step" : undefined}
          >
            {index + 1}. {title}
          </span>
        ))}
      </div>
      {step === 0 && (
        <section className="card">
          <h2>Welcome</h2>
          <p>
            Start safely in Monitor Only. Sonarr and Radarr are independently
            optional. Save each form before continuing; settings are persisted
            immediately.
          </p>
        </section>
      )}
      {step === 1 && <AppearanceSettings initial={settings} />}{" "}
      {step === 2 && <IntegrationSettings id="sonarr" />}
      {step === 3 && <IntegrationSettings id="radarr" />}
      {step === 4 && <MappingSettings />}
      {step === 5 && (
        <PolicySettings
          initial={settings}
          destructiveEnabled={destructiveEnabled}
        />
      )}{" "}
      {step === 6 && (
        <>
          <p>
            Use Test connection for each integration you configured. Tests read
            server information only.
          </p>
          <div className="grid">
            <IntegrationSettings id="sonarr" />
            <IntegrationSettings id="radarr" />
          </div>
        </>
      )}
      {step === 7 && (
        <section className="card">
          <h2>Ready to inspect media</h2>
          <p>
            Your saved configuration will be used. Begin with a single generated
            test file, then start a library audit. Settings remain available at
            any time.
          </p>
        </section>
      )}
      <div className="actions">
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </button>
        {step < steps.length - 1 ? (
          <button onClick={() => setStep(step + 1)}>Continue</button>
        ) : (
          <button
            onClick={async () => {
              try {
                await api(
                  "/api/settings",
                  json("POST", { setupComplete: true }),
                );
                router.push("/");
                router.refresh();
              } catch (e) {
                setMessage((e as Error).message);
              }
            }}
          >
            Finish setup
          </button>
        )}
      </div>
      <p role="status">{message}</p>
    </main>
  );
}
