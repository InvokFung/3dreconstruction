import { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MOCK } from '../config.js';
import { useAuth } from '../hooks/auth.jsx';
import Icon from '../components/ui/Icon.jsx';
import styles from './Auth.module.css';

/** Only allow in-app relative redirects. */
function safeNext(next) {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/projects';
  return next;
}

function Field({ label, type = 'text', value, onChange, error, hint, autoComplete, required = true, minLength, children }) {
  const id = useId();
  const [show, setShow] = useState(false);
  const isPassword = type === 'password';
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className={styles.inputWrap}>
        <input
          id={id}
          className="input"
          type={isPassword && show ? 'text' : type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error || hint ? `${id}-desc` : undefined}
        />
        {isPassword && (
          <button
            type="button"
            className={`btn btn--ghost btn--icon btn--sm ${styles.reveal}`}
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide password' : 'Show password'}
            aria-pressed={show}
          >
            <Icon name={show ? 'eyeOff' : 'eye'} />
          </button>
        )}
      </div>
      {(error || hint) && (
        <span id={`${id}-desc`} className={error ? 'field-error' : 'hint'}>
          {error || hint}
        </span>
      )}
      {children}
    </div>
  );
}

function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className={`container ${styles.wrap}`}>
      <section className={`card ${styles.card}`}>
        <span className="eyebrow">WebRecon account</span>
        <h1 className={styles.title}>{title}</h1>
        <p className="muted">{subtitle}</p>
        {children}
        <p className={`small ${styles.switch}`}>{footer}</p>
      </section>
      <aside className={styles.aside} aria-hidden="true">
        <div className={`frame ${styles.asideFrame}`}>
          <svg viewBox="0 0 300 220" className={styles.asideArt}>
            {Array.from({ length: 220 }, (_, i) => {
              const a = (i / 220) * Math.PI * 2 * 7;
              const r = 70 + 18 * Math.sin(i * 0.37) + (i % 5);
              const x = 150 + Math.cos(a) * r * 0.9;
              const y = 112 + Math.sin(a) * r * 0.45 + ((i * 13) % 50) - 25;
              return <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={i % 7 === 0 ? 2 : 1.2} fill={i % 9 === 0 ? 'var(--accent)' : 'currentColor'} />;
            })}
          </svg>
          <ul className={styles.asideList}>
            <li>
              <span className="mono">01</span> Upload 20–80 overlapping photos or a short video
            </li>
            <li>
              <span className="mono">02</span> Pick quality and mode, hit start
            </li>
            <li>
              <span className="mono">03</span> Inspect in 3D, download GLB / OBJ / PLY / USDZ
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}

function useRedirectIfSignedIn(next) {
  const { status } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (status === 'authenticated') navigate(next, { replace: true });
  }, [status, navigate, next]);
}

export function LoginPage() {
  const { login } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState(MOCK ? 'demo@webrecon.dev' : '');
  const [password, setPassword] = useState(MOCK ? 'demo1234' : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useRedirectIfSignedIn(next);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login({ email: email.trim(), password });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to continue to your reconstructions."
      footer={
        <>
          New here? <Link to={`/register?next=${encodeURIComponent(next)}`}>Create an account</Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={submit}>
        {error && (
          <div className="callout callout--danger" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {MOCK && <p className="hint">Demo mode: any email and a password of 4+ characters works.</p>}
        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Sign in
        </button>
      </form>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useRedirectIfSignedIn(next);

  const pwError = password && password.length < 8 ? 'Use at least 8 characters.' : '';

  const submit = async (e) => {
    e.preventDefault();
    if (pwError) return;
    setError('');
    setBusy(true);
    try {
      await register({ name: name.trim(), email: email.trim(), password });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Projects, photos and models are stored on the WebRecon server you’re connected to."
      footer={
        <>
          Already have an account? <Link to={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
        </>
      }
    >
      <form className={styles.form} onSubmit={submit}>
        {error && (
          <div className="callout callout--danger" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}
        <Field label="Name" value={name} onChange={setName} autoComplete="name" />
        <Field label="Email" type="email" value={email} onChange={setEmail} autoComplete="email" />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={8}
          error={pwError}
          hint="At least 8 characters."
        />
        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          Create account
        </button>
      </form>
    </AuthLayout>
  );
}
