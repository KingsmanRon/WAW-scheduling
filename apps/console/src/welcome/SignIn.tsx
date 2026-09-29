import React, { useEffect, useRef, useState } from "react";
import { roleLabel } from "../format";
import {
  AUTH_MODE,
  supabaseClient,
  useSession,
  type OrgRole,
  type PracticeRole,
} from "../session";

const ORG_ROLES: OrgRole[] = [
  "REFERRAL_COORDINATOR",
  "PRACTICE_MANAGER",
  "ADMIN",
  "READ_ONLY",
];

/**
 * Where to go once signed in: the console route the visitor was sent here
 * from (only a console hash route is accepted), or the console's home.
 */
export function destination(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return next && /^#\/[\w\-/?=&%.]*$/.test(next) ? `/${next}` : "/";
}

/**
 * The front page's closing act: the console's real sign-in. Signing in here
 * sets the same session the console reads (Supabase in production, the
 * synthetic development identity elsewhere), then hands over to the console.
 */
export function SignIn({ focusOnOpen }: { focusOnOpen: () => boolean }) {
  const session = useSession();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (session.me) location.replace(destination(location.search));
  }, [session.me]);
  useEffect(() => {
    if (focusOnOpen()) first.current?.focus({ preventScroll: true });
    const onHash = () => {
      if (location.hash === "#sign-in")
        first.current?.focus({ preventScroll: true });
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, [focusOnOpen]);

  if (session.me)
    return (
      <p className="wp-signin__status" role="status">
        Signed in. Opening your practice…
      </p>
    );
  return AUTH_MODE === "synthetic" ? (
    <SyntheticForm firstRef={first} />
  ) : (
    <SupabaseForm firstRef={first} />
  );
}

function SyntheticForm({
  firstRef,
}: {
  firstRef: React.RefObject<HTMLInputElement | null>;
}) {
  const session = useSession();
  const [tenant, setTenant] = useState("11111111-1111-4111-8111-111111111111");
  const [role, setRole] = useState<OrgRole>("REFERRAL_COORDINATOR");
  const [practiceRole, setPracticeRole] =
    useState<PracticeRole>("RECEPTIONIST");
  const [user, setUser] = useState("reception");
  return (
    <form
      className="wp-signin__form"
      aria-label="Synthetic sign-in"
      onSubmit={(e) => {
        e.preventDefault();
        session.signInSynthetic({ tenant, role, practiceRole, user });
      }}
    >
      <p className="wp-signin__warning">
        Synthetic development sign-in. The browser asserts the organisation and
        role, which client-pilot and production deployments refuse. Use
        synthetic data only.
      </p>
      <div className="field">
        <label htmlFor="synthetic-tenant">Organisation (tenant) ID</label>
        <input
          id="synthetic-tenant"
          ref={firstRef}
          className="mono"
          value={tenant}
          onChange={(e) => setTenant(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="wp-signin__row">
        <div className="field">
          <label htmlFor="synthetic-practice-role">Practice role</label>
          <select
            id="synthetic-practice-role"
            value={practiceRole}
            onChange={(e) => setPracticeRole(e.target.value as PracticeRole)}
          >
            <option value="RECEPTIONIST">Receptionist</option>
            <option value="DOCTOR">Doctor</option>
            <option value="CLINICAL_STAFF">Clinical staff</option>
            <option value="PRACTICE_ADMIN">Practice admin</option>
            <option value="READ_ONLY">Read-only</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="synthetic-role">Organisation role</label>
          <select
            id="synthetic-role"
            value={role}
            onChange={(e) => setRole(e.target.value as OrgRole)}
          >
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="synthetic-user">Staff name (synthetic)</label>
        <input
          id="synthetic-user"
          value={user}
          onChange={(e) => setUser(e.target.value)}
          aria-describedby="synthetic-user-hint"
          autoComplete="off"
        />
        <p className="field-hint" id="synthetic-user-hint">
          Letters, digits, dots and dashes; used as the audit actor.
        </p>
      </div>
      <button className="btn btn-lg wp-signin__primary">Enter console</button>
      {session.error && (
        <p className="alert" role="alert">
          {session.error}
        </p>
      )}
    </form>
  );
}

function SupabaseForm({
  firstRef,
}: {
  firstRef: React.RefObject<HTMLInputElement | null>;
}) {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <>
      <form
        className="wp-signin__form"
        aria-label="Staff sign-in"
        onSubmit={async (e) => {
          e.preventDefault();
          setMessage("");
          setBusy(true);
          try {
            const { error } = await supabaseClient().auth.signInWithPassword({
              email,
              password,
            });
            if (error)
              setMessage("Sign-in failed. Check your email and password.");
            else await session.refresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="signin-email">Work email</label>
          <input
            id="signin-email"
            ref={firstRef}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="signin-password">Password</label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn btn-lg wp-signin__primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy || !email}
          onClick={async () => {
            const { error } = await supabaseClient().auth.signInWithOtp({
              email,
              options: { shouldCreateUser: false },
            });
            setMessage(
              error
                ? "Could not send a sign-in link."
                : "Check your email for a sign-in link.",
            );
          }}
        >
          Email me a sign-in link instead
        </button>
      </form>
      <div aria-live="polite">
        {message && (
          <p className="note" role="status">
            {message}
          </p>
        )}
      </div>
      {session.error === "TENANT_SELECTION_REQUIRED" && <TenantPicker />}
      {session.error && session.error !== "TENANT_SELECTION_REQUIRED" && (
        <p className="alert" role="alert">
          {session.error}
        </p>
      )}
    </>
  );
}

function TenantPicker() {
  const session = useSession();
  const [value, setValue] = useState("");
  return (
    <form
      className="wp-signin__form"
      onSubmit={(e) => {
        e.preventDefault();
        session.selectTenant(value.trim());
      }}
    >
      <p>
        You belong to more than one organisation. Enter the organisation ID to
        work in.
      </p>
      <div className="field">
        <label htmlFor="tenant-choice">Organisation ID</label>
        <input
          id="tenant-choice"
          className="mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <button className="btn btn-secondary">Continue</button>
    </form>
  );
}
