import type { Notifier, OsNotification } from '../notifier';

/** Records what would be handed to the OS. */
export function fakeNotifier(granted = true) {
  const state = { granted, scheduled: [] as OsNotification[], cancelCalls: 0 };
  const notifier: Notifier = {
    async canNotify() {
      return state.granted;
    },
    async cancelAll() {
      state.cancelCalls++;
      state.scheduled = [];
    },
    async schedule(n) {
      state.scheduled.push(n);
      return `os-${n.id}`;
    },
  };
  return { notifier, state };
}
