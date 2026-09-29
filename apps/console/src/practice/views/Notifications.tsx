import React, { useState } from "react";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { usePractice } from "../context";
import { useLink } from "../PracticeApp";
import { fmt } from "../time";
import type { Delivery } from "../types";
import { Empty, ErrorNote, Loading, Tone, useLoad } from "../ui";

const SKIPPED: Record<string, string> = {
  NO_CONSENT: "the patient has not agreed to messages on this channel",
  NO_CONTACT: "no number or address on record",
  CHANNEL_NOT_CONFIGURED: "the channel is not set up for the practice",
  REMINDERS_DISABLED: "the patient turned reminders off",
  APPOINTMENT_CHANGED: "the appointment changed before sending",
  TOO_LATE: "too close to the appointment to be useful",
  PATIENT_ARCHIVED: "the patient record is archived",
  RECIPIENT_NOT_ALLOWED: "test environment: recipient not on the allow-list",
  CONFIRMED_IN_CONVERSATION:
    "already confirmed in the patient's WhatsApp conversation",
};
const CANCELLED: Record<string, string> = {
  APPOINTMENT_CANCELLED: "the appointment was cancelled",
  APPOINTMENT_RESCHEDULED: "the appointment was moved",
  APPOINTMENT_CLOSED: "the patient arrived or the visit ended",
  OFFER_CLOSED: "the waitlist offer was answered or lapsed",
};

/** What happened to one message, in words. */
export function deliveryStatus(d: Delivery): string {
  switch (d.status) {
    case "SKIPPED":
      return `Not sent: ${SKIPPED[d.skip_reason ?? ""] ?? label(d.skip_reason ?? "unknown")}`;
    case "CANCELLED":
      return `Withdrawn: ${CANCELLED[d.cancel_reason ?? ""] ?? label(d.cancel_reason ?? "unknown")}`;
    case "FAILED":
      return `Failed after ${d.attempt_count} attempt${d.attempt_count === 1 ? "" : "s"}${d.last_error_code ? ` (${d.last_error_code})` : ""}`;
    case "PENDING":
      return d.attempt_count
        ? `Retrying (${d.attempt_count} attempt${d.attempt_count === 1 ? "" : "s"} so far)`
        : "Waiting to be sent";
    default:
      return label(d.status);
  }
}
const TONE: Record<
  string,
  "booked" | "progress" | "attention" | "exception" | "closed"
> = {
  DELIVERED: "booked",
  READ: "booked",
  SENT: "progress",
  PENDING: "attention",
  PROCESSING: "attention",
  FAILED: "exception",
  SKIPPED: "closed",
  CANCELLED: "closed",
};

/**
 * Every confirmation, reminder and waitlist offer the practice sent or
 * decided not to send, and why. Recipients are masked.
 */
export function Notifications() {
  const practice = usePractice();
  const link = useLink();
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [before, setBefore] = useState<string | null>(null);
  const list = useLoad(
    () =>
      practice.client.get<{ items: Delivery[]; next_before: string | null }>(
        "/notifications",
        {
          status: status || undefined,
          type: type || undefined,
          before: before ?? undefined,
          limit: 100,
        },
      ),
    [status, type, before, practice.tick],
  );
  return (
    <>
      <PageHeader
        title="Notifications"
        context="Messages to patients: what went out, what was held back and why."
      >
        <div className="toolbar">
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => {
              setBefore(null);
              setStatus(e.target.value);
            }}
          >
            <option value="">Any status</option>
            <option value="FAILED">Failed</option>
            <option value="PENDING,PROCESSING">Waiting or retrying</option>
            <option value="SENT,DELIVERED,READ">Sent</option>
            <option value="SKIPPED">Not sent</option>
            <option value="CANCELLED">Withdrawn</option>
          </select>
          <select
            aria-label="Type"
            value={type}
            onChange={(e) => {
              setBefore(null);
              setType(e.target.value);
            }}
          >
            <option value="">Any message</option>
            <option value="APPOINTMENT_CONFIRMATION">Confirmations</option>
            <option value="APPOINTMENT_RESCHEDULED">Moved appointments</option>
            <option value="APPOINTMENT_CANCELLED">Cancellations</option>
            <option value="APPOINTMENT_REMINDER_24H">24-hour reminders</option>
            <option value="APPOINTMENT_REMINDER_NEAR_TERM">
              Near-term reminders
            </option>
            <option value="WAITLIST_OFFER">Waitlist offers</option>
          </select>
        </div>
      </PageHeader>
      <ErrorNote error={list.error} />
      {!list.data && !list.error && <Loading what="notifications" />}
      {list.data && !list.data.items.length && (
        <Empty title="No messages match" />
      )}
      {list.data && list.data.items.length > 0 && (
        <div
          className={`panel table-wrap${list.loading ? " is-refreshing" : ""}`}
        >
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Planned</th>
                <th scope="col">Message</th>
                <th scope="col">To</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((d) => (
                <tr key={d.id}>
                  <td className="num small">
                    {fmt.when(d.scheduled_for, practice.tz)}
                  </td>
                  <td>
                    {label(d.notification_type)}
                    {d.appointment_id && (
                      <>
                        {" "}
                        <a
                          className="small"
                          href={link("appointment", d.appointment_id)}
                        >
                          appointment
                        </a>
                      </>
                    )}
                  </td>
                  <td>
                    {label(d.channel)}{" "}
                    <span className="mono muted small">
                      {d.recipient ?? ""}
                    </span>
                  </td>
                  <td>
                    <Tone tone={TONE[d.status] ?? "closed"}>
                      {label(d.status)}
                    </Tone>
                    <div className="muted small">{deliveryStatus(d)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data?.next_before && (
        <p className="load-more">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setBefore(list.data!.next_before)}
          >
            Older messages
          </button>
        </p>
      )}
    </>
  );
}
