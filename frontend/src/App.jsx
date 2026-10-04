import { lazy, Suspense } from 'react';
import { HashRouter, Route, Routes } from 'react-router-dom';
import AppShell from './components/layout/AppShell.jsx';
import { AuthProvider, RequireAuth } from './hooks/auth.jsx';
import { ToastProvider } from './hooks/toast.jsx';
import Home from './pages/Home.jsx';
import { LoginPage, RegisterPage } from './pages/Auth.jsx';
import NotFound from './pages/NotFound.jsx';
import PageSkeleton from './components/ui/PageSkeleton.jsx';

// Pages that pull in three.js are split into their own chunks.
const Projects = lazy(() => import('./pages/Projects.jsx'));
const Project = lazy(() => import('./pages/Project.jsx'));
const TrySample = lazy(() => import('./pages/TrySample.jsx'));

const guarded = (el) => (
  <RequireAuth fallback={<PageSkeleton />}>
    <Suspense fallback={<PageSkeleton />}>{el}</Suspense>
  </RequireAuth>
);

/*
 * HashRouter keeps deep links working on static hosts such as GitHub Pages
 * (e.g. /3dreconstruction/#/projects/<id>) without server-side rewrites.
 */
export default function App() {
  return (
    <HashRouter>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<Home />} />
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="projects" element={guarded(<Projects />)} />
              <Route path="projects/:projectId" element={guarded(<Project />)} />
              <Route path="try/:sample" element={guarded(<TrySample />)} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </HashRouter>
  );
}
