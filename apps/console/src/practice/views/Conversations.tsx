import React, { useState } from "react";
import { label } from "../../format";
import { PageHeader } from "../../layout/PageHeader";
import { errorCode } from "../api";
import { usePractice } from "../context";
import { useLink, type ViewProps } from "../PracticeApp";
import { fmt } from "../time";
import type { ConversationMessage, ConversationSummary } from "../types";
import {
  Empty,
  ErrorNote,
  Loading,
  PatientPicker,
  Tone,
  useAction,
  useLoad,
} from "../ui";

const REASONS: Record<string, string> = {
  SAFETY_CONCERN: "Possible emergency",
  PATIENT_REQUESTED_STAFF: "Asked for a person",
  NOT_UNDERSTOOD: "Assistant did not understand",
  BOOKING_FAILED: "Assistant could not complete a request",
  IDENTITY_UNCLEAR: "Could not identify the patient",
};
const TABS = [
  ["NEEDS_STAFF", "Needs reception"],
  ["ACTIVE", "With the assistant"],
  ["CLOSED", "Closed"],
] as const;

/**
 * Patient conversations on WhatsApp. The assistant hands a conversation to
 * reception when the patient asks for a person, may have an emergency, or
 * it cannot help; staff reply here (WhatsApp allows free text within 24
 * hours of the patient's last message) and hand it back or close it.
 */
