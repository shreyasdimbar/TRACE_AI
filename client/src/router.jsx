/**
 * router.jsx — React binding for the route policy in routes.js.
 *
 * The policy ("may this visitor see this path?") lives in routes.js as pure
 * functions so it can be tested without a DOM. This file only supplies the two
 * things that need React: a subscription to location changes, and the redirect
 * that follows a policy decision.
 */

import { useEffect, useState } from 'react';
import { currentPath, navigate, resolveRoute } from './routes';

/**
 * Subscribe to location changes.
 *
 * popstate covers Back/Forward and our own navigate() calls. The pathname is
 * read fresh on every event rather than mirrored into state, so the URL and what
 * is rendered cannot drift apart.
 */
function useLocationPath() {
  const [path, setPath] = useState(() => currentPath());

  useEffect(() => {
    const onChange = () => setPath(currentPath());
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);

  return path;
}

/**
 * Resolve the route to render for the current session.
 *
 * `session` is { status: 'loading' | 'authenticated' | 'anonymous' }.
 *
 * The redirect is performed in an effect rather than during render: navigation
 * mutates history, and doing that mid-render is a side effect React may run
 * twice in StrictMode.
 */
export function useRoute(session) {
  const path = useLocationPath();
  const status = session?.status || 'loading';

  const decision = resolveRoute(path, status);

  useEffect(() => {
    if (decision.shouldRedirect) {
      // replace, not push: the blocked URL should not become a Back-button trap
      // that bounces the user to login again.
      navigate(decision.renderPath, { replace: true });
    }
  }, [decision.shouldRedirect, decision.renderPath]);

  return {
    /** The normalised path currently in the URL. */
    path,
    /** The path actually rendered, after the auth redirect. null while loading. */
    renderPath: decision.renderPath,
    isProtected: decision.path !== '/',
  };
}