"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

interface MachineReporter {
  machine_id: string;
  machine_name: string;
}

interface MachineReportersProps {
  machines: MachineReporter[];
}

export function MachineReporters({ machines }: MachineReportersProps) {
  const [open, setOpen] = useState(false);
  const count = machines.length;

  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="machine-reporters-trigger"
          onClick={() => setOpen(true)}
          aria-label={`${count} reporting machine${count === 1 ? "" : "s"}. Show machine list.`}
        >
          <Badge className="machine-reporters-badge">{count}</Badge>
          <span>machine{count === 1 ? "" : "s"} reporting</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent className="machine-reporters-content" align="end" sideOffset={10}>
        <p>Reporting this month</p>
        <ul>
          {machines.map((machine, index) => (
            <li key={`${machine.machine_id}-${index}`}>
              <span>{machine.machine_name}</span>
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}