export function Conversations({ route, go }: ViewProps) {
  const practice = usePractice();
  const link = useLink();
  // The tab lives in the route, so opening a conversation keeps it.
  const tab =
    TABS.find(([value]) => value === route.query.get("status"))?.[0] ??
    "NEEDS_STAFF";
  const status = (value: string) => (value === "NEEDS_STAFF" ? null : value);
  const list = useLoad(
    () =>
      practice.client.get<{ items: ConversationSummary[] }>("/conversations", {
        status: tab,
        limit: 100,
      }),
    [tab, practice.tick],
  );
  const selected = route.id;
  return (
    <>
      <PageHeader
        title="Conversations"
        context="WhatsApp conversations the assistant handed to reception, and the rest for reference."
      />
      <div className="segmented" role="tablist" aria-label="Conversations">
        {TABS.map(([value, text]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() =>
              go(link("conversations", selected, { status: status(value) }))
            }
          >
            {text}
          </button>
        ))}
      </div>
      <div className="split">
        <div className="split__list panel">
          <ErrorNote error={list.error} />
          {!list.data && !list.error && <Loading what="conversations" />}
          {list.data && !list.data.items.length && (
            <Empty
              title={
                tab === "NEEDS_STAFF"
                  ? "Nothing waiting for reception"
                  : "No conversations"
              }
            />
          )}
          <ul className="conv-list">
            {(list.data?.items ?? []).map((c) => (
              <li key={c.id}>
                <a
                  href={link("conversations", c.id, { status: status(tab) })}
                  aria-current={c.id === selected ? "true" : undefined}
                >
                  <span className="conv-list__who">
                    {c.patient?.display_name ?? (
                      <span className="mono">{c.participant_address}</span>
                    )}
                  </span>
                  {c.needs_staff_reason && (
                    <Tone
                      tone={
                        c.needs_staff_reason === "SAFETY_CONCERN"
                          ? "exception"
                          : "attention"
                      }
                    >
                      {REASONS[c.needs_staff_reason] ??
                        label(c.needs_staff_reason)}
                    </Tone>
                  )}
                  <span className="muted small">
                    {c.last_inbound_at
                      ? `Last message ${fmt.relative(c.last_inbound_at)}`
                      : "No messages from the patient"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="split__detail">
          {selected ? (
            <Thread
              id={selected}
              onResolved={() =>
                go(link("conversations", null, { status: status(tab) }))
              }
            />
          ) : (
            <Empty title="Choose a conversation" />
          )}
        </div>
      </div>
    </>
  );
}

interface ThreadData {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
}
/** Waiting for a reply to leave: checked this often, for at most this long. */
const SEND_CHECK_MS = 500;
const SEND_WAIT_MS = 6000;

function Thread({ id, onResolved }: { id: string; onResolved: () => void }) {
  const practice = usePractice();
  const link = useLink();
  const fetchThread = () =>
    practice.client.get<ThreadData>(`/conversations/${id}`);
  const thread = useLoad(fetchThread, [id, practice.tick]);
  const [reply, setReply] = useState("");
  const [linking, setLinking] = useState(false);
  const action = useAction();
  if (thread.error && !thread.data) return <ErrorNote error={thread.error} />;
  if (!thread.data) return <Loading what="the conversation" />;
  const { conversation: c, messages } = thread.data;
  const update = (change: {
    status?: "ACTIVE" | "CLOSED";
    patient_id?: string;
  }) =>
    void action.run(async () => {
      const patch = (version: number) =>
        practice.client.send("PATCH", `/conversations/${c.id}`, {
          ...change,
          expected_version: version,
        });
      try {
        try {
          await patch(c.version);
        } catch (e) {
          // Linking only names the patient. If nobody has linked one since
          // the thread loaded, whatever moved the version (a message sent or
          // received) does not bear on it, so it goes onto the current one.
          // Handing back or closing is refused instead, for staff to see
          // what changed first.
          if (change.status || errorCode(e) !== "VERSION_CONFLICT") throw e;
          const current = (await fetchThread()).conversation;
          if (current.patient) throw e;
          await patch(current.version);
        }
      } finally {
        // Also after a conflict: the next attempt then uses the current version.
        await thread.reload();
        practice.changed();
      }
      if (change.status) onResolved();
    });
  /**
   * The worker sends a reply in the background and then records it on the
   * conversation, which moves its version. Until then, handing back,
   * closing or linking would be refused as a conflicting change, so they
   * wait for the send (or give up waiting after a few seconds).
   */
  const sent = async (messageId: string) => {
    for (let waited = 0; waited < SEND_WAIT_MS; waited += SEND_CHECK_MS) {
      await new Promise((r) => setTimeout(r, SEND_CHECK_MS));
      let status: string | undefined;
      try {
        const { messages } = await fetchThread();
        status = messages.find((m) => m.id === messageId)?.status;
      } catch {
        // The reply is already accepted; the reload that follows shows the rest.
        return;
      }
      if (status !== "PENDING" && status !== "SENDING") return;
    }
  };
  return (
    <section className="panel thread">
      <header className="thread__head">
        <div>
          <h2 className="section-title">
            {c.patient ? (
              <a href={link("patient", c.patient.id)}>
                {c.patient.display_name}
              </a>
            ) : (
              "Unidentified patient"
            )}
          </h2>
          <p className="mono muted small">{c.participant_address}</p>
        </div>
        <div className="button-row button-row--compact">
          {!c.patient && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={action.busy}
              onClick={() => setLinking(!linking)}
            >
              Link patient
            </button>
          )}
          {c.status !== "ACTIVE" && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={action.busy}
              onClick={() => update({ status: "ACTIVE" })}
            >
              Hand back to the assistant
            </button>
          )}
          {c.status !== "CLOSED" && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={action.busy}
              onClick={() => update({ status: "CLOSED" })}
            >
              Close conversation
            </button>
          )}
        </div>
      </header>
      {c.needs_staff_reason === "SAFETY_CONCERN" && (
        <p className="alert" role="alert">
          The patient may have an emergency. They were told to call 10177 or
          112. Phone them if you can.
        </p>
      )}
      {linking && (
        <div className="thread__link">
          <p className="small muted">
            Link the conversation to the patient you identified with them. It
            stays with reception until you hand it back or close it.
          </p>
          <PatientPicker
            onPick={(p) => {
              setLinking(false);
              update({ patient_id: p.id });
            }}
          />
        </div>
      )}
      <ol className="thread__messages">
        {messages.map((m) => (
          <li
            key={m.id}
            className={`bubble bubble--${m.direction === "INBOUND" ? "in" : "out"}`}
          >
            <p>
              {m.redacted ? (
                <span className="muted">
                  Removed after the retention period
                </span>
              ) : (
                (m.body ?? (
                  <span className="muted">({label(m.message_type)})</span>
                ))
              )}
            </p>
            <small>
              {fmt.when(m.created_at, practice.tz)}
              {m.direction === "OUTBOUND" &&
                ` · ${m.sent_by?.startsWith("system:") ? "Assistant" : "Reception"} · ${label(m.status)}`}
            </small>
          </li>
        ))}
      </ol>
      {c.within_service_window ? (
        <form
          className="thread__reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            void action.run(async () => {
              const { message_id } = await practice.client.send<{
                message_id: string;
              }>("POST", `/conversations/${c.id}/messages`, {
                body: reply.trim(),
              });
              setReply("");
              // Show it as pending straight away, then as sent.
              await thread.reload();
              await sent(message_id);
              await thread.reload();
              practice.changed();
            });
          }}
        >
          <label className="vh" htmlFor="reply">
            Reply
          </label>
          <textarea
            id="reply"
            value={reply}
            maxLength={4096}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Reply to the patient (administrative only; no clinical advice)"
          />
          <button className="btn" disabled={action.busy || !reply.trim()}>
            Send
          </button>
        </form>
      ) : (
        <p className="note small">
          WhatsApp only allows replies within 24 hours of the patient&rsquo;s
          last message. Phone the patient instead.
        </p>
      )}
      <ErrorNote error={action.error} />
    </section>
  );
}
