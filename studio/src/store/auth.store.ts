import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AuthState {
  serviceRoleKey: string | null;
  isAuthenticated: boolean;
  setServiceRoleKey: (key: string) => void;
  logout: () => void;
}

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
      partialize: (state) => ({ serviceRoleKey: state.serviceRoleKey }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.isAuthenticated = state.serviceRoleKey !== null;
        }
      },
    }
  )
);
