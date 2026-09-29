import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { DeliveryFailure } from "./errors.js";

/**
 * E-mail notifications over SMTP (any provider: Postmark, SES, Mailgun,
 * Microsoft 365 ...). Configured once for the platform:
 *
 *   SMTP_URL   smtps://user:password@host:465 or smtp://user:password@host:587
 *   SMTP_FROM  "Practice Notifications <no-reply@example.com>"
 *
 * Plain text only; nothing is fetched from files or URLs.
 */
export interface SmtpConfig {
  url: string;
  from: string;
  /** Refuse to send without TLS (smtps, or STARTTLS on smtp). */
  requireTls: boolean;
  timeoutMs: number;
}
export interface SentEmail {
  messageId: string;
}

export class SmtpSender {
  private readonly transport: Transporter<SMTPTransport.SentMessageInfo>;
  constructor(private readonly config: SmtpConfig) {
    const u = new URL(config.url);
    if (u.protocol !== "smtp:" && u.protocol !== "smtps:")
      throw new Error("SMTP_URL must use smtp:// or smtps://");
    const secure = u.protocol === "smtps:";
    this.transport = nodemailer.createTransport({
      host: u.hostname,
      port: Number(u.port || (secure ? 465 : 587)),
      secure,
      requireTLS: !secure && config.requireTls,
      ignoreTLS:
        !secure && !config.requireTls && u.searchParams.get("tls") === "off",
      ...(u.username
        ? {
            auth: {
              user: decodeURIComponent(u.username),
              pass: decodeURIComponent(u.password),
            },
          }
        : {}),
      connectionTimeout: config.timeoutMs,
      greetingTimeout: config.timeoutMs,
      socketTimeout: config.timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: { minVersion: "TLSv1.2" },
    });
  }

  async send(input: {
    to: string;
    subject: string;
    text: string;
    /** Our delivery id, carried in a header for support tracing. */
    reference: string;
  }): Promise<SentEmail> {
    try {
      const info = await this.transport.sendMail({
        from: this.config.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        headers: { "X-Access-Delivery": input.reference },
      });
      if (info.rejected?.length)
        throw new DeliveryFailure("PERMANENT", "RECIPIENT_REJECTED");
      const id = String(info.messageId ?? "").replace(/^<|>$/g, "");
      if (!id) throw new DeliveryFailure("AMBIGUOUS", "NO_MESSAGE_ID");
      return { messageId: id.slice(0, 200) };
    } catch (e) {
      throw classifySmtpError(e);
    }
  }

  close(): void {
    this.transport.close();
  }
}

export function classifySmtpError(e: unknown): DeliveryFailure {
  if (e instanceof DeliveryFailure) return e;
  const err = e as {
    code?: string;
    responseCode?: number;
    command?: string;
    response?: string;
  };
  const code = err.code ?? "SMTP_ERROR";
  const reply = typeof err.responseCode === "number" ? err.responseCode : null;
  if (code === "EAUTH" || reply === 530 || reply === 534 || reply === 535)
    return new DeliveryFailure("CONFIGURATION", "SMTP_AUTH");
  if (code === "EENVELOPE")
    return new DeliveryFailure(
      "PERMANENT",
      "SMTP_ENVELOPE",
      err.response ?? null,
    );
  if (reply !== null && reply >= 500)
    return new DeliveryFailure(
      "PERMANENT",
      `SMTP_${reply}`,
      err.response ?? null,
    );
  if (reply !== null && reply >= 400)
    return new DeliveryFailure(
      "TRANSIENT",
      `SMTP_${reply}`,
      err.response ?? null,
    );
  // A failure while the message body was being transferred may still have
  // been accepted by the server.
  if (err.command === "DATA" || err.command === "dotting")
    return new DeliveryFailure("AMBIGUOUS", `SMTP_${code}`);
  return new DeliveryFailure("TRANSIENT", `SMTP_${code}`);
}
