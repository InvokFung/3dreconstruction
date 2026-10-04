import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { MOCK } from '../../config.js';
import { useAuth } from '../../hooks/auth.jsx';
import Icon from '../ui/Icon.jsx';
import Logo from './Logo.jsx';
import styles from './Layout.module.css';

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials = (user?.name || user?.email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('');

  return (
    <div className={styles.userMenu} ref={ref}>
      <button
        type="button"
        className={styles.avatarBtn}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${user?.name || user?.email}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.avatar}>{initials}</span>
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <div className={styles.menuHead}>
            <strong>{user?.name || 'Account'}</strong>
            <span className="muted small">{user?.email}</span>
          </div>
          <Link role="menuitem" to="/projects" className={styles.menuItem} onClick={() => setOpen(false)}>
            <Icon name="folder" /> Projects
          </Link>
          <button role="menuitem" type="button" className={styles.menuItem} onClick={logout}>
            <Icon name="logout" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Header() {
  const { status } = useAuth();
  return (
    <header className={styles.header}>
      <div className={`container ${styles.headerInner}`}>
        <Link to="/" className={styles.brand} aria-label="WebRecon home">
          <Logo />
        </Link>
        {MOCK && (
          <span className={`badge badge--warn badge--plain ${styles.demo}`} title="Running against the in-browser mock API (VITE_MOCK=1)">
            Demo mode
          </span>
        )}
        <nav className={styles.nav} aria-label="Main">
          <Link to="/" state={{ scrollTo: 'how' }} className={styles.navLink}>
            How it works
          </Link>
          <Link to="/" state={{ scrollTo: 'samples' }} className={styles.navLink}>
            Samples
          </Link>
          {status === 'authenticated' && (
            <NavLink to="/projects" className={styles.navLink}>
              Projects
            </NavLink>
          )}
        </nav>
        <div className={styles.headerActions}>
          {status === 'authenticated' && <UserMenu />}
          {status === 'anonymous' && (
            <>
              <Link to="/login" className="btn btn--ghost btn--sm">
                Sign in
              </Link>
              <Link to="/register" className="btn btn--ink btn--sm">
                Get started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={`container ${styles.footerInner}`}>
        <Logo />
        <p className="muted small">Photos in, textured 3D models out. Open source, self-hostable.</p>
        <span className="spacer" />
        <a className="btn btn--ghost btn--sm" href="https://github.com/InvokFung/3dreconstruction" target="_blank" rel="noreferrer">
          <Icon name="github" /> GitHub
        </a>
      </div>
    </footer>
  );
}

export default function AppShell() {
  const location = useLocation();
  const mainRef = useRef(null);

  // Move focus to the new page's main region on navigation (screen readers announce it).
  useEffect(() => {
    if (!location.state?.scrollTo) window.scrollTo(0, 0);
  }, [location.pathname, location.state]);

  return (
    <div className={styles.shell}>
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        Skip to content
      </a>
      <Header />
      <main id="main" ref={mainRef} tabIndex={-1} className={styles.main}>
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
