/**
 * chatStore.js — conversation history that survives navigation.
 *
 * AskPage used to keep its messages in component state, so every route change
 * unmounted it and the whole conversation was gone. Moving the messages here
 * makes them outlive the component: they persist for as long as the session
 * does, and are dropped on sign-out.
 *
 * sessionStorage rather than localStorage, for two reasons:
 *   - it still survives a reload, so refreshing the page does not silently
 *     destroy the conversation;
 *   - it is scoped to the tab and cleared when it closes, so a shared machine
 *     does not accumulate transcripts indefinitely.
 *
 * The key is scoped to the account. Without that, user A signing out and user B
 * signing in on the same tab would hand B A's conversation — the document
 * store is shared by design, but a chat transcript is not.
 *
 * Storage failures are swallowed throughout: a disabled or full sessionStorage
 * must degrade to "history lasts until the next route change", never to a
 * crashed chat.
 */

const KEY_PREFIX = 'trace_chat:v1:';

/**
 * Cap on persisted messages. The transcript grows without bound and
 * sessionStorage is ~5MB shared with everything else on the origin, so an
 * unbounded append would eventually throw a QuotaExceededError mid-send.
 */
const MAX_MESSAGES = 120;

const trim = (messages) =>
  messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;

function keyFor(userId) {
  return KEY_PREFIX + (userId || 'anonymous');
}

/** Read a stored conversation. Returns [] when absent or unreadable. */
export function loadMessages(userId) {
  try {
    const raw = sessionStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Corrupt JSON or storage unavailable: an empty chat is the right default,
    // and a parse error must never take the Ask page down.
    return [];
  }
}

/** Persist a conversation. No-op when storage is unavailable or over quota. */
export function saveMessages(userId, messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    clearMessages(userId);
    return;
  }
  try {
    sessionStorage.setItem(keyFor(userId), JSON.stringify(trim(messages)));
  } catch {
    // Quota exceeded or storage disabled - history simply will not outlive
    // this render. Not worth interrupting the user over.
  }
}

/** Drop a stored conversation — called on sign-out. */
export function clearMessages(userId) {
  try {
    sessionStorage.removeItem(keyFor(userId));
  } catch {
    // Nothing to do; storage that cannot be written is also storage we do not
    // have to worry about leaking.
  }
}
