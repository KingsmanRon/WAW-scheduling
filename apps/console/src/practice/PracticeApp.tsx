import React, { useEffect } from "react";
import { label, roleLabel } from "../format";
import { Shell, type NavItem } from "../layout/Shell";
import { useSession } from "../session";
import { PracticeProvider, usePractice } from "./context";
import { practiceHash, type PracticeRoute } from "./route";
import type { ConversationSummary, Permission } from "./types";
import { useLoad } from "./ui";
import { AppointmentDetail } from "./views/AppointmentDetail";
import { Appointments } from "./views/Appointments";
import { Audit } from "./views/Audit";
import { Book } from "./views/Book";
import { Calendar } from "./views/Calendar";
import { Conversations } from "./views/Conversations";
import { Notifications } from "./views/Notifications";
import { PatientDetail } from "./views/PatientDetail";
import { Patients } from "./views/Patients";
import { Referrals } from "./views/Referrals";
import { Setup } from "./views/Setup";
import { Today } from "./views/Today";
import { Waitlist } from "./views/Waitlist";

export interface ViewProps {
  route: PracticeRoute;
  go: (hash: string) => void;
}

/** Links within the current practice. */
export function useLink() {
  const practice = usePractice();
  return (
    view: string,
    id?: string | null,
    query?: Record<string, string | null | undefined>,
  ) => practiceHash(practice.id, view, id, query);
}

const VIEWS: Record<
  string,
  {
    title: string;
    permission: Permission;
    render: (p: ViewProps) => React.ReactNode;
  }
> = {
  today: {
    title: "Today",
    permission: "schedule.read",
    render: (p) => <Today {...p} />,
  },
  calendar: {
    title: "Calendar",
    permission: "schedule.read",
    render: (p) => <Calendar {...p} />,
  },
  book: {
    title: "Book",
    permission: "appointment.book",
    render: (p) => <Book {...p} />,
  },
  appointments: {
    title: "Appointments",
    permission: "schedule.read",
    render: (p) => <Appointments {...p} />,
  },
  appointment: {
    title: "Appointment",
    permission: "schedule.read",
    render: (p) => <AppointmentDetail {...p} />,
  },
  patients: {
    title: "Patients",
    permission: "patient.read",
    render: (p) => <Patients {...p} />,
  },
  patient: {
    title: "Patient",
    permission: "patient.read",
    render: (p) => <PatientDetail {...p} />,
  },
  waitlist: {
    title: "Waitlist",
    permission: "waitlist.read",
    render: (p) => <Waitlist {...p} />,
  },
  referrals: {
    title: "Referrals",
    permission: "referral.read",
    render: (p) => <Referrals {...p} />,
  },
  conversations: {
    title: "Conversations",
    permission: "conversation.manage",
    render: (p) => <Conversations {...p} />,
  },
  notifications: {
    title: "Notifications",
    permission: "notification.read",
    render: () => <Notifications />,
  },
  setup: {
    title: "Schedule setup",
    permission: "schedule.read",
    render: (p) => <Setup {...p} />,
  },
  audit: {
    title: "Audit",
    permission: "audit.read",
    render: (p) => <Audit {...p} />,
  },
};
/** Which rail item a view belongs to. */
const SECTION: Record<string, string> = {
  appointment: "appointments",
  patient: "patients",
};

function Workspace({ route, go }: ViewProps) {
  const session = useSession();
  const practice = usePractice();
  const link = useLink();
  const waiting = useLoad(
    async () =>
      practice.can("conversation.manage")
        ? (
            await practice.client.get<{ items: ConversationSummary[] }>(
              "/conversations",
              { status: "NEEDS_STAFF", limit: 100 },
            )
          ).items.length
        : 0,
    [practice.tick],
  );
  const view = VIEWS[route.view] ?? VIEWS.today!;
  useEffect(() => {
    document.title = `${view.title} · ${practice.data.practice.name}`;
  }, [view, practice.data.practice.name]);

  const items: (Omit<NavItem, "hash"> & { permission: Permission })[] = [
    {
      key: "today",
      text: "Today",
      short: "Today",
      icon: "today",
      permission: "schedule.read",
    },
    {
      key: "calendar",
      text: "Calendar",
      short: "Calendar",
      icon: "calendar",
      permission: "schedule.read",
    },
    {
      key: "book",
      text: "Book appointment",
      short: "Book",
      icon: "plus",
      permission: "appointment.book",
    },
    {
      key: "patients",
      text: "Patients",
      short: "Patients",
      icon: "patients",
      permission: "patient.read",
    },
    {
      key: "conversations",
      text: "Conversations",
      short: "Chats",
      icon: "message",
      permission: "conversation.manage",
      count: waiting.data ?? undefined,
    },
    {
      key: "appointments",
      text: "Appointments",
      short: "Search",
      icon: "list",
      permission: "schedule.read",
      railOnly: true,
    },
    {
      key: "waitlist",
      text: "Waitlist",
      short: "Waitlist",
      icon: "waitlist",
      permission: "waitlist.read",
      railOnly: true,
    },
    {
      key: "referrals",
      text: "Referrals",
      short: "Referrals",
      icon: "document",
      permission: "referral.read",
      railOnly: true,
    },
    {
      key: "notifications",
      text: "Notifications",
      short: "Messages",
      icon: "bell",
      permission: "notification.read",
      railOnly: true,
    },
    {
      key: "setup",
      text: "Schedule setup",
      short: "Setup",
      icon: "settings",
      permission: "schedule.read",
      railOnly: true,
    },
    {
      key: "audit",
      text: "Audit",
      short: "Audit",
      icon: "shield",
      permission: "audit.read",
      railOnly: true,
    },
  ];
  const nav: NavItem[] = items
    .filter((n) => practice.can(n.permission))
    .map((n) => ({ ...n, hash: link(n.key) }));
  const me = session.me!;
  const membership = practice.data.membership;
  const others = me.practices.length > 1 || me.role !== null;
  return (
    <Shell
      nav={nav}
      active={SECTION[route.view] ?? route.view}
      subtitle={practice.data.practice.name}
      home={link("today")}
      compact={[label(membership.role), practice.data.practice.name]}
      context={[
        { label: "Practice", value: practice.data.practice.name },
        { label: "Signed in as", value: membership.display_name },
        { label: "Role", value: roleLabel(membership.role) },
        {
          label: "Updates",
          value: practice.live === "realtime" ? "Live" : "Every 20 seconds",
        },
      ]}
      switchTo={
        others ? { hash: "#/practices", label: "Switch workspace" } : undefined
      }
    >
      <div className="page" key={`${route.view}/${route.id ?? ""}`}>
        {practice.can(view.permission) ? (
          view.render({ route, go })
        ) : (
          <p className="alert" role="alert">
            Your role ({roleLabel(membership.role)}) does not include this view.
          </p>
        )}
      </div>
    </Shell>
  );
}

export function PracticeApp({ route, go }: ViewProps) {
  return (
    <PracticeProvider practiceId={route.practiceId}>
      <Workspace route={route} go={go} />
    </PracticeProvider>
  );
}
