/** Google's redirect comes back to `/#drive`. True once for that address; the hash is then removed
 *  so that a later reload opens the usual tab. */
export function takeDriveHash(): boolean {
  if (window.location.hash !== '#drive') return false;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}
