import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/index.js';
import { useToast } from './toast.jsx';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(() => (api.tokens.get() ? 'loading' : 'anonymous'));
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  // Restore the session from a stored token.
  useEffect(() => {
    if (!api.tokens.get()) return undefined;
    const ctrl = new AbortController();
    api.auth
      .me({ signal: ctrl.signal })
      .then((u) => {
        setUser(u);
        setStatus('authenticated');
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        if (err?.status === 401) api.tokens.clear();
        // Network errors: keep the token but treat as signed out for now.
        setStatus('anonymous');
      });
    return () => ctrl.abort();
  }, []);

  // Auto-logout on any 401 from an authenticated call.
  useEffect(
    () =>
      api.onUnauthorized(() => {
        setUser(null);
        setStatus('anonymous');
        toast.info('Signed out', 'Your session expired. Please sign in again.');
        const next = location.pathname + location.search;
        navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
      }),
    [navigate, location, toast],
  );

  const login = useCallback(async (credentials) => {
    const res = await api.auth.login(credentials);
    setUser(res.user);
    setStatus('authenticated');
    return res.user;
  }, []);

  const register = useCallback(async (data) => {
    const res = await api.auth.register(data);
    setUser(res.user);
    setStatus('authenticated');
    return res.user;
  }, []);

  const logout = useCallback(() => {
    api.auth.logout();
    setUser(null);
    setStatus('anonymous');
    navigate('/', { replace: true });
  }, [navigate]);

  const value = useMemo(() => ({ user, status, login, register, logout }), [user, status, login, register, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Route guard: renders children when signed in, a skeleton while checking, else redirects to /login. */
export function RequireAuth({ children, fallback = null }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return fallback;
  if (status !== 'authenticated') {
    const next = location.pathname + location.search;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
}
