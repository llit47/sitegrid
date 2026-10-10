// Run once before rendering: the returned bearer lives only in the page's memory.
export function captureInvitationToken(browser: {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'state' | 'replaceState'>;
}): string {
  const { location, history } = browser;
  if (location.pathname !== '/invitations/accept' || !location.hash) return '';
  const token = location.hash.slice(1);
  history.replaceState(history.state, '', location.pathname + location.search);
  return token;
}
