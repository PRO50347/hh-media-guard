"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Settings } from "@/lib/types";
import { IntegrationSettings } from "./IntegrationSettings";
import { MappingSettings } from "./MappingSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { PolicySettings } from "./PolicySettings";
import { SetupPersistence } from "./SetupPersistence";
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
  const [currentSettings, setCurrentSettings] = useState(settings);
  const [busy, setBusy] = useState(false);
  const navigating = useRef(false);
  const saves = useRef(new Map<symbol, () => Promise<void>>());
  const persistence = useMemo(
    () => ({
      register: (save: () => Promise<void>) => {
        const token = Symbol();
        saves.current.set(token, save);
        return () => {
          saves.current.delete(token);
        };
      },
    }),
    [saves],
  );
  async function navigate(next: number) {
    if (navigating.current) return;
    navigating.current = true;
    setBusy(true);
    setMessage("");
    try {
      for (const save of [...saves.current.values()]) await save();
      const persisted = await api<Settings>("/api/settings");
      setCurrentSettings(persisted);
      if (next === steps.length) {
        await api("/api/settings", json("POST", { setupComplete: true }));
        router.push("/");
        router.refresh();
      } else setStep(next);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      navigating.current = false;
      setBusy(false);
    }
  }
  return (
    <main>
      <h1>Set up {currentSettings.shortName}</h1>
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
      <SetupPersistence.Provider value={persistence}>
        <div key={step} inert={busy}>
          {step === 0 && (
            <section className="card">
              <h2>Welcome</h2>
              <p>
                Start safely in Monitor Only. Sonarr and Radarr are
                independently optional. Continue and Back save branding,
                integration and policy forms before changing steps. Save buttons
                remain available. Add or update path mappings explicitly.
              </p>
            </section>
          )}
          {step === 1 && <AppearanceSettings initial={currentSettings} />}{" "}
          {step === 2 && <IntegrationSettings id="sonarr" />}
          {step === 3 && <IntegrationSettings id="radarr" />}
          {step === 4 && <MappingSettings />}
          {step === 5 && (
            <PolicySettings
              initial={currentSettings}
              destructiveEnabled={destructiveEnabled}
            />
          )}{" "}
          {step === 6 && (
            <>
              <p>
                Use Test connection for each integration you configured. Tests
                read server information only.
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
                Your saved configuration will be used. Begin with a single
                generated test file, then start a library audit. Settings remain
                available at any time.
              </p>
            </section>
          )}
        </div>
      </SetupPersistence.Provider>
      <div className="actions">
        <button
          disabled={busy || step === 0}
          onClick={() => void navigate(step - 1)}
        >
          Back
        </button>
        {step < steps.length - 1 ? (
          <button disabled={busy} onClick={() => void navigate(step + 1)}>
            Continue
          </button>
        ) : (
          <button disabled={busy} onClick={() => void navigate(steps.length)}>
            Finish setup
          </button>
        )}
      </div>
      <p role="status">{message}</p>
    </main>
  );
}
