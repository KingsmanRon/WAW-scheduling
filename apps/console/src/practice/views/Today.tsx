import React, { useState } from "react";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import { dayRange, fmt, todayIn } from "../time";
import {
  CHANNEL_LABELS,
  type Appointment,
  type CalendarData,
  type ConversationSummary,
  type Referral,
  type WaitlistEntry,
} from "../types";
import {
  Empty,
  ErrorNote,
  Loading,
  StatusBadge,
  useAction,
  useLoad,
} from "../ui";
import { LifecycleButtons } from "./AppointmentDetail";

/**
 * The reception desk's day: who is expected, who has arrived, who is with a
 * practitioner, and what is waiting for a person (conversations, offers,
 * referrals to verify).
 */
export function Today({ route }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const tz = practice.tz;
  const date = todayIn(tz);
  const [locationId, setLocationId] = useState(
    route.query.get("location") ?? "",
  );
  const day = useLoad(
    () =>
      practice.client.get<CalendarData>("/calendar", {
        ...dayRange(date, tz),
        location_id: locationId || undefined,
      }),
    [date, locationId, practice.tick],
  );
  const attention = useLoad(async () => {
    const [conversations, waitlist, referrals] = await Promise.all([
      practice.can("conversation.manage")
        ? practice.client.get<{ items: ConversationSummary[] }>(
            "/conversations",
            { status: "NEEDS_STAFF", limit: 100 },
          )
        : null,
      practice.can("waitlist.read")
        ? practice.client.get<{ items: WaitlistEntry[] }>("/waitlist", {
            status: "OFFERED",
            limit: 100,
          })
        : null,
      practice.can("referral.read")
        ? practice.client.get<{ items: Referral[] }>("/referrals", {
            status: "RECEIVED",
            limit: 100,
          })
        : null,
    ]);
    return {
      conversations: conversations?.items.length ?? null,
      offers: waitlist?.items.length ?? null,
      referrals: referrals?.items.length ?? null,
    };
  }, [practice.tick]);

  const appointments = (day.data?.appointments ?? []).filter(
    (a) => a.status !== "HELD",
  );
  const count = (s: Appointment["status"]) =>
    appointments.filter((a) => a.status === s).length;
  const locations = practice.data.locations.filter((l) => l.active);
  return (
    <>
      <PageHeader
        title="Today"
        context={`${fmt.longDay(date)} · ${practice.data.practice.name}`}
        actions={
          <>
            {locations.length > 1 && (
              <select
                aria-label="Location"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">All locations</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            )}
            {practice.can("appointment.book") && (
              <a
                className="btn"
                href={link("book", null, { channel: "WALK_IN" })}
              >
                <Icon name="plus" size={18} />
                Walk-in
              </a>
            )}
          </>
        }
      />
      <section className="tiles" aria-label="The day so far">
        <Tile label="Booked" value={count("CONFIRMED")} />
        <Tile label="Arrived" value={count("CHECKED_IN")} tone="progress" />
        <Tile
          label="In consultation"
          value={count("IN_PROGRESS")}
          tone="progress"
        />
        <Tile label="Completed" value={count("COMPLETED")} />
        <Tile label="No-shows" value={count("NO_SHOW")} tone="exception" />
      </section>
      {attention.data && Object.values(attention.data).some((n) => !!n) && (
        <section className="attention-list" aria-label="Waiting for a person">
          {!!attention.data.conversations && (
            <a className="attention-list__item" href={link("conversations")}>
              <Icon name="message" />
              <span>
                <strong>{attention.data.conversations}</strong> WhatsApp{" "}
                {attention.data.conversations === 1
                  ? "conversation needs"
                  : "conversations need"}{" "}
                reception
              </span>
            </a>
          )}
          {!!attention.data.offers && (
            <a className="attention-list__item" href={link("waitlist")}>
              <Icon name="waitlist" />
              <span>
                <strong>{attention.data.offers}</strong> waitlist offer
                {attention.data.offers === 1 ? "" : "s"} awaiting an answer
              </span>
            </a>
          )}
          {!!attention.data.referrals && (
            <a
              className="attention-list__item"
              href={link("referrals", null, { status: "RECEIVED" })}
            >
              <Icon name="document" />
              <span>
                <strong>{attention.data.referrals}</strong> referral
                {attention.data.referrals === 1 ? "" : "s"} to verify
              </span>
            </a>
          )}
        </section>
      )}
      <ErrorNote error={day.error} />
      {!day.data && !day.error && <Loading what="today's appointments" />}
      {day.data && !appointments.length && (
        <Empty title="No appointments today">
          Walk-ins and phone bookings appear here as they are made.
        </Empty>
      )}
      {day.data && appointments.length > 0 && (
        <div
          className={`panel table-wrap${day.loading ? " is-refreshing" : ""}`}
        >
          <table className="table agenda">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Patient</th>
                <th scope="col">Appointment</th>
                <th scope="col">With</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="vh">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((a) => (
                <AgendaRow key={a.id} a={a} tz={a.timezone} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "progress" | "exception";
}) {
  return (
    <div className={`tile${tone ? ` tile--${tone}` : ""}`}>
      <span className="tile__value num">{value}</span>
      <span className="tile__label">{label}</span>
    </div>
  );
}

function AgendaRow({ a, tz }: { a: Appointment; tz: string }) {
  const practice = usePractice();
  const link = useLink();
  const action = useAction();
  return (
    <tr className={`agenda__row agenda__row--${a.status.toLowerCase()}`}>
      <td className="num">
        <a href={link("appointment", a.id)}>
          {fmt.range(a.starts_at, a.ends_at, tz)}
        </a>
      </td>
      <td>
        {practice.can("patient.read") ? (
          <a href={link("patient", a.patient.id)}>{a.patient.display_name}</a>
        ) : (
          a.patient.display_name
        )}
        <span className="mono muted small"> {a.patient.patient_number}</span>
      </td>
      <td>
        <span
          className="type-dot"
          style={{ background: a.appointment_type.calendar_color ?? undefined }}
          aria-hidden
        />
        {a.appointment_type.name}
        <span className="muted small">
          {" "}
          · {CHANNEL_LABELS[a.source_channel]}
        </span>
      </td>
      <td>
        {a.practitioner.display_name}
        <span className="muted small"> · {a.location.name}</span>
      </td>
      <td>
        <StatusBadge status={a.status} />
      </td>
      <td className="agenda__actions">
        <LifecycleButtons appointment={a} action={action} compact />
        <ErrorNote error={action.error} />
      </td>
    </tr>
  );
}
