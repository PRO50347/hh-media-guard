import "./globals.css";
import Image from "next/image";
import { currentSession } from "@/lib/auth";
import { getSettings } from "@/lib/store";
import { brandingAssets } from "@/lib/branding";
import { Navigation } from "@/components/Navigation";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  const s = getSettings();
  const a = brandingAssets();
  return {
    title: s.appName,
    description: "Audio-language policy and media inspection",
    icons: a.favicon ? { icon: a.favicon } : undefined,
  };
}
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const settings = getSettings();
  const assets = brandingAssets();
  const session = await currentSession();
  return (
    <html lang="en" data-theme={settings.theme}>
      <body style={{ "--accent": settings.accent } as React.CSSProperties}>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        {session ? (
          <div className="shell">
            <aside>
              <div className="logo">
                {assets.compact ? (
                  <Image
                    unoptimized
                    src={assets.compact}
                    alt=""
                    width={40}
                    height={40}
                  />
                ) : (
                  <span aria-hidden>◈</span>
                )}
                <div>
                  {settings.showSuite && <small>{settings.suiteName}</small>}
                  <strong>{settings.shortName}</strong>
                </div>
              </div>
              <Navigation />
              <p className="mode">
                {settings.safetyMode.toUpperCase()}
                <br />
                <small>
                  {process.env.ALLOW_DESTRUCTIVE_ACTIONS === "true"
                    ? "Destructive-action switch enabled"
                    : "Destructive actions disabled"}
                </small>
              </p>
              {settings.suiteLinks?.some((link) => link.enabled) && (
                <details>
                  <summary>Suite applications</summary>
                  {settings.suiteLinks
                    .filter((link) => link.enabled)
                    .map((link) => (
                      <p key={link.url}>
                        <a
                          href={link.url}
                          rel="noopener noreferrer"
                          target="_blank"
                        >
                          {link.icon} {link.name} ↗
                        </a>
                      </p>
                    ))}
                </details>
              )}
            </aside>
            <div id="main-content" className="content">
              {children}
            </div>
          </div>
        ) : (
          <div id="main-content">{children}</div>
        )}
      </body>
    </html>
  );
}
