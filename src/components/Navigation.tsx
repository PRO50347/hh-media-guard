"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";
const items = [
  ["Dashboard", "/"],
  ["Movies", "/movies"],
  ["TV Shows", "/tv"],
  ["Library", "/library"],
  ["Jobs", "/jobs"],
  ["Needs Attention", "/attention"],
  ["Quarantine", "/quarantine"],
  ["History", "/history"],
  ["Settings", "/settings"],
];
export function Navigation() {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        className="mobile-toggle"
        aria-expanded={open}
        aria-controls="primary-nav"
        onClick={() => setOpen(!open)}
      >
        Menu
      </button>
      <nav
        id="primary-nav"
        aria-label="Primary"
        className={open ? "expanded" : ""}
      >
        {items.map(([label, url]) => (
          <Link
            key={url}
            href={url}
            aria-current={pathname === url ? "page" : undefined}
            onClick={() => setOpen(false)}
          >
            {label}
          </Link>
        ))}
        <button
          onClick={async () => {
            try {
              await api("/api/auth", { method: "DELETE" });
              router.push("/login");
              router.refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Sign out
        </button>
        {error && <p role="alert">{error}</p>}
      </nav>
    </>
  );
}
