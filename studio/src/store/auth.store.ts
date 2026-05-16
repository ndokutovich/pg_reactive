import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface AuthState {
  serviceRoleKey: string | null;
  isAuthenticated: boolean;
  setServiceRoleKey: (key: string) => void;
  logout: () => void;
}

// Service role keys grant admin access. Persist them in sessionStorage so
// they survive a page reload within the same tab, but vanish the moment
// the tab/window closes — and CANNOT leak across origins or browser
// sessions. Any XSS on this origin still steals the key from memory, but
// previously a stolen key from localStorage would survive indefinitely
// even after the user "left" Studio. (Audit finding F3, 2026-05.)
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      serviceRoleKey: null,
      isAuthenticated: false,
      setServiceRoleKey: (key: string) =>
        set({ serviceRoleKey: key, isAuthenticated: true }),
      logout: () =>
        set({ serviceRoleKey: null, isAuthenticated: false }),
    }),
    {
      name: 'pgstack-studio-auth',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ serviceRoleKey: state.serviceRoleKey }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isAuthenticated = state.serviceRoleKey !== null;
        }
      },
    }
  )
);
