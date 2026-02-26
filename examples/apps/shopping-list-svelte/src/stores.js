import { writable, derived } from 'svelte/store';

export const accessToken = writable(null);
export const currentUser = writable(null);
export const currentScreen = writable('setup');
export const lists = writable([]);
export const currentList = writable(null);
export const items = writable([]);
export const toasts = writable([]);

// Derived stores for progress on the detail screen
export const uncheckedItems = derived(items, $items =>
  $items.filter(i => !i.checked)
);

export const checkedItems = derived(items, $items =>
  $items.filter(i => i.checked)
);

export const progressPct = derived(items, $items => {
  const total = $items.length;
  if (total === 0) return 0;
  const done = $items.filter(i => i.checked).length;
  return Math.round(done / total * 100);
});

export const progressText = derived(items, $items => {
  const total = $items.length;
  const done = $items.filter(i => i.checked).length;
  return done + ' / ' + total;
});

// Toast helper
let toastId = 0;
export function addToast(msg, type = 'info') {
  const id = ++toastId;
  toasts.update(t => [...t, { id, msg, type }]);
  setTimeout(() => {
    toasts.update(t => t.filter(toast => toast.id !== id));
  }, 3200);
}
