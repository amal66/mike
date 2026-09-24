"use client";

import { useState, type ReactNode } from "react";
import Image from "next/image";
import { Modal } from "@/app/components/modals/Modal";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsCard } from "./SettingsCard";
import { SettingsLabel } from "./SettingsText";

/** Keep account and permission controls in the same detail surface as MCP. */
export function GoogleConnectionCard({
  provider,
  name,
  connected,
  loading,
  accountEmail,
  summary,
  onClose,
  children,
}: {
  provider: "google-drive" | "gmail" | "google-calendar";
  name: string;
  connected: boolean;
  loading: boolean;
  accountEmail?: string | null;
  summary: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section aria-label={`${name} connector`} className="min-w-0">
        <SettingsCard>
          <div className="flex min-h-24 flex-wrap items-center gap-3 p-4">
            <div className="flex min-w-0 flex-[1_0_8rem] items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center">
                <Image
                  src={`/icons/integrations/${provider}.png`}
                  alt=""
                  aria-hidden="true"
                  width={24}
                  height={24}
                  unoptimized
                  className="h-6 w-6 object-contain"
                />
              </div>
              <div className="min-w-0 flex-1">
                <SettingsLabel>{name}</SettingsLabel>
                {accountEmail && (
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {accountEmail}
                  </p>
                )}
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {summary}
                </p>
              </div>
            </div>
            <PillButtonUI
              className="ml-auto"
              tone={connected ? "white" : "blue"}
              size="sm"
              disabled={loading}
              aria-label={`${connected ? "Manage" : "Set up"} ${name}`}
              onClick={() => setOpen(true)}
            >
              {loading ? "Loading…" : connected ? "Manage" : "Add"}
            </PillButtonUI>
          </div>
        </SettingsCard>
      </section>
      <Modal
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        breadcrumbs={["Connectors", name]}
        size="md"
      >
        <div className="min-h-0 flex-1 overflow-y-auto pb-5">{children}</div>
      </Modal>
    </>
  );
}
