import { waitForNavigationPaint } from '../../src/platform/rendering';
import { useLayoutEffect } from 'react';
import { Navigate, Outlet, useLocation, useRouteError, type RouteObject } from 'react-router';
import { SiteLayout, LandingPage, DownloadsPage } from './LandingPage';
import { useAppTheme } from '../../src/hooks/useAppTheme';
import { useLocale } from '../../src/hooks/useLocale';
import { t } from '../../src/i18n';
import { WebsiteLink } from '../../src/components/common/WebsiteLink';

function RouteError() {
  useRouteError();
  useLocale();
  return <div className="site-route-error" role="alert"><p>{t('error.unknown')}</p><WebsiteLink className="btn btn-secondary" href="/">P2Sharer</WebsiteLink></div>;
}

function WebLayout() {
  useAppTheme();
  const location = useLocation();
  const app = location.pathname === '/app' || location.pathname.startsWith('/app/');
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('web-app', app);
    document.documentElement.classList.toggle('web-landing', !app);
    if (!app && !location.hash) {
      window.scrollTo(0, 0);
      document.getElementById('content')?.focus({ preventScroll: true });
    }
  }, [app, location.pathname, location.hash]);
  return <Outlet />;
}

export function webRoutes(loadApp = () => import('./AppPage')): RouteObject[] {
  return [{ Component: WebLayout, HydrateFallback: () => null, ErrorBoundary: RouteError, children: [
    { Component: SiteLayout, children: [
      { index: true, Component: LandingPage },
      { path: 'download', Component: DownloadsPage },
      { path: 'downloads', element: <Navigate to="/download" replace /> },
    ] },
    { path: 'app/*', lazy: async () => { await waitForNavigationPaint(); return loadApp(); } },
    { path: '*', element: <Navigate to="/" replace /> },
  ] }];
}
