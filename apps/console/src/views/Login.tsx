import React, { useState } from "react";
import { Icon } from "../components/Icon";
import { LoginScene } from "../components/LoginScene";
import { AccessMark } from "../layout/Shell";
import { AUTH_MODE, supabaseClient, useSession, type Me } from "../session";

export function Login() {
  const session = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tenant, setTenant] = useState("11111111-1111-4111-8111-111111111111");
  const [role, setRole] = useState<Me["role"]>("REFERRAL_COORDINATOR");
  const [user, setUser] = useState("coordinator");

  const panel =
    AUTH_MODE === "synthetic" ? (
      <>
        <h2 className="signin__title" id="signin-title">
          Synthetic sign-in
        </h2>
        <p className="signin__warning">
          <Icon name="shield" size={18} />
          <span>
            Synthetic development mode. Tenant and role are asserted by the
            browser and are refused by client-pilot and production deployments.
            Use synthetic data only.
          </span>
        </p>
        <form
          className="signin__form"
          onSubmit={(e) => {
            e.preventDefault();
            session.signInSynthetic({ tenant, role, user });
          }}
        >
          <div className="field">
            <label htmlFor="synthetic-tenant">Organisation (tenant) ID</label>
            <input
              id="synthetic-tenant"
              className="mono"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="synthetic-role">Role</label>
            <select
              id="synthetic-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Me["role"])}
            >
              <option>REFERRAL_COORDINATOR</option>
              <option>PRACTICE_MANAGER</option>
              <option>ADMIN</option>
              <option>READ_ONLY</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="synthetic-user">Staff name (synthetic)</label>
            <input
              id="synthetic-user"
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
          </div>
          <button className="btn btn-lg signin__primary">
            Enter console
            <Icon name="arrowRight" size={18} />
          </button>
        </form>
        {session.error && (
          <p className="alert" role="alert">
            {session.error}
          </p>
        )}
      </>
    ) : (
      <>
        <h2 className="signin__title" id="signin-title">
          Staff sign in
        </h2>
        <form
          className="signin__form"
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
          <button className="btn btn-lg signin__primary" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <div className="signin__or" aria-hidden>
            <span>or</span>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-lg"
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
            Email me a sign-in link
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

  return (
    <div className="login night">
      <LoginScene />
      <header className="login__copy">
        <p className="login__brand">
          <AccessMark size={30} />
          <span className="login__word">ACCESS</span>
          <span className="login__sub">Referral operations</span>
        </p>
        <h1 className="login__headline">
          Every referral, from arrival to booked.
        </h1>
        <p className="login__lede">
          Verify, resolve, commit and follow each referral until it is booked or
          deliberately closed.
        </p>
      </header>
      <main className="login__panel">
        <section className="signin" aria-labelledby="signin-title">
          {panel}
        </section>
        <p className="login__boundary">
          Administrative decisions only. Clinical judgement stays with
          clinicians.
        </p>
      </main>
    </div>
  );
}

function TenantPicker() {
  const session = useSession();
  const [value, setValue] = useState("");
  return (
    <form
      className="tenant-picker"
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
          placeholder="Organisation ID"
        />
      </div>
      <button className="btn btn-secondary">Continue</button>
    </form>
  );
}
