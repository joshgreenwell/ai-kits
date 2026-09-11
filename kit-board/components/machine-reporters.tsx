"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

interface MachineReporter {
  machine_id: string;
  machine_name: string;
}

export function MachineReporters({ machines }: { machines: MachineReporter[] }) {
  const [open, setOpen] = useState(false);
  const count = machines.length;

  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(true)}
          aria-label={`${count} reporting machine${count === 1 ? "" : "s"}. Show machine list.`}
        >
          <Badge variant="soft">{count}</Badge>
          <span>machine{count === 1 ? "" : "s"} reporting</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" sideOffset={10} className="w-60">
        <p className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
          Reporting this month
        </p>
        <ul className="mt-2 grid gap-1">
          {machines.map((machine, index) => (
            <li key={`${machine.machine_id}-${index}`} className="text-sm">
              {machine.machine_name}
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}
