import { expect, test } from "./support/test.js";
import {
  Phone,
  closeDb,
  db,
  patientId,
  practicePath,
  signIn,
} from "./support/app.js";
import { PATIENTS, TENANT_ID } from "./support/env.js";

test.afterAll(closeDb);

/**
 * Reception takes over a WhatsApp conversation the assistant handed on.
 * The worker records each staff reply on the conversation once it is sent,
 * which moves the conversation's version; whatever staff do straight after
 * replying must not be refused as a conflicting change.
 */
test("reception replies on WhatsApp, links the patient straight after and closes the conversation", async ({
  page,
}) => {
  const p = PATIENTS.themba;
  const themba = `${p.given} ${p.family}`;
  const phone = Phone.of("themba");
  await phone.send({ text: "Hi" });
  expect((await phone.send({ tap: "M:STAFF" })).text).toMatch(
    /reception team will reply here/,
  );

  await signIn(page, "RECEPTIONIST");
  await page.goto(practicePath("conversations"));
  // Nobody has said who is writing yet: the list shows the number.
  await page.locator(".conv-list a", { hasText: p.mobile }).click();
  const thread = page.locator(".thread");
  await expect(
    thread.getByRole("heading", { name: "Unidentified patient" }),
  ).toBeVisible();

  const received = (await phone.replies()).length;
  const text = "Hello, this is reception. We will phone you at 14:00.";
  await thread.getByLabel("Reply").fill(text);
  await thread.getByRole("button", { name: "Send" }).click();
  // Straight on to linking: it waits for the reply to leave.
  await thread.getByRole("button", { name: "Link patient" }).click();
  await thread.getByLabel("Find a patient").fill(p.mobile);
  await thread.getByRole("button", { name: "Search" }).click();
  await thread.getByRole("button", { name: new RegExp(themba) }).click();
  await expect(thread.getByRole("heading", { name: themba })).toBeVisible();
  await expect(thread.getByRole("alert")).toHaveCount(0);
  expect((await phone.next(received)).text).toBe(text);
  // Linking leaves the conversation with reception.
  await expect(page.locator(".conv-list a", { hasText: themba })).toBeVisible();

  await thread.getByRole("button", { name: "Close conversation" }).click();
  await expect(page.getByText("Choose a conversation")).toBeVisible();

  const conversation = await db().query<{
    id: string;
    status: string;
    patient_id: string;
  }>(
    "SELECT id, status, patient_id FROM messaging.channel_conversations WHERE tenant_id=$1 AND participant_address=$2",
    [TENANT_ID, p.mobile],
  );
  expect(conversation.rows).toEqual([
    {
      id: expect.any(String),
      status: "CLOSED",
      patient_id: await patientId("themba"),
    },
  ]);
  const audit = await db().query<{ action: string; actor_id: string }>(
    `SELECT action, actor_id FROM platform.audit_events
      WHERE tenant_id=$1 AND resource_type='conversation' AND resource_id=$2
        AND action LIKE 'conversation.%' AND actor_type='STAFF'
      ORDER BY occurred_at, id`,
    [TENANT_ID, conversation.rows[0]!.id],
  );
  expect(audit.rows).toEqual([
    { action: "conversation.replied", actor_id: "synthetic:receptionist" },
    {
      action: "conversation.patient_linked",
      actor_id: "synthetic:receptionist",
    },
    { action: "conversation.resolved", actor_id: "synthetic:receptionist" },
  ]);
});
