import React, { useState } from "react";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import { fmt, shiftDate, startOfDay, todayIn } from "../time";
import {
  CHANNEL_LABELS,
  type Appointment,
  type AppointmentStatus,
  type PatientSummary,
} from "../types";
import {
  Empty,
  ErrorNote,
  Loading,
  PatientPicker,
  StatusBadge,
  statusText,
  useLoad,
} from "../ui";

const STATUSES: AppointmentStatus[] = [
  "CONFIRMED",
  "CHECKED_IN",
  "IN_PROGRESS",
  "COMPLETED",
  "NO_SHOW",
  "CANCELLED",
  "RESCHEDULED",
];

/** Find appointments by date range, practitioner, location, status or patient. */
export function Appointments({ route, go }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  const tz = practice.tz;
  const q = route.query;
  const from = q.get("from") ?? todayIn(tz);
  const to = q.get("to") ?? shiftDate(from, 7);
  const practitionerId = q.get("practitioner") ?? "";
  const locationId = q.get("location") ?? "";
  const status = q.get("status") ?? "";
  const patientId = q.get("patient") ?? "";
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<Appointment[]>([]);
  const [picking, setPicking] = useState(false);
  const set = (next: Record<string, string>) => {
    setCursor(null);
    setPages([]);
    go(
      link("appointments", null, {
        from,
        to,
        practitioner: practitionerId,
        location: locationId,
        status,
        patient: patientId,
        ...next,
      }),
    );
  };
  const list = useLoad(
    () =>
      practice.client.get<{ items: Appointment[]; next: string | null }>(
        "/appointments",
        {
          from: startOfDay(from, tz).toISO(),
          to: startOfDay(to, tz).plus({ days: 1 }).toISO(),
          practitioner_id: practitionerId || undefined,
          location_id: locationId || undefined,
          status: status || undefined,
          patient_id: patientId || undefined,
          cursor: cursor ?? undefined,
          limit: 100,
        },
      ),
    [
      from,
      to,
      practitionerId,
      locationId,
      status,
      patientId,
      cursor,
      practice.tick,
    ],
  );
  const items = [...pages, ...(list.data?.items ?? [])];
  const patientName = items.find((a) => a.patient.id === patientId)?.patient
    .display_name;
  return (
    <>
      <PageHeader
        title="Appointments"
        context="Search the schedule. Open an appointment to see its full history."
      >
        <div className="toolbar" role="search">
          <div className="field field--inline">
            <label htmlFor="appt-from">From</label>
            <input
              id="appt-from"
              type="date"
              value={from}
              onChange={(e) => e.target.value && set({ from: e.target.value })}
            />
          </div>
          <div className="field field--inline">
            <label htmlFor="appt-to">To</label>
            <input
              id="appt-to"
              type="date"
              value={to}
              min={from}
              onChange={(e) => e.target.value && set({ to: e.target.value })}
            />
          </div>
          <select
            aria-label="Practitioner"
            value={practitionerId}
            onChange={(e) => set({ practitioner: e.target.value })}
          >
            <option value="">All practitioners</option>
            {practice.data.practitioners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display_name}
              </option>
            ))}
          </select>
          {practice.data.locations.length > 1 && (
            <select
              aria-label="Location"
              value={locationId}
              onChange={(e) => set({ location: e.target.value })}
            >
              <option value="">All locations</option>
              {practice.data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => set({ status: e.target.value })}
          >
            <option value="">Any status</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusText(s)}
              </option>
            ))}
          </select>
          {practice.can("patient.read") &&
            (patientId ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => set({ patient: "" })}
              >
                {patientName ?? "One patient"} · clear
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPicking(!picking)}
              >
                Filter by patient
              </button>
            ))}
        </div>
        {picking && !patientId && (
          <PatientPicker
            onPick={(p: PatientSummary) => {
              setPicking(false);
              set({ patient: p.id });
            }}
          />
        )}
      </PageHeader>
      <ErrorNote error={list.error} />
      {!list.data && !list.error && <Loading what="appointments" />}
      {list.data && !items.length && <Empty title="No appointments match" />}
      {items.length > 0 && (
        <div
          className={`panel table-wrap${list.loading ? " is-refreshing" : ""}`}
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Patient</th>
                <th scope="col">Appointment</th>
                <th scope="col">With</th>
                <th scope="col">Booked through</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td className="num">
                    <a href={link("appointment", a.id)}>
                      {fmt.when(a.starts_at, a.timezone)}
                    </a>
                  </td>
                  <td>
                    {a.patient.display_name}{" "}
                    <span className="mono muted small">
                      {a.patient.patient_number}
                    </span>
                  </td>
                  <td>{a.appointment_type.name}</td>
                  <td>
                    {a.practitioner.display_name}
                    <span className="muted small"> · {a.location.name}</span>
                  </td>
                  <td>{CHANNEL_LABELS[a.source_channel]}</td>
                  <td>
                    <StatusBadge status={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data?.next && (
        <p className="load-more">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setPages(items);
              setCursor(list.data!.next);
            }}
          >
            Show more
          </button>
        </p>
      )}
    </>
  );
}
