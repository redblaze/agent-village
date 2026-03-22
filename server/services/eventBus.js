// Module-level registry — singleton by Node.js module caching
const handlers = new Map();  // Map<string, Function[]>

/**
 * Register a handler for an event type.
 * Multiple calls with the same eventType accumulate handlers.
 * @param {string} eventType
 * @param {(target: any, payload: object) => void|Promise<void>} handler
 */
export function respondTo(eventType, handler) {
  if (!handlers.has(eventType)) {
    handlers.set(eventType, []);
  }
  handlers.get(eventType).push(handler);
}

/**
 * Fire an event. Returns synchronously — handlers are launched into the background.
 * Each handler runs independently; errors are logged per handler and never propagate.
 * All handlers registered at the moment of the call are executed; handlers
 * registered during execution are deferred to the next trigger call.
 * @param {string} eventType
 * @param {any} target
 * @param {object} payload
 */
export function trigger(eventType, target, payload) {
  // Snapshot before iterating — prevents a handler that calls respondTo() on the
  // same eventType from having its newly registered handler fire in this pass.
  const list = [...(handlers.get(eventType) ?? [])];
  for (const handler of list) {
    // new Promise() constructor wraps the call in an implicit try/catch, so
    // synchronous throws from handler() are converted to rejections — unlike
    // Promise.resolve(handler()) which evaluates handler() before wrapping.
    new Promise(resolve => resolve(handler(target, payload))).catch(err => {
      console.error(`[eventBus] handler for "${eventType}" failed:`, err);
    });
  }
  // Returns immediately — handlers continue in the background
}
